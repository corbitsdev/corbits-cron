// Turns due cron schedules into mail. A schedule that missed several ticks
// fires once for the most recent due minute, never once per missed tick.
import { and, eq, isNull } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import { cronIsDue, parseCronExpression, parsedCronCanFire } from "./cron.js";
import {
  definitionExists,
  failStaleAnchorRun,
  isUnroutableRunTrigger,
  resolveLiveDeployment,
} from "./deployment.js";
import { cronScheduleTable } from "./schema.js";

export type CronDb<
  TSchema extends Record<string, unknown> = Record<string, unknown>,
> = PostgresJsDatabase<TSchema>;

/** A due schedule handed to the host. The sender identity is the host's to
 * decide: only the host knows which addresses its mail transport
 * authorizes, so this package names the tenant and never invents an
 * address for it. */
export type DeliverCronMail = (message: {
  to: string[];
  subject: string;
  body: string;
  tenantId: string;
}) => Promise<void> | void;

export type CreateCronTickerOpts<
  TSchema extends Record<string, unknown> = Record<string, unknown>,
> = {
  db: CronDb<TSchema>;
  deliver: DeliverCronMail;
  /** Defaults to one minute, cron's resolution. */
  intervalMs?: number;
  /** Told about a delivery that failed, so the host can report it. */
  onDeliveryError?: (
    error: unknown,
    schedule: { id: string; tenantId: string },
  ) => void;
  /** Told about a tick that failed before delivering, such as a lost DB
   * connection. The next tick retries. */
  onTickError?: (error: unknown) => void;
  /** Told once when a schedule stops: `agent_deleted` when the agent it
   * targets was deleted (a later redeploy does not resume it), or
   * `invalid_expression` when its expression can never fire. */
  onScheduleStopped?: (schedule: {
    id: string;
    tenantId: string;
    definitionName: string;
    reason: string;
  }) => void;
  /** Told once each time a schedule starts waiting for its agent's next
   * run, not on every tick it spends waiting. */
  onScheduleWaiting?: (schedule: {
    id: string;
    tenantId: string;
    definitionName: string;
  }) => void;
};

export type CronTicker = {
  start(): void;
  stop(): void;
};

type Due = "due" | "idle" | "invalid";

/** A freshly saved schedule is due at its first matching minute after
 * creation, not retroactively for every minute since the epoch. A row that
 * can never fire (saved before the create route checked, or over today's
 * caps) is "invalid" and stopped rather than re-scanned every tick. */
function dueness(
  row: { expression: string; lastFiredAt: Date | null; createdAt: Date },
  now: Date,
): Due {
  const cron = parseCronExpression(row.expression);
  if (cron === undefined || !parsedCronCanFire(cron)) return "invalid";
  return cronIsDue(cron, row.lastFiredAt ?? row.createdAt, now)
    ? "due"
    : "idle";
}

const AGENT_DELETED = "agent_deleted";
const INVALID_EXPRESSION = "invalid_expression";
const DEFAULT_INTERVAL_MS = 60_000;

async function tick<TSchema extends Record<string, unknown>>(
  db: CronDb<TSchema>,
  deliver: DeliverCronMail,
  onDeliveryError: (
    error: unknown,
    schedule: { id: string; tenantId: string },
  ) => void,
  onScheduleStopped: (schedule: {
    id: string;
    tenantId: string;
    definitionName: string;
    reason: string;
  }) => void,
  onScheduleWaiting: (schedule: {
    id: string;
    tenantId: string;
    definitionName: string;
  }) => void,
) {
  const now = new Date();
  const stopped: Parameters<typeof onScheduleStopped>[0][] = [];
  const waiting: Parameters<typeof onScheduleWaiting>[0][] = [];
  const claimed: Array<{
    row: typeof cronScheduleTable.$inferSelect;
    address: string;
  }> = [];

  // Claim, then deliver. One short transaction locks every row (SKIP LOCKED
  // means concurrent tickers split the due rows rather than double-fire
  // any of them), decides which are due, and advances lastFiredAt on each
  // it will deliver. Delivery runs after that commits and outside the
  // lock, so a slow deliverer blocks no replica and a tick that dies
  // mid-batch never re-fires what it claimed: at most once per due minute.
  await db.transaction(async (tx) => {
    const candidates = await tx
      .select()
      .from(cronScheduleTable)
      .where(
        and(
          isNull(cronScheduleTable.stoppedAt),
          eq(cronScheduleTable.enabled, true),
        ),
      )
      .for("update", { skipLocked: true });

    for (const row of candidates) {
      const due = dueness(row, now);
      if (due === "idle") continue;
      const schedule = {
        id: row.id,
        tenantId: row.tenantId,
        definitionName: row.definitionName,
      };
      if (due === "invalid") {
        await tx
          .update(cronScheduleTable)
          .set({ stoppedAt: now, stoppedReason: INVALID_EXPRESSION })
          .where(eq(cronScheduleTable.id, row.id));
        stopped.push({
          id: row.id,
          tenantId: row.tenantId,
          definitionName: row.definitionName,
          reason: INVALID_EXPRESSION,
        });
        continue;
      }
      // The run behind a target dies on every restart and redeploy, so the
      // address is resolved now rather than stored.
      const deployment = await resolveLiveDeployment(
        tx,
        row.tenantId,
        row.definitionName,
      );
      if (deployment === null) {
        // A restart leaves the agent's definition and drops its run: wait for
        // the run to come back rather than killing the schedule over a gap.
        if (await definitionExists(tx, row.tenantId, row.definitionName)) {
          if (row.waitingSince === null) {
            await tx
              .update(cronScheduleTable)
              .set({ waitingSince: now })
              .where(eq(cronScheduleTable.id, row.id));
            waiting.push(schedule);
          }
          continue;
        }
        await tx
          .update(cronScheduleTable)
          .set({ stoppedAt: now, stoppedReason: AGENT_DELETED })
          .where(eq(cronScheduleTable.id, row.id));
        stopped.push({
          id: row.id,
          tenantId: row.tenantId,
          definitionName: row.definitionName,
          reason: AGENT_DELETED,
        });
        continue;
      }
      await tx
        .update(cronScheduleTable)
        .set({ lastFiredAt: now, waitingSince: null })
        .where(eq(cronScheduleTable.id, row.id));
      claimed.push({ row, address: deployment.address });
    }
  });

  for (const schedule of stopped) onScheduleStopped(schedule);
  for (const schedule of waiting) onScheduleWaiting(schedule);

  // One schedule's failed delivery is its own: the rest of the batch still
  // delivers, and a permanently undeliverable schedule fires once per due
  // minute, not every tick.
  for (const { row, address } of claimed) {
    try {
      await deliver({
        to: [address],
        subject: row.subject,
        body: row.body,
        tenantId: row.tenantId,
      });
    } catch (error) {
      // The deliverer names the dead run it could not route to. When that
      // run's sidecar can never come back (its allocation already settled),
      // fail the stale anchor now: the next tick then sees no live
      // deployment and waits for the agent to come back instead of
      // delivering into the dead run every minute. The error is still
      // reported — it is a real delivery failure, once, not tick noise.
      if (isUnroutableRunTrigger(error)) {
        await failStaleAnchorRun(db, error.runId, now);
      }
      onDeliveryError(error, { id: row.id, tenantId: row.tenantId });
    }
  }
}

/** Ticks every `intervalMs`, delivering each due schedule as mail. */
export function createCronTicker<TSchema extends Record<string, unknown>>(
  opts: CreateCronTickerOpts<TSchema>,
): CronTicker {
  const onDeliveryError = opts.onDeliveryError ?? (() => undefined);
  const onScheduleStopped = opts.onScheduleStopped ?? (() => undefined);
  const onScheduleWaiting = opts.onScheduleWaiting ?? (() => undefined);
  const onTickError = opts.onTickError ?? (() => undefined);
  const reportTickError = (error: unknown) => {
    try {
      onTickError(error);
    } catch {
      // report-error-ignore: a throwing host reporter must not turn the
      // tick's failure into an unhandled rejection; the next tick retries.
    }
  };
  let timer: ReturnType<typeof setInterval> | undefined;
  let inFlight: Promise<void> | undefined;

  const runTick = () => {
    if (inFlight !== undefined) return;
    inFlight = tick(
      opts.db,
      opts.deliver,
      onDeliveryError,
      onScheduleStopped,
      onScheduleWaiting,
    )
      .catch(reportTickError)
      .finally(() => {
        inFlight = undefined;
      });
  };

  return {
    start() {
      if (timer !== undefined) return;
      timer = setInterval(runTick, opts.intervalMs ?? DEFAULT_INTERVAL_MS);
    },
    stop() {
      if (timer === undefined) return;
      clearInterval(timer);
      timer = undefined;
    },
  };
}
