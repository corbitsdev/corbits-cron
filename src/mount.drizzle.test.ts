// DB-gated: create validates its target against the workflow definitions the
// hub itself writes, so it needs a real database.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createDB, dropSchema, runMigrations } from "@intx/db";
import { Hono } from "hono";

import { mountCron } from "./mount";
import { applyCronMigrations } from "./schema";
import { dbTargetFromUrl, seedDeployment, seedTenant } from "./test-seed";

const databaseUrl = process.env.DATABASE_URL;
const describeIfDb = databaseUrl === undefined ? describe.skip : describe;

const SCHEMA = "cron_mount_test";

describeIfDb("mountCron", () => {
  const target = dbTargetFromUrl(databaseUrl ?? "postgres://localhost:5432/unused");

  beforeAll(async () => {
    await runMigrations(target, { schema: SCHEMA });
    await applyCronMigrations(databaseUrl ?? "", { tenantSchema: SCHEMA });
  });

  afterAll(async () => {
    await dropSchema(target, { schema: SCHEMA });
  });

  async function post(app: Hono, tenantId: string, body: unknown): Promise<Response> {
    return app.request(`/api/tenants/${tenantId}/cron`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  test("a known agent is saved even with no live run; an unknown name is rejected", async () => {
    const { db, close } = createDB({ ...target, schema: SCHEMA });
    try {
      const tenantId = `tnt_cron_mnt_${randomUUID().slice(0, 8)}`;
      await seedTenant(db, tenantId);
      await seedDeployment(db, tenantId, "agent-live-source", "completed");

      const app = new Hono();
      mountCron(app, { db, requireTenantMember: () => true });

      const created = await post(app, tenantId, {
        expression: "0 9 * * *",
        definitionName: "agent-live-source",
        subject: "Scheduled run",
        body: "go",
      });
      expect(created.status).toBe(201);
      const createdBody = (await created.json()) as { schedule: { definitionName: string } };
      expect(createdBody.schedule.definitionName).toBe("agent-live-source");

      const rejected = await post(app, tenantId, {
        expression: "0 9 * * *",
        definitionName: "agent-never-deployed-source",
        subject: "Scheduled run",
        body: "go",
      });
      expect(rejected.status).toBe(400);
      expect(await rejected.json()).toEqual({ error: "unknown_definition" });
    } finally {
      await close();
    }
  });
});
