// Create validates its target against the workflow definitions the hub
// itself writes, so it needs a real database.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createDB } from "@intx/db";
import type { RequireGrant, TenantEnv } from "@intx/hub-api";
import { eq } from "drizzle-orm";
import type { Hono } from "hono";

import { cronScheduleTable } from "../src/schema.js";
import { createCronTicker } from "../src/ticker.js";

import {
  createTestDatabase,
  cronRoutesApp,
  describeIfDb,
  type TestDatabase,
  DB_SETUP_TIMEOUT_MS,
} from "./helpers.js";
import { seedDeployment, seedTenant } from "./fixtures.js";

describeIfDb("createCronRoutes", () => {
  let database: TestDatabase | undefined;

  beforeAll(async () => {
    database = await createTestDatabase();
  }, DB_SETUP_TIMEOUT_MS);

  function requireDatabase(): TestDatabase {
    if (database === undefined)
      throw new Error("test database was not created");
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
      const createdBody = (await created.json()) as {
        schedule: { definitionName: string };
      };
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

  test("an expression that can never fire or is over the caps is rejected", async () => {
    const { db, close } = createDB(requireDatabase().config);
    try {
      const tenantId = `tnt_cron_expr_${randomUUID().slice(0, 8)}`;
      await seedTenant(db, tenantId);
      await seedDeployment(db, tenantId, "agent-expr-source");
      const app = cronRoutesApp(db, tenantId, allowAll);

      const huge = Array.from({ length: 5000 }, () => "1").join(",");
      for (const expression of ["0 0 31 2 *", `${huge} * * * *`]) {
        const response = await post(app, {
          expression,
          definitionName: "agent-expr-source",
          subject: "s",
          body: "b",
        });
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({ error: "invalid_expression" });
      }
      const leap = await post(app, {
        expression: "0 0 29 2 *",
        definitionName: "agent-expr-source",
        subject: "s",
        body: "b",
      });
      expect(leap.status).toBe(201);
    } finally {
      await close();
    }
  });

  test("a paused schedule is skipped by the ticker; resume restarts its clock", async () => {
    const { db, close } = createDB(requireDatabase().config);
    try {
      const tenantId = `tnt_cron_pause_${randomUUID().slice(0, 8)}`;
      await seedTenant(db, tenantId);
      await seedDeployment(db, tenantId, "agent-pause-source");
      const app = cronRoutesApp(db, tenantId, allowAll);
      const id = `sched_pause_${randomUUID().slice(0, 8)}`;
      await db.insert(cronScheduleTable).values({
        id,
        tenantId,
        expression: "* * * * *",
        definitionName: "agent-pause-source",
        subject: "s",
        body: "b",
        createdAt: new Date(Date.now() - 5 * 60_000),
      });

      const paused = await app.request(`/cron/${id}/pause`, { method: "POST" });
      expect(paused.status).toBe(200);
      expect(
        ((await paused.json()) as { schedule: { enabled: boolean } }).schedule
          .enabled,
      ).toBe(false);

      const delivered: string[] = [];
      const ticker = createCronTicker({
        db,
        intervalMs: 50,
        deliver: (message) => {
          delivered.push(message.subject);
        },
      });
      ticker.start();
      await new Promise((resolve) => setTimeout(resolve, 500));
      ticker.stop();
      expect(delivered).toEqual([]);

      const resumed = await app.request(`/cron/${id}/resume`, {
        method: "POST",
      });
      expect(resumed.status).toBe(200);
      const [row] = await db
        .select()
        .from(cronScheduleTable)
        .where(eq(cronScheduleTable.id, id));
      expect(row?.enabled).toBe(true);
      // Restarted at now, not due for the five paused minutes.
      expect(Date.now() - (row?.lastFiredAt?.getTime() ?? 0)).toBeLessThan(
        30_000,
      );

      expect(
        (await app.request("/cron/missing/pause", { method: "POST" })).status,
      ).toBe(404);
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
        const resolved =
          typeof resource === "function"
            ? resource({ param: (name) => c.req.param(name) })
            : resource;
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
      expect(
        (await app.request("/cron/sched_1", { method: "DELETE" })).status,
      ).toBe(403);
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
