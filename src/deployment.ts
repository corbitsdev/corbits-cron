// Where a schedule's mail actually goes. A schedule names an agent by its
// workflow definition's name; the live run behind that name changes on every
// restart or redeploy, so it is resolved at fire time, never stored.
import {
  liveWorkflowRunStatuses,
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
