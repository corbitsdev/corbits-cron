// The `cron` schema's one table: a tenant's saved cron schedules. Kept on
// its own Postgres schema, with a real FK back to Interchange's `tenant`
// table, so it never collides with the host's own tables.
import { pgTable, pgSchema, text, timestamp } from "drizzle-orm/pg-core";

const hostTenant = pgTable("tenant", { id: text("id").primaryKey() });

export const cronSchema = pgSchema("cron");

export const cronScheduleTable = cronSchema.table("schedule", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id")
    .notNull()
    .references(() => hostTenant.id, { onDelete: "cascade" }),
  expression: text("expression").notNull(),
  // The agent this schedule targets, by its workflow definition's name —
  // stable across redeploys, unlike a run address or a definition id.
  definitionName: text("definition_name").notNull(),
  subject: text("subject").notNull(),
  body: text("body").notNull(),
  lastFiredAt: timestamp("last_fired_at", { withTimezone: true }),
  // Set while the agent exists but has no live run — a hub restart, say.
  // Cleared by the first tick that delivers again.
  waitingSince: timestamp("waiting_since", { withTimezone: true }),
  // Set once when the targeted agent is deleted; a stopped schedule never
  // fires again.
  stoppedAt: timestamp("stopped_at", { withTimezone: true }),
  stoppedReason: text("stopped_reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
