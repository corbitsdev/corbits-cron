// The `cron` schema's one table: a tenant's saved cron schedules. Kept on
// its own Postgres schema, with a real FK back to Interchange's `tenant`
// table, per this repo's "custom tables live on their own schema" rule.
import { pgTable, pgSchema, text, timestamp } from "drizzle-orm/pg-core";
import postgres from "postgres";

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
  // Set once when the target has no live deployment left; a stopped
  // schedule never fires again.
  stoppedAt: timestamp("stopped_at", { withTimezone: true }),
  stoppedReason: text("stopped_reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** Builds the FK against `tenantSchema.tenant` — `"public"` in every real
 * deployment, a scratch schema in tests. */
function cronMigrationSql(tenantSchema: string): string {
  const tenantTable = `${quoteIdentifier(tenantSchema)}."tenant"`;
  return `
    CREATE SCHEMA IF NOT EXISTS "cron";
    CREATE TABLE IF NOT EXISTS "cron"."schedule" (
      "id" text PRIMARY KEY,
      "tenant_id" text NOT NULL REFERENCES ${tenantTable}("id") ON DELETE CASCADE,
      "expression" text NOT NULL,
      "definition_name" text NOT NULL,
      "subject" text NOT NULL,
      "body" text NOT NULL,
      "last_fired_at" timestamptz,
      "stopped_at" timestamptz,
      "stopped_reason" text,
      "created_at" timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS "cron_schedule_tenant_id_idx" ON "cron"."schedule" ("tenant_id");
  `;
}

/** Applies the migration idempotently, inside one advisory-locked
 * transaction so concurrent hub replicas cannot race the same DDL. */
export async function applyCronMigrations(
  databaseUrl: string,
  options?: { tenantSchema?: string },
): Promise<void> {
  const client = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
  try {
    await client.begin(async (tx) => {
      await tx.unsafe(`SELECT pg_advisory_xact_lock(hashtext('corbits_cron'))`);
      await tx.unsafe(cronMigrationSql(options?.tenantSchema ?? "public"));
    });
  } catch (error) {
    throw new Error(
      `@corbits/cron migration failed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  } finally {
    await client.end({ timeout: 5 });
  }
}
