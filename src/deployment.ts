// Where a schedule's mail actually goes. A schedule names an agent by its
// workflow definition's name; the live run behind that name changes on every
// restart or redeploy, so it is resolved at fire time, never stored.
import {
  liveWorkflowRunStatuses,
  sidecarAllocation,
  tenant,
  workflowDefinition,
  workflowRun,
} from "@intx/db/schema";
import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

export type LiveDeployment = {
  /** The anchor run's id — the deployment id, and the mail local part. */
  runId: string;
  address: string;
};

/** The tenant's current live deployment for `definitionName`, as the hub
 * lists deployments: the anchor run (`id = anchor_run_id`) of a definition
 * with that name, newest first. `null` when the agent has none. */
export async function resolveLiveDeployment<TSchema extends Record<string, unknown>>(
  db: PostgresJsDatabase<TSchema>,
  tenantId: string,
  definitionName: string,
): Promise<LiveDeployment | null> {
  const [row] = await db
    .select({ runId: workflowRun.id, domain: tenant.domain })
    .from(workflowRun)
    .innerJoin(workflowDefinition, eq(workflowRun.definitionId, workflowDefinition.id))
    .innerJoin(tenant, eq(workflowRun.tenantId, tenant.id))
    .where(
      and(
        eq(workflowRun.tenantId, tenantId),
        eq(workflowDefinition.name, definitionName),
        isNotNull(workflowRun.anchorRunId),
        eq(workflowRun.id, workflowRun.anchorRunId),
        inArray(workflowRun.status, [...liveWorkflowRunStatuses]),
      ),
    )
    .orderBy(desc(workflowRun.createdAt))
    .limit(1);
  if (row === undefined) return null;
  return { runId: row.runId, address: `${row.runId}@${row.domain}` };
}

/** Whether the tenant still has a workflow definition with this name, live
 * run or not. A hub restart leaves the definition and drops its run, so this
 * is what separates "waiting for the agent to come back" from "deleted". */
export async function definitionExists<TSchema extends Record<string, unknown>>(
  db: PostgresJsDatabase<TSchema>,
  tenantId: string,
  definitionName: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: workflowDefinition.id })
    .from(workflowDefinition)
    .where(
      and(eq(workflowDefinition.tenantId, tenantId), eq(workflowDefinition.name, definitionName)),
    )
    .limit(1);
  return row !== undefined;
}

/**
 * `code` values the run-trigger deliverer rejects with when the deployment
 * address has no live socket and no disconnect queue. Contract owned by
 * `@corbits/webhooks` (`src/deliver.ts`): matched structurally here so this
 * package stays dependency-free and speaks to the deliverer through the
 * `MailDeliverer` shape alone.
 */
export const RUN_GRANTS_NOT_ROUTABLE = "run_grants_not_routable";
export const RUN_MAIL_NOT_ROUTABLE = "run_mail_not_routable";

export type UnroutableRunTrigger = {
  code: typeof RUN_GRANTS_NOT_ROUTABLE | typeof RUN_MAIL_NOT_ROUTABLE;
  address: string;
  runId: string;
};

/** Structural match for the deliverer's unroutable-trigger rejection. */
export function isUnroutableRunTrigger(error: unknown): error is UnroutableRunTrigger {
  if (typeof error !== "object" || error === null) return false;
  const rec = error as Record<string, unknown>;
  return (
    (rec["code"] === RUN_GRANTS_NOT_ROUTABLE || rec["code"] === RUN_MAIL_NOT_ROUTABLE) &&
    typeof rec["address"] === "string" &&
    typeof rec["runId"] === "string"
  );
}

/**
 * Fail a stale live anchor run whose sidecar can never come back: its
 * allocation already settled `released` or `failed`, so no provisioner will
 * ever serve that address again. A previous stack's death leaves exactly this
 * behind — a `running` anchor row with a dead sidecar — and the row keeps
 * receiving deliveries into the dead run until something marks it terminal
 * (previously only the web client did). Returns true when this call flipped
 * the row; false when the allocation is still active, missing, or the row is
 * already terminal.
 */
export async function failStaleAnchorRun<TSchema extends Record<string, unknown>>(
  db: PostgresJsDatabase<TSchema>,
  runId: string,
  now: Date = new Date(),
): Promise<boolean> {
  const [allocation] = await db
    .select({ status: sidecarAllocation.status })
    .from(sidecarAllocation)
    .where(eq(sidecarAllocation.anchorRunId, runId))
    .limit(1);
  if (allocation === undefined) return false;
  if (allocation.status !== "released" && allocation.status !== "failed") return false;
  const updated = await db
    .update(workflowRun)
    .set({ status: "failed", endedAt: now })
    .where(and(eq(workflowRun.id, runId), inArray(workflowRun.status, [...liveWorkflowRunStatuses])))
    .returning({ id: workflowRun.id });
  return updated.length > 0;
}
