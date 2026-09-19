// CRUD over a tenant's saved cron schedules. Absolute routes registered
// directly on the host's app, never a sub-router under a prefix.
import { randomUUID } from "node:crypto";
import { type } from "arktype";
import { eq, and } from "drizzle-orm";
import type { Env, Hono } from "hono";

import { isValidCronExpression } from "./cron";
import { definitionExists } from "./deployment";
import { cronScheduleTable } from "./schema";
import type { CronDb } from "./ticker";

export type RequireTenantMember = (ctx: unknown, tenantId: string) => Promise<boolean> | boolean;

export type MountCronOpts = {
  db: CronDb;
  requireTenantMember: RequireTenantMember;
};

const CreateScheduleBody = type({
  expression: "string",
  definitionName: "string",
  subject: "string",
  body: "string",
});

/** Mount `/api/tenants/:tenantId/cron` CRUD onto the host's app. */
export function mountCron<E extends Env>(app: Hono<E>, opts: MountCronOpts): Hono<E> {
  const { db, requireTenantMember } = opts;

  app.get("/api/tenants/:tenantId/cron", async (c) => {
    const tenantId = c.req.param("tenantId");
    if (!(await requireTenantMember(c, tenantId))) return c.json({ error: "forbidden" }, 403);
    const rows = await db
      .select()
      .from(cronScheduleTable)
      .where(eq(cronScheduleTable.tenantId, tenantId));
    return c.json({ schedules: rows });
  });

  app.post("/api/tenants/:tenantId/cron", async (c) => {
    const tenantId = c.req.param("tenantId");
    if (!(await requireTenantMember(c, tenantId))) return c.json({ error: "forbidden" }, 403);
    const parsed = CreateScheduleBody(await c.req.json().catch(() => undefined));
    if (parsed instanceof type.errors) {
      return c.json({ error: "invalid_body", detail: parsed.summary }, 400);
    }
    if (!isValidCronExpression(parsed.expression)) {
      return c.json({ error: "invalid_expression" }, 400);
    }
    // Only a name no agent carries is a dead row from birth: an agent that is
    // merely between runs delivers as soon as it comes back.
    if (!(await definitionExists(db, tenantId, parsed.definitionName))) {
      return c.json({ error: "unknown_definition" }, 400);
    }
    const [row] = await db
      .insert(cronScheduleTable)
      .values({
        id: randomUUID(),
        tenantId,
        expression: parsed.expression,
        definitionName: parsed.definitionName,
        subject: parsed.subject,
        body: parsed.body,
      })
      .returning();
    return c.json({ schedule: row }, 201);
  });

  app.delete("/api/tenants/:tenantId/cron/:id", async (c) => {
    const tenantId = c.req.param("tenantId");
    if (!(await requireTenantMember(c, tenantId))) return c.json({ error: "forbidden" }, 403);
    const id = c.req.param("id");
    const [deleted] = await db
      .delete(cronScheduleTable)
      .where(and(eq(cronScheduleTable.tenantId, tenantId), eq(cronScheduleTable.id, id)))
      .returning({ id: cronScheduleTable.id });
    if (deleted === undefined) return c.json({ error: "not_found" }, 404);
    return c.json({ ok: true });
  });

  return app;
}
