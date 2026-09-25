// Create validates its target against the workflow definitions the hub
// itself writes, so it needs a real database.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createDB } from "@intx/db";
import type { RequireGrant, TenantEnv } from "@intx/hub-api";
import type { Hono } from "hono";

import {
  createTestDatabase,
  cronRoutesApp,
  describeIfDb,
  type TestDatabase,
} from "./lib/db-harness.js";
import { seedDeployment, seedTenant } from "./lib/seed.js";

describeIfDb("createCronRoutes", () => {
  let database: TestDatabase | undefined;

  beforeAll(async () => {
    database = await createTestDatabase();
  });

  function requireDatabase(): TestDatabase {
    if (database === undefined) throw new Error("test database was not created");
    return database;
  }

  afterAll(async () => {
    await database?.drop();
  });

  const allowAll: RequireGrant = () => async (_c, next) => {
    await next();
  };

  async function post(app: Hono<TenantEnv>, body: unknown): Promise<Response> {
    return app.request("/cron", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  test("a known agent is saved even with no live run; an unknown name is rejected", async () => {
    const { db, close } = createDB(requireDatabase().config);
    try {
      const tenantId = `tnt_cron_mnt_${randomUUID().slice(0, 8)}`;
      await seedTenant(db, tenantId);
      await seedDeployment(db, tenantId, "agent-live-source", "completed");

      const app = cronRoutesApp(db, tenantId, allowAll);

      const created = await post(app, {
        expression: "0 9 * * *",
        definitionName: "agent-live-source",
        subject: "Scheduled run",
        body: "go",
      });
      expect(created.status).toBe(201);
      const createdBody = (await created.json()) as { schedule: { definitionName: string } };
      expect(createdBody.schedule.definitionName).toBe("agent-live-source");

      const rejected = await post(app, {
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

  test("each route is gated by the host's requireGrant", async () => {
    const { db, close } = createDB(requireDatabase().config);
    try {
      const tenantId = `tnt_cron_mnt_${randomUUID().slice(0, 8)}`;
      await seedTenant(db, tenantId);
      await seedDeployment(db, tenantId, "agent-gated-source");

      const checked: string[] = [];
      const denyAll: RequireGrant = (resource, action) => async (c) => {
        const resolved = typeof resource === "function" ? resource({ param: (name) => c.req.param(name) }) : resource;
        checked.push(`${resolved} ${action}`);
        return c.json({ error: "forbidden" }, 403);
      };
      const app = cronRoutesApp(db, tenantId, denyAll);

      expect((await app.request("/cron")).status).toBe(403);
      const created = await post(app, {
        expression: "0 9 * * *",
        definitionName: "agent-gated-source",
        subject: "Scheduled run",
        body: "go",
      });
      expect(created.status).toBe(403);
      expect((await app.request("/cron/sched_1", { method: "DELETE" })).status).toBe(403);
      expect(checked).toEqual([
        "cron-schedule:* read",
        "cron-schedule:* create",
        "cron-schedule:sched_1 manage",
      ]);
    } finally {
      await close();
    }
  });
});
