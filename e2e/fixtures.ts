// Seeding shared by the DB tests: the rows the hub itself writes.
import { randomUUID } from "node:crypto";
import { schema } from "@intx/db";
import { and, eq } from "drizzle-orm";

import type { TestDb } from "./helpers.js";

export function tenantDomainFor(id: string): string {
  return `${id.replace(/_/g, "-")}.workbench.test`;
}

export async function seedTenant(db: TestDb, id: string): Promise<void> {
  await db.insert(schema.tenant).values({
    id,
    name: id,
    slug: id.replace(/_/g, "-"),
    domain: tenantDomainFor(id),
  });
}

/** A definition plus its anchor run — what the hub writes for one deploy.
 * The anchor run's id is the deployment id, so it self-references through
 * `anchorRunId`. */
export async function seedDeployment(
  db: TestDb,
  tenantId: string,
  definitionName: string,
  status: "deployed" | "running" | "completed" = "deployed",
): Promise<string> {
  const definitionId = `wfd_${randomUUID().slice(0, 8)}`;
  await db
    .insert(schema.workflowDefinition)
    .values({ id: definitionId, tenantId, name: definitionName });
  const runId = `run_${randomUUID().slice(0, 8)}`;
  await db
    .insert(schema.workflowRun)
    .values({ id: runId, definitionId, anchorRunId: runId, tenantId, status });
  return runId;
}

/** A second anchor run for a definition that already exists — the agent
 * coming back after a restart. */
export async function seedLiveRun(
  db: TestDb,
  tenantId: string,
  definitionName: string,
): Promise<string> {
  const [definition] = await db
    .select({ id: schema.workflowDefinition.id })
    .from(schema.workflowDefinition)
    .where(
      and(
        eq(schema.workflowDefinition.tenantId, tenantId),
        eq(schema.workflowDefinition.name, definitionName),
      ),
    )
    .limit(1);
  if (definition === undefined)
    throw new Error(`no definition named ${definitionName}`);
  const runId = `run_${randomUUID().slice(0, 8)}`;
  await db.insert(schema.workflowRun).values({
    id: runId,
    definitionId: definition.id,
    anchorRunId: runId,
    tenantId,
    status: "deployed",
  });
  return runId;
}

/** A sidecar allocation for an anchor run — the provisioner-side record of
 * whether that run's sidecar can ever serve its address again. */
export async function seedAllocation(
  db: TestDb,
  anchorRunId: string,
  tenantId: string,
  status: "released" | "failed" | "allocated" = "released",
): Promise<void> {
  await db.insert(schema.sidecarAllocation).values({
    id: `sca_${randomUUID().slice(0, 8)}`,
    anchorRunId,
    tenantId,
    provisionerId: "prov_test",
    provisionerApiVersion: 1,
    provisionerBindingFingerprint: "fp_test",
    status,
  });
}

/** Deletes the agent itself: its runs, then its definition. */
export async function deleteDefinition(
  db: TestDb,
  tenantId: string,
  definitionName: string,
): Promise<void> {
  const rows = await db
    .select({ id: schema.workflowDefinition.id })
    .from(schema.workflowDefinition)
    .where(
      and(
        eq(schema.workflowDefinition.tenantId, tenantId),
        eq(schema.workflowDefinition.name, definitionName),
      ),
    );
  for (const row of rows) {
    await db
      .delete(schema.workflowRun)
      .where(eq(schema.workflowRun.definitionId, row.id));
    await db
      .delete(schema.workflowDefinition)
      .where(eq(schema.workflowDefinition.id, row.id));
  }
}
