// Real-Postgres harness for the DB tests: each suite gets its own fresh
// database, migrated by Interchange's runMigrations then runCronMigrations,
// and dropped on teardown. `cron.schedule` lives on a fixed `cron` schema,
// so a scratch schema per suite would share one table; a database does not.
// Suites skip when DATABASE_URL is unset.
import { describe } from "bun:test";
import { randomUUID } from "node:crypto";
import { createDB, runMigrations, type DBConfig } from "@intx/db";
import type { RequireGrant, TenantEnv } from "@intx/hub-api";
import { Hono } from "hono";
import postgres from "postgres";

import { runCronMigrations } from "../src/migrations.js";
import { createCronRoutes } from "../src/routes.js";

const databaseUrl = process.env.DATABASE_URL;

export const describeIfDb =
  databaseUrl === undefined ? describe.skip : describe;

/** A fresh database plus every host and cron migration outlasts bun's 5s hook default. */
export const DB_SETUP_TIMEOUT_MS = 60_000;

export type TestDb = ReturnType<typeof createDB>["db"];

export type TestDatabase = {
  config: DBConfig;
  drop: () => Promise<void>;
};

function adminClient(url: string) {
  return postgres(url, { max: 1, onnotice: () => undefined });
}

/** `beforeCron` runs after the host migrations and before this version's
 * `runCronMigrations`, to lay down an older release's schema and rows. */
export async function createTestDatabase(
  beforeCron?: (config: DBConfig) => Promise<void>,
): Promise<TestDatabase> {
  if (databaseUrl === undefined)
    throw new Error("createTestDatabase: DATABASE_URL is unset");
  const name = `cron_test_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const admin = adminClient(databaseUrl);
  try {
    await admin.unsafe(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.end();
  }
  const parsed = new URL(databaseUrl);
  const config: DBConfig = {
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : 5432,
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database: name,
  };
  const drop = async () => {
    const client = adminClient(databaseUrl);
    try {
      await client.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    } finally {
      await client.end();
    }
  };
  try {
    await runMigrations(config, { schema: "public" });
    await beforeCron?.(config);
    await runCronMigrations(config, { schema: "public" });
  } catch (error) {
    await drop();
    throw error;
  }
  return { config, drop };
}

/** Mounts `createCronRoutes` at `/cron` the way a host does: its tenant
 * middleware has already placed the tenant and principal on the context. */
export function cronRoutesApp(
  db: TestDb,
  tenantId: string,
  requireGrant: RequireGrant,
): Hono<TenantEnv> {
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
