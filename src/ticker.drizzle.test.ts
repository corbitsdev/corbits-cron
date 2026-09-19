// DB-gated: skipped when no DATABASE_URL is reachable. Migrations run into
// a scratch schema so this test never touches a real tenant table;
// `applyCronMigrations` is told that scratch schema so its `tenant_id` FK
// targets it.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createDB, dropSchema, runMigrations } from "@intx/db";
import { eq } from "drizzle-orm";

import { applyCronMigrations, cronScheduleTable } from "./schema";
import { createCronTicker } from "./ticker";
import { dbTargetFromUrl, seedDeployment, seedTenant, tenantDomainFor } from "./test-seed";

const databaseUrl = process.env.DATABASE_URL;
const describeIfDb = databaseUrl === undefined ? describe.skip : describe;

const SCHEMA = "cron_ticker_test";

describeIfDb("createCronTicker", () => {
  const target = dbTargetFromUrl(databaseUrl ?? "postgres://localhost:5432/unused");

  beforeAll(async () => {
    await runMigrations(target, { schema: SCHEMA });
    await applyCronMigrations(databaseUrl ?? "", { tenantSchema: SCHEMA });
  });

  afterAll(async () => {
    await dropSchema(target, { schema: SCHEMA });
  });

  test("a due row is mailed at its deployment's current run address", async () => {
    const { db, close } = createDB({ ...target, schema: SCHEMA });
    try {
      const tenantId = `tnt_cron_${randomUUID().slice(0, 8)}`;
      await seedTenant(db, tenantId);
      const runId = await seedDeployment(db, tenantId, "agent-due-source");

      const dueId = `sched_due_${randomUUID().slice(0, 8)}`;
      const notDueId = `sched_not_due_${randomUUID().slice(0, 8)}`;
      const twoMinutesAgo = new Date(Date.now() - 2 * 60_000);
      await db.insert(cronScheduleTable).values([
        {
          id: dueId,
          tenantId,
          expression: "* * * * *",
          definitionName: "agent-due-source",
          subject: "due",
          body: "fire me",
          createdAt: twoMinutesAgo,
        },
        {
          id: notDueId,
          tenantId,
          expression: "0 0 1 1 *",
          definitionName: "agent-due-source",
          subject: "not due",
          body: "never yet",
          createdAt: twoMinutesAgo,
        },
      ]);

      const delivered: Array<{ subject: string; to: string[] }> = [];
      const ticker = createCronTicker({
        db,
        intervalMs: 50,
        deliver: (message) => {
          delivered.push({ subject: message.subject, to: message.to });
        },
      });
      ticker.start();
      await new Promise((resolve) => setTimeout(resolve, 200));
      ticker.stop();

      expect(delivered).toEqual([{ subject: "due", to: [`${runId}@${tenantDomainFor(tenantId)}`] }]);

      const [firedRow] = await db
        .select()
        .from(cronScheduleTable)
        .where(eq(cronScheduleTable.id, dueId));
      expect(firedRow?.lastFiredAt).not.toBeNull();
    } finally {
      await close();
    }
  });

  test("a schedule whose deployment is gone stops instead of firing", async () => {
    const { db, close } = createDB({ ...target, schema: SCHEMA });
    try {
      const tenantId = `tnt_cron_gone_${randomUUID().slice(0, 8)}`;
      await seedTenant(db, tenantId);
      await seedDeployment(db, tenantId, "agent-gone-source", "completed");

      const id = `sched_gone_${randomUUID().slice(0, 8)}`;
      await db.insert(cronScheduleTable).values({
        id,
        tenantId,
        expression: "* * * * *",
        definitionName: "agent-gone-source",
        subject: "orphan",
        body: "nobody home",
        createdAt: new Date(Date.now() - 2 * 60_000),
      });

      let fired = 0;
      const stopped: string[] = [];
      const ticker = createCronTicker({
        db,
        intervalMs: 20,
        deliver: () => {
          fired++;
        },
        onScheduleStopped: (schedule) => stopped.push(schedule.id),
      });
      ticker.start();
      await new Promise((resolve) => setTimeout(resolve, 200));
      ticker.stop();

      expect(fired).toBe(0);
      expect(stopped).toEqual([id]);

      const [row] = await db.select().from(cronScheduleTable).where(eq(cronScheduleTable.id, id));
      expect(row?.stoppedAt).not.toBeNull();
      expect(row?.stoppedReason).toBe("deployment_gone");
      expect(row?.lastFiredAt).toBeNull();
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
      await seedDeployment(dbA, tenantId, "agent-race-source");

      const id = `sched_race_${randomUUID().slice(0, 8)}`;
      await dbA.insert(cronScheduleTable).values({
        id,
        tenantId,
        expression: "* * * * *",
        definitionName: "agent-race-source",
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
