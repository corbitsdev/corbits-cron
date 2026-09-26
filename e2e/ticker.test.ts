import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createDB, schema } from "@intx/db";
import { eq } from "drizzle-orm";

import { cronScheduleTable } from "../src/schema.js";
import { createCronTicker } from "../src/ticker.js";
import {
  createRunTriggerCronDeliver,
  type RunTriggerDeliverer,
} from "../src/deliver.js";
import { RUN_GRANTS_NOT_ROUTABLE } from "../src/deployment.js";
import {
  createTestDatabase,
  describeIfDb,
  type TestDatabase,
  DB_SETUP_TIMEOUT_MS,
} from "./helpers.js";
import {
  deleteDefinition,
  seedAllocation,
  seedDeployment,
  seedLiveRun,
  seedTenant,
  tenantDomainFor,
} from "./fixtures.js";

describeIfDb("createCronTicker", () => {
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

  test("a due row is mailed at its deployment's current run address", async () => {
    const { db, close } = createDB(requireDatabase().config);
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
      // Polling, not a fixed sleep: tick latency follows DB load.
      for (let i = 0; i < 250 && delivered.length === 0; i++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      ticker.stop();
      // Let an in-flight tick settle before close() ends the client: a tick
      // killed mid-flight rejects with CONNECTION_ENDED, which bun attributes
      // to whatever test runs next.
      await new Promise((resolve) => setTimeout(resolve, 300));

      expect(delivered).toEqual([
        { subject: "due", to: [`${runId}@${tenantDomainFor(tenantId)}`] },
      ]);

      const [firedRow] = await db
        .select()
        .from(cronScheduleTable)
        .where(eq(cronScheduleTable.id, dueId));
      expect(firedRow?.lastFiredAt).not.toBeNull();
    } finally {
      await close();
    }
  });

  test("no live run but the agent is still there: waits, then delivers when it returns", async () => {
    const { db, close } = createDB(requireDatabase().config);
    try {
      const tenantId = `tnt_cron_wait_${randomUUID().slice(0, 8)}`;
      await seedTenant(db, tenantId);
      await seedDeployment(db, tenantId, "agent-wait-source", "completed");

      const id = `sched_wait_${randomUUID().slice(0, 8)}`;
      await db.insert(cronScheduleTable).values({
        id,
        tenantId,
        expression: "* * * * *",
        definitionName: "agent-wait-source",
        subject: "waiting",
        body: "come back",
        createdAt: new Date(Date.now() - 2 * 60_000),
      });

      const delivered: string[] = [];
      const stopped: string[] = [];
      const waiting: string[] = [];
      const ticker = createCronTicker({
        db,
        intervalMs: 20,
        deliver: (message) => {
          delivered.push(message.to[0] ?? "");
        },
        onScheduleStopped: (schedule) => stopped.push(schedule.id),
        onScheduleWaiting: (schedule) => waiting.push(schedule.id),
      });
      ticker.start();
      // Polling, not a fixed sleep: tick latency follows DB load.
      for (let i = 0; i < 250 && waiting.length === 0; i++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }

      expect(delivered).toEqual([]);
      expect(stopped).toEqual([]);
      // Reported once, however many ticks the gap lasts.
      expect(waiting).toEqual([id]);
      const [waitingRow] = await db
        .select()
        .from(cronScheduleTable)
        .where(eq(cronScheduleTable.id, id));
      expect(waitingRow?.waitingSince).not.toBeNull();
      expect(waitingRow?.lastFiredAt).toBeNull();
      expect(waitingRow?.stoppedAt).toBeNull();

      const runId = await seedLiveRun(db, tenantId, "agent-wait-source");
      // Polling, not a fixed sleep: tick latency follows DB load.
      for (let i = 0; i < 250 && delivered.length === 0; i++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      ticker.stop();
      // Let an in-flight tick settle before close() ends the client.
      await new Promise((resolve) => setTimeout(resolve, 300));

      expect(delivered).toEqual([`${runId}@${tenantDomainFor(tenantId)}`]);
      const [firedRow] = await db
        .select()
        .from(cronScheduleTable)
        .where(eq(cronScheduleTable.id, id));
      expect(firedRow?.lastFiredAt).not.toBeNull();
      expect(firedRow?.waitingSince).toBeNull();
    } finally {
      await close();
    }
  });

  test("a schedule whose agent was deleted stops instead of firing", async () => {
    const { db, close } = createDB(requireDatabase().config);
    try {
      const tenantId = `tnt_cron_gone_${randomUUID().slice(0, 8)}`;
      await seedTenant(db, tenantId);
      await seedDeployment(db, tenantId, "agent-gone-source");
      await deleteDefinition(db, tenantId, "agent-gone-source");

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
      // Polling, not a fixed sleep: tick latency follows DB load.
      for (let i = 0; i < 250 && stopped.length === 0; i++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      ticker.stop();
      // Let an in-flight tick settle before close() ends the client.
      await new Promise((resolve) => setTimeout(resolve, 300));

      expect(fired).toBe(0);
      expect(stopped).toEqual([id]);

      const [row] = await db
        .select()
        .from(cronScheduleTable)
        .where(eq(cronScheduleTable.id, id));
      expect(row?.stoppedAt).not.toBeNull();
      expect(row?.stoppedReason).toBe("agent_deleted");
      expect(row?.lastFiredAt).toBeNull();
    } finally {
      await close();
    }
  });

  test("two concurrent tickers deliver a due row exactly once", async () => {
    const { db: dbA, close: closeA } = createDB(requireDatabase().config);
    const { db: dbB, close: closeB } = createDB(requireDatabase().config);
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

      const delivered: string[] = [];
      const deliverer: RunTriggerDeliverer = {
        to: async (address) => {
          delivered.push(address);
        },
      };
      const tickerA = createCronTicker({
        db: dbA,
        intervalMs: 20,
        deliver: createRunTriggerCronDeliver(deliverer),
      });
      const tickerB = createCronTicker({
        db: dbB,
        intervalMs: 20,
        deliver: createRunTriggerCronDeliver(deliverer),
      });
      tickerA.start();
      tickerB.start();
      // Polling, not a fixed sleep: tick latency follows DB load.
      for (let i = 0; i < 1000 && delivered.length === 0; i++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      // Both tickers keep racing past the first delivery.
      await new Promise((resolve) => setTimeout(resolve, 300));
      tickerA.stop();
      tickerB.stop();
      // Let an in-flight tick settle before close() ends the client.
      await new Promise((resolve) => setTimeout(resolve, 300));

      expect(delivered).toHaveLength(1);
      const [row] = await dbA
        .select({ lastFiredAt: cronScheduleTable.lastFiredAt })
        .from(cronScheduleTable)
        .where(eq(cronScheduleTable.id, id));
      expect(row?.lastFiredAt).toBeInstanceOf(Date);
    } finally {
      await closeA();
      await closeB();
    }
  });

  test("an unroutable dead run with a settled allocation fails the stale anchor, then waits", async () => {
    const { db, close } = createDB(requireDatabase().config);
    try {
      const tenantId = `tnt_cron_stale_${randomUUID().slice(0, 8)}`;
      await seedTenant(db, tenantId);
      // A previous stack's death: the anchor is still "running" but its
      // sidecar is gone and its allocation already settled released.
      const runId = await seedDeployment(
        db,
        tenantId,
        "agent-stale-source",
        "running",
      );
      await seedAllocation(db, runId, tenantId, "released");

      const id = `sched_stale_${randomUUID().slice(0, 8)}`;
      await db.insert(cronScheduleTable).values({
        id,
        tenantId,
        expression: "* * * * *",
        definitionName: "agent-stale-source",
        subject: "stale",
        body: "dead run",
        createdAt: new Date(Date.now() - 2 * 60_000),
      });

      const errors: unknown[] = [];
      const waiting: string[] = [];
      let deliveries = 0;
      const ticker = createCronTicker({
        db,
        intervalMs: 20,
        deliver: () => {
          deliveries++;
          const address = `${runId}@${tenantDomainFor(tenantId)}`;
          throw Object.assign(
            new Error(`run grants not routable for ${address} (run ${runId})`),
            {
              code: RUN_GRANTS_NOT_ROUTABLE,
              address,
              runId,
            },
          );
        },
        onDeliveryError: (error) => errors.push(error),
        onScheduleWaiting: (schedule) => waiting.push(schedule.id),
      });
      ticker.start();
      // Wait for the first (failing) delivery to settle the stale anchor.
      // Polling, not a fixed sleep: tick latency follows DB load.
      let runStatus: string | undefined;
      for (let i = 0; i < 250; i++) {
        const [run] = await db
          .select({ status: schema.workflowRun.status })
          .from(schema.workflowRun)
          .where(eq(schema.workflowRun.id, runId));
        runStatus = run?.status;
        if (errors.length >= 1 && runStatus === "failed") break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }

      // The failure is reported — as a real failure naming the run — and the
      // stale anchor is marked terminal.
      expect(errors.length).toBeGreaterThanOrEqual(1);
      expect(String((errors[0] as Error).message)).toContain(
        "run grants not routable",
      );
      expect(String((errors[0] as Error).message)).toContain(runId);
      expect(runStatus).toBe("failed");
      const firedOnce = deliveries;
      expect(firedOnce).toBeGreaterThanOrEqual(1);

      // Simulate the next due minute: the schedule is due again, but the dead
      // run is gone, so the ticker waits for the agent to come back instead
      // of delivering into the dead run every tick.
      await db
        .update(cronScheduleTable)
        .set({ lastFiredAt: null })
        .where(eq(cronScheduleTable.id, id));
      for (let i = 0; i < 250 && waiting.length === 0; i++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      ticker.stop();
      // Let an in-flight tick settle before close() ends the client.
      await new Promise((resolve) => setTimeout(resolve, 300));

      expect(waiting).toEqual([id]);
      expect(deliveries).toBe(firedOnce);
    } finally {
      await close();
    }
  });

  test("an unroutable run whose allocation is still active stays live", async () => {
    const { db, close } = createDB(requireDatabase().config);
    try {
      const tenantId = `tnt_cron_live_${randomUUID().slice(0, 8)}`;
      await seedTenant(db, tenantId);
      const runId = await seedDeployment(
        db,
        tenantId,
        "agent-live-source",
        "running",
      );
      await seedAllocation(db, runId, tenantId, "allocated");

      const id = `sched_live_${randomUUID().slice(0, 8)}`;
      await db.insert(cronScheduleTable).values({
        id,
        tenantId,
        expression: "* * * * *",
        definitionName: "agent-live-source",
        subject: "live",
        body: "sidecar may reconnect",
        createdAt: new Date(Date.now() - 2 * 60_000),
      });

      const errors: unknown[] = [];
      const ticker = createCronTicker({
        db,
        intervalMs: 20,
        deliver: () => {
          const address = `${runId}@${tenantDomainFor(tenantId)}`;
          throw Object.assign(
            new Error(`run grants not routable for ${address} (run ${runId})`),
            {
              code: RUN_GRANTS_NOT_ROUTABLE,
              address,
              runId,
            },
          );
        },
        onDeliveryError: (error) => errors.push(error),
      });
      ticker.start();
      // Polling, not a fixed sleep: tick latency follows DB load.
      for (let i = 0; i < 250 && errors.length === 0; i++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      ticker.stop();
      // Let an in-flight tick settle before close() ends the client.
      await new Promise((resolve) => setTimeout(resolve, 300));

      // Still reported — the sidecar may just be reconnecting — but the run
      // is untouched: only a settled allocation proves the sidecar is gone.
      expect(errors.length).toBeGreaterThanOrEqual(1);
      const [run] = await db
        .select({ status: schema.workflowRun.status })
        .from(schema.workflowRun)
        .where(eq(schema.workflowRun.id, runId));
      expect(run?.status).toBe("running");
    } finally {
      await close();
    }
  });
});
