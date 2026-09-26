// CRUD over a tenant's saved cron schedules, as a sub-app the host mounts
// under its tenant prefix. The acting tenant comes from the host's context,
// never from a path parameter.
import { randomUUID } from "node:crypto";
import { type } from "arktype";
import { eq, and } from "drizzle-orm";
import { Hono } from "hono";
import { idResource, type RequireGrant, type TenantEnv } from "@intx/hub-api";

import { isValidCronExpression } from "./cron.js";
import { definitionExists } from "./deployment.js";
import { cronScheduleTable } from "./schema.js";
import type { CronDb } from "./ticker.js";

export type CronRoutesDeps = {
  db: CronDb;
  requireGrant: RequireGrant;
};

const CreateScheduleBody = type({
  expression: "string",
  definitionName: "string",
  subject: "string",
  body: "string",
});

export function createCronRoutes({
  db,
  requireGrant,
}: CronRoutesDeps): Hono<TenantEnv> {
  const app = new Hono<TenantEnv>();

  app.get("/", requireGrant("cron-schedule:*", "read"), async (c) => {
    const rows = await db
      .select()
      .from(cronScheduleTable)
      .where(eq(cronScheduleTable.tenantId, c.get("tenant").id));
    return c.json({ schedules: rows });
  });

  app.post("/", requireGrant("cron-schedule:*", "create"), async (c) => {
    const tenantId = c.get("tenant").id;
    const parsed = CreateScheduleBody(
      await c.req.json().catch(() => undefined),
    );
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

  app.delete(
    "/:id",
    requireGrant(idResource("cron-schedule", "id"), "manage"),
    async (c) => {
      const [deleted] = await db
        .delete(cronScheduleTable)
        .where(
          and(
            eq(cronScheduleTable.tenantId, c.get("tenant").id),
            eq(cronScheduleTable.id, c.req.param("id")),
          ),
        )
        .returning({ id: cronScheduleTable.id });
      if (deleted === undefined) return c.json({ error: "not_found" }, 404);
      return c.json({ ok: true });
    },
  );

  return app;
}
