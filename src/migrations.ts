// Applies migrations/*.sql, shipped next to dist/, into the `cron` schema.
// There is no ledger: every file runs on every boot, so every statement
// must be idempotent.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { DBConfig } from "@intx/db";
import postgres from "postgres";

const MIGRATIONS_DIR = join(import.meta.dirname, "..", "migrations");

function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** Takes the same `config` and `schema` the host passes Interchange's
 * `runMigrations`: `schema` is where the host's `tenant` table lives, and
 * the `"public".` FK references in the SQL are rewritten to it. Idempotent,
 * inside one advisory-locked transaction so concurrent hub replicas cannot
 * race the same DDL. */
export async function runCronMigrations(
  config: DBConfig,
  options: { schema: string },
): Promise<void> {
  if (options.schema.length === 0) {
    throw new Error("runCronMigrations: schema name must not be empty");
  }
  const schemaIdent = quoteIdentifier(options.schema);
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
  if (files.length === 0) {
    throw new Error(`runCronMigrations: no .sql files found in ${MIGRATIONS_DIR}`);
  }
  const statements: string[] = [];
  for (const file of files) {
    const raw = await readFile(join(MIGRATIONS_DIR, file), "utf8");
    for (const stmt of raw.replace(/"public"\.(?=")/g, `${schemaIdent}.`).split("--> statement-breakpoint")) {
      if (stmt.trim().length > 0) statements.push(stmt);
    }
  }

  const client = postgres({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    ssl: config.ssl,
    max: 1,
    onnotice: () => undefined,
  });
  try {
    await client.begin(async (tx) => {
      await tx.unsafe(`SELECT pg_advisory_xact_lock(hashtext('corbits_cron'))`);
      for (const stmt of statements) await tx.unsafe(stmt);
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
