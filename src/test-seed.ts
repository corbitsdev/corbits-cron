// Seeding shared by this package's DB-gated tests. Not exported from the
// package index: test-only.
import { randomUUID } from "node:crypto";
import { createDB, schema } from "@intx/db";

type TestDb = ReturnType<typeof createDB>["db"];

export function dbTargetFromUrl(url: string) {
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : 5432,
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database: parsed.pathname.replace(/^\//, ""),
  };
}

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
  status: "deployed" | "completed" = "deployed",
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
