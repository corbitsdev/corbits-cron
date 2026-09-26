// Turns due cron schedules into mail. A schedule that missed several ticks
// fires once for the most recent due minute, never once per missed tick.
import { eq, isNull } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import { nextCronFireAfter } from "./cron.js";
import { definitionExists, failStaleAnchorRun, isUnroutableRunTrigger, resolveLiveDeployment } from "./deployment.js";
import { cronScheduleTable } from "./schema.js";

export type CronDb<TSchema extends Record<string, unknown> = Record<string, unknown>> =
  PostgresJsDatabase<TSchema>;

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
  onDeliveryError?: (error: unknown, schedule: { id: string; tenantId: string }) => void;
  /** Told about a tick that failed before delivering, such as a lost DB
   * connection. The next tick retries. */
  onTickError?: (error: unknown) => void;
  /** Told once when a schedule stops because the agent it targets was
   * deleted. A later redeploy does not resume it. */
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

/** A freshly saved schedule is due at its first matching minute after
 * creation, not retroactively for every minute since the epoch. */
function isDue(
  row: { expression: string; lastFiredAt: Date | null; createdAt: Date },
  now: Date,
): boolean {
  const after = row.lastFiredAt ?? row.createdAt;
  try {
    return nextCronFireAfter(row.expression, after) <= now;
  } catch {
    // report-error-ignore: an expression with no fire in the lookahead
    // window is simply never due, not an operational failure.
    return false;
  }
}

const AGENT_DELETED = "agent_deleted";
const DEFAULT_INTERVAL_MS = 60_000;

async function tick<TSchema extends Record<string, unknown>>(
  db: CronDb<TSchema>,
  deliver: DeliverCronMail,
  onDeliveryError: (error: unknown, schedule: { id: string; tenantId: string }) => void,
  onScheduleStopped: (schedule: {
    id: string;
    tenantId: string;
    definitionName: string;
    reason: string;
  }) => void,
  onScheduleWaiting: (schedule: { id: string; tenantId: string; definitionName: string }) => void,
) {
  await db.transaction(async (tx) => {
    const now = new Date();
    // Every row, locked against a concurrent ticker (SKIP LOCKED means two
    // tickers racing this table split the due rows rather than double-fire
    // any of them); which ones are actually due is a JS-side check because
    // "due" depends on parsing each row's own cron expression.
    const candidates = await tx
      .select()
      .from(cronScheduleTable)
      .where(isNull(cronScheduleTable.stoppedAt))
      .for("update", { skipLocked: true });

    for (const row of candidates.filter((row) => isDue(row, now))) {
      // The run behind a target dies on every restart and redeploy, so the
      // address is resolved now rather than stored.
      const deployment = await resolveLiveDeployment(tx, row.tenantId, row.definitionName);
      if (deployment === null) {
        // A restart leaves the agent's definition and drops its run: wait for
        // the run to come back rather than killing the schedule over a gap.
        if (await definitionExists(tx, row.tenantId, row.definitionName)) {
          if (row.waitingSince === null) {
            await tx
              .update(cronScheduleTable)
              .set({ waitingSince: now })
              .where(eq(cronScheduleTable.id, row.id));
            onScheduleWaiting({
              id: row.id,
              tenantId: row.tenantId,
              definitionName: row.definitionName,
            });
          }
          continue;
        }
        await tx
          .update(cronScheduleTable)
          .set({ stoppedAt: now, stoppedReason: AGENT_DELETED })
          .where(eq(cronScheduleTable.id, row.id));
        onScheduleStopped({
          id: row.id,
          tenantId: row.tenantId,
          definitionName: row.definitionName,
          reason: AGENT_DELETED,
        });
        continue;
      }
      // One schedule's failed delivery is its own: the tick still advances
      // every due row, so a permanently undeliverable schedule cannot block
      // the rest of the table or re-fire every minute forever.
      try {
        await deliver({
          to: [deployment.address],
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
          await failStaleAnchorRun(tx, error.runId, now);
        }
        onDeliveryError(error, { id: row.id, tenantId: row.tenantId });
      }
      await tx
        .update(cronScheduleTable)
        .set({ lastFiredAt: now, waitingSince: null })
        .where(eq(cronScheduleTable.id, row.id));
    }
  });
}

/** Ticks every `intervalMs`, delivering each due schedule as mail. */
export function createCronTicker<TSchema extends Record<string, unknown>>(
  opts: CreateCronTickerOpts<TSchema>,
): CronTicker {
  const onDeliveryError = opts.onDeliveryError ?? (() => undefined);
  const onScheduleStopped = opts.onScheduleStopped ?? (() => undefined);
  const onScheduleWaiting = opts.onScheduleWaiting ?? (() => undefined);
  const onTickError = opts.onTickError ?? (() => undefined);
  let timer: ReturnType<typeof setInterval> | undefined;
  let inFlight: Promise<void> | undefined;

  const runTick = () => {
    if (inFlight !== undefined) return;
    inFlight = tick(opts.db, opts.deliver, onDeliveryError, onScheduleStopped, onScheduleWaiting)
      .catch(onTickError)
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
