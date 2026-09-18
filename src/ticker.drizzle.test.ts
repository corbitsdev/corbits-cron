// DB-gated: skipped when no DATABASE_URL is reachable. Migrations run into
// a scratch schema so this test never touches a real tenant table;
// `applyCronMigrations` is told that scratch schema so its `tenant_id` FK
// targets it.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createDB, dropSchema, runMigrations, schema } from "@intx/db";
import { eq } from "drizzle-orm";

import { applyCronMigrations, cronScheduleTable } from "./schema";
import { createCronTicker } from "./ticker";

const databaseUrl = process.env.DATABASE_URL;
const describeIfDb = databaseUrl === undefined ? describe.skip : describe;

const SCHEMA = "cron_ticker_test";

function dbTargetFromUrl(url: string) {
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : 5432,
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database: parsed.pathname.replace(/^\//, ""),
  };
}

describeIfDb("createCronTicker", () => {
  const target = dbTargetFromUrl(databaseUrl ?? "postgres://localhost:5432/unused");

  beforeAll(async () => {
    await runMigrations(target, { schema: SCHEMA });
    await applyCronMigrations(databaseUrl ?? "", { tenantSchema: SCHEMA });
  });

  afterAll(async () => {
    await dropSchema(target, { schema: SCHEMA });
  });

  async function seedTenant(db: Awaited<ReturnType<typeof createDB>>["db"], id: string) {
    await db.insert(schema.tenant).values({
      id,
      name: id,
      slug: id.replace(/_/g, "-"),
      domain: `${id.replace(/_/g, "-")}.workbench.test`,
    });
  }

  test("fires a due row once and leaves a not-yet-due row alone", async () => {
    const { db, close } = createDB({ ...target, schema: SCHEMA });
    try {
      const tenantId = `tnt_cron_${randomUUID().slice(0, 8)}`;
      await seedTenant(db, tenantId);

      const dueId = `sched_due_${randomUUID().slice(0, 8)}`;
      const notDueId = `sched_not_due_${randomUUID().slice(0, 8)}`;
      const twoMinutesAgo = new Date(Date.now() - 2 * 60_000);
      await db.insert(cronScheduleTable).values([
        {
          id: dueId,
          tenantId,
          expression: "* * * * *",
          toAddress: "ops@example.com",
          subject: "due",
          body: "fire me",
          createdAt: twoMinutesAgo,
        },
        {
          id: notDueId,
          tenantId,
          expression: "0 0 1 1 *",
          toAddress: "ops@example.com",
          subject: "not due",
          body: "never yet",
          createdAt: twoMinutesAgo,
        },
      ]);

      const delivered: string[] = [];
      const ticker = createCronTicker({
        db,
        intervalMs: 50,
        deliver: (message) => {
          delivered.push(message.subject);
        },
      });
      ticker.start();
      await new Promise((resolve) => setTimeout(resolve, 200));
      ticker.stop();

      expect(delivered).toEqual(["due"]);

      const [firedRow] = await db
        .select()
        .from(cronScheduleTable)
        .where(eq(cronScheduleTable.id, dueId));
      expect(firedRow?.lastFiredAt).not.toBeNull();
    } finally {
      await close();
    }
  });

  test("SKIP LOCKED means two concurrent tickers never double-fire a row", async () => {
    const { db: dbA, close: closeA } = createDB({ ...target, schema: SCHEMA });
    const { db: dbB, close: closeB } = createDB({ ...target, schema: SCHEMA });
    try {
      const tenantId = `tnt_cron_race_${randomUUID().slice(0, 8)}`;
      await seedTenant(dbA, tenantId);

      const id = `sched_race_${randomUUID().slice(0, 8)}`;
      await dbA.insert(cronScheduleTable).values({
        id,
        tenantId,
        expression: "* * * * *",
        toAddress: "ops@example.com",
        subject: "race",
        body: "fire once",
        createdAt: new Date(Date.now() - 2 * 60_000),
      });

      let fireCount = 0;
      const tickerA = createCronTicker({
        db: dbA,
        intervalMs: 20,
        deliver: () => {
          fireCount++;
        },
      });
      const tickerB = createCronTicker({
        db: dbB,
        intervalMs: 20,
        deliver: () => {
          fireCount++;
        },
      });
      tickerA.start();
      tickerB.start();
      await new Promise((resolve) => setTimeout(resolve, 300));
      tickerA.stop();
      tickerB.stop();

      expect(fireCount).toBe(1);
    } finally {
      await closeA();
      await closeB();
    }
  });
});
