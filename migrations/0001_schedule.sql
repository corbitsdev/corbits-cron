CREATE SCHEMA IF NOT EXISTS "cron";
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cron"."schedule" (
  "id" text PRIMARY KEY,
  "tenant_id" text NOT NULL REFERENCES "public"."tenant"("id") ON DELETE CASCADE,
  "expression" text NOT NULL,
  "definition_name" text NOT NULL,
  "subject" text NOT NULL,
  "body" text NOT NULL,
  "last_fired_at" timestamptz,
  "waiting_since" timestamptz,
  "stopped_at" timestamptz,
  "stopped_reason" text,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
-- Tables created before waiting_since existed.
ALTER TABLE "cron"."schedule" ADD COLUMN IF NOT EXISTS "waiting_since" timestamptz;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cron_schedule_tenant_id_idx" ON "cron"."schedule" ("tenant_id");
