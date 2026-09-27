import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createDB, schema } from "@intx/db";
import { eq, sql } from "drizzle-orm";

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
  type TestDb,
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

  test("a long-gap schedule fires; one that can never fire stops, fast", async () => {
    const { db, close } = createDB(requireDatabase().config);
    try {
      const tenantId = `tnt_cron_expr_${randomUUID().slice(0, 8)}`;
      await seedTenant(db, tenantId);
      await seedDeployment(db, tenantId, "agent-expr-source");

      const suffix = randomUUID().slice(0, 8);
      const leapId = `sched_leap_${suffix}`;
      const feb31Id = `sched_feb31_${suffix}`;
      const hugeId = `sched_huge_${suffix}`;
      const huge = Array.from({ length: 5000 }, () => "1").join(",");
      const row = (id: string, expression: string, createdAt: Date) => ({
        id,
        tenantId,
        expression,
        definitionName: "agent-expr-source",
        subject: id,
        body: "b",
        createdAt,
      });
      // Feb 29 2024 is more than a year after this row was saved.
      await db
        .insert(cronScheduleTable)
        .values([
          row(leapId, "0 0 29 2 *", new Date("2021-03-01T00:00:00Z")),
          row(feb31Id, "0 0 31 2 *", new Date(Date.now() - 2 * 60_000)),
          row(hugeId, `${huge} 0 31 2 *`, new Date(Date.now() - 2 * 60_000)),
        ]);

      const delivered: string[] = [];
      const stopped: Array<{ id: string; reason: string }> = [];
      const ticker = createCronTicker({
        db,
        intervalMs: 20,
        deliver: (message) => {
          delivered.push(message.subject);
        },
        onScheduleStopped: (schedule) =>
          stopped.push({ id: schedule.id, reason: schedule.reason }),
      });
      const started = performance.now();
      ticker.start();
      // Polling, not a fixed sleep: tick latency follows DB load.
      for (
        let i = 0;
        i < 250 && (delivered.length === 0 || stopped.length < 2);
        i++
      ) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const elapsed = performance.now() - started;
      ticker.stop();
      // Let an in-flight tick settle before close() ends the client.
      await new Promise((resolve) => setTimeout(resolve, 300));

      expect(delivered).toEqual([leapId]);
      expect(stopped.sort((a, b) => a.id.localeCompare(b.id))).toEqual([
        { id: feb31Id, reason: "invalid_expression" },
        { id: hugeId, reason: "invalid_expression" },
      ]);
      expect(elapsed).toBeLessThan(2_000);
    } finally {
      await close();
    }
  });

  async function seedDueBatch(
    db: TestDb,
    label: string,
    count: number,
  ): Promise<{ tenantId: string; ids: string[] }> {
    const tenantId = `tnt_cron_${label}_${randomUUID().slice(0, 8)}`;
    await seedTenant(db, tenantId);
    await seedDeployment(db, tenantId, `agent-${label}-source`);
    const ids = Array.from(
      { length: count },
      (_, i) => `sched_${label}_${i}_${randomUUID().slice(0, 8)}`,
    );
    // Due once (Jan 1 has passed since creation), and not again next minute,
    // so a tick that crosses a minute boundary cannot legitimately re-fire.
    await db.insert(cronScheduleTable).values(
      ids.map((id) => ({
        id,
        tenantId,
        expression: "0 0 1 1 *",
        definitionName: `agent-${label}-source`,
        subject: id,
        body: "b",
        createdAt: new Date(Date.now() - 400 * 24 * 60 * 60_000),
      })),
    );
    return { tenantId, ids };
  }

  function countBy(subjects: string[]): Map<string, number> {
    const counts = new Map<string, number>();
    for (const subject of subjects) {
      counts.set(subject, (counts.get(subject) ?? 0) + 1);
    }
    return counts;
  }

  test("a tick killed mid-batch delivers each row at most once", async () => {
    const config = requireDatabase().config;
    const crashed = createDB(config);
    const survivor = createDB(config);
    try {
      const { ids } = await seedDueBatch(crashed.db, "crash", 21);
      const delivered: string[] = [];
      let killed = false;
      // The fifth delivery kills the tick's Postgres sessions and never
      // returns, like a process dying mid-batch.
      const crashing = createCronTicker({
        db: crashed.db,
        intervalMs: 20,
        deliver: async (message) => {
          if (!ids.includes(message.subject)) return;
          delivered.push(message.subject);
          if (delivered.length < 5) return;
          killed = true;
          await crashed.db.execute(
            sql`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()`,
          );
          await new Promise(() => undefined);
        },
      });
      crashing.start();
      for (let i = 0; i < 250 && !killed; i++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      crashing.stop();

      const recovering = createCronTicker({
        db: survivor.db,
        intervalMs: 20,
        deliver: (message) => {
          if (ids.includes(message.subject)) delivered.push(message.subject);
        },
      });
      recovering.start();
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      recovering.stop();
      await new Promise((resolve) => setTimeout(resolve, 300));

      expect(killed).toBe(true);
      expect([...countBy(delivered).values()].every((n) => n === 1)).toBe(true);
    } finally {
      await Promise.race([
        crashed.close(),
        new Promise((resolve) => setTimeout(resolve, 1_000)),
      ]);
      await survivor.close();
    }
  });

  test("three concurrent tickers deliver each row exactly once", async () => {
    const handles = [1, 2, 3].map(() => createDB(requireDatabase().config));
    try {
      const [first] = handles;
      if (first === undefined) throw new Error("no db handle");
      const { ids } = await seedDueBatch(first.db, "trio", 21);
      const delivered: string[] = [];
      const deliverer: RunTriggerDeliverer = {
        to: async (_address, _content, _tenantId, subject) => {
          if (subject === undefined || !ids.includes(subject)) return;
          await new Promise((resolve) => setTimeout(resolve, 5));
          delivered.push(subject);
        },
      };
      const tickers = handles.map(({ db }) =>
        createCronTicker({
          db,
          intervalMs: 20,
          deliver: createRunTriggerCronDeliver(deliverer),
        }),
      );
      for (const ticker of tickers) ticker.start();
      for (let i = 0; i < 250 && delivered.length < ids.length; i++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      // All three keep racing past the last delivery.
      await new Promise((resolve) => setTimeout(resolve, 300));
      for (const ticker of tickers) ticker.stop();
      await new Promise((resolve) => setTimeout(resolve, 300));

      const counts = countBy(delivered);
      expect(ids.map((id) => counts.get(id))).toEqual(ids.map(() => 1));
    } finally {
      for (const handle of handles) await handle.close();
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
