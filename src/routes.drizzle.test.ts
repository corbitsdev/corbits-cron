// DB-gated: create validates its target against the workflow definitions the
// hub itself writes, so it needs a real database.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createDB, dropSchema, runMigrations } from "@intx/db";
import type { RequireGrant, TenantEnv } from "@intx/hub-api";
import { Hono } from "hono";

import { runCronMigrations } from "./migrations.js";
import { createCronRoutes } from "./routes.js";
import { dbTargetFromUrl, seedDeployment, seedTenant } from "./test-seed.js";

const databaseUrl = process.env.DATABASE_URL;
const describeIfDb = databaseUrl === undefined ? describe.skip : describe;

const SCHEMA = "cron_mount_test";

describeIfDb("createCronRoutes", () => {
  const target = dbTargetFromUrl(databaseUrl ?? "postgres://localhost:5432/unused");

  beforeAll(async () => {
    await runMigrations(target, { schema: SCHEMA });
    await runCronMigrations(target, { schema: SCHEMA });
  });

  afterAll(async () => {
    await dropSchema(target, { schema: SCHEMA });
  });

  /** Mounts the routes the way a host does: its tenant middleware has
   * already placed the tenant and principal on the context. */
  function host(db: ReturnType<typeof createDB>["db"], tenantId: string, requireGrant: RequireGrant) {
    const app = new Hono<TenantEnv>();
    app.use("*", async (c, next) => {
      const now = new Date(0);
      c.set("tenant", {
        id: tenantId,
        name: tenantId,
        slug: tenantId,
        domain: `${tenantId}.example`,
        parentId: null,
        config: null,
        createdAt: now,
        updatedAt: now,
      });
      c.set("principal", {
        id: "prn_test",
        tenantId,
        kind: "user",
        refId: "usr_test",
        status: "active",
        createdAt: now,
        updatedAt: now,
      });
      await next();
    });
    app.route("/cron", createCronRoutes({ db, requireGrant }));
    return app;
  }

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
    const { db, close } = createDB({ ...target, schema: SCHEMA });
    try {
      const tenantId = `tnt_cron_mnt_${randomUUID().slice(0, 8)}`;
      await seedTenant(db, tenantId);
      await seedDeployment(db, tenantId, "agent-live-source", "completed");

      const app = host(db, tenantId, allowAll);

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
    const { db, close } = createDB({ ...target, schema: SCHEMA });
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
      const app = host(db, tenantId, denyAll);

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
