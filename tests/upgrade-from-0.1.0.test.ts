// A database migrated and written by the published 0.1.0 package upgrades in
// place: its schedules stay listed and keep firing.
import { afterAll, beforeAll, expect, test } from "bun:test";
import * as v010 from "@corbits/cron-0.1.0";
import { createDB, type DBConfig } from "@intx/db";
import type { RequireGrant } from "@intx/hub-api";

import { cronScheduleTable } from "../src/schema.js";
import { createCronTicker } from "../src/ticker.js";
import {
  createTestDatabase,
  cronRoutesApp,
  describeIfDb,
  type TestDatabase,
} from "./lib/db-harness.js";
import { seedDeployment, seedTenant } from "./lib/seed.js";

const tenantId = "tnt_cron_v010";
const scheduleId = "sched_v010";
const stoppedId = "sched_v010_stopped";
const stoppedAt = new Date("2026-01-01T00:00:00Z");

async function seedWithV010(config: DBConfig): Promise<void> {
  const user = encodeURIComponent(config.user);
  const password = encodeURIComponent(config.password ?? "");
  const url = `postgres://${user}:${password}@${config.host}:${config.port}/${config.database}`;
  await v010.applyCronMigrations(url);
  const { db, close } = createDB(config);
  try {
    await seedTenant(db, tenantId);
    const createdAt = new Date(Date.now() - 2 * 60_000);
    await db.insert(v010.cronScheduleTable).values([
      {
        id: scheduleId,
        tenantId,
        expression: "* * * * *",
        definitionName: "agent-v010",
        subject: "legacy",
        body: "still here",
        createdAt,
      },
      {
        id: stoppedId,
        tenantId,
        expression: "* * * * *",
        definitionName: "agent-v010",
        subject: "stopped",
        body: "never again",
        stoppedAt,
        stoppedReason: "definition_deleted",
        createdAt,
      },
    ]);
  } finally {
    await close();
  }
}

describeIfDb("upgrading a 0.1.0 database", () => {
  let database: TestDatabase | undefined;

  beforeAll(async () => {
    database = await createTestDatabase(seedWithV010);
  });

  afterAll(async () => {
    await database?.drop();
  });

  function requireDatabase(): TestDatabase {
    if (database === undefined) throw new Error("test database was not created");
    return database;
  }

  const allowAll: RequireGrant = () => async (_c, next) => {
    await next();
  };

  test("0.1.0 schedules are listed, a live one fires and a stopped one stays stopped", async () => {
    const { db, close } = createDB(requireDatabase().config);
    try {
      const listed = await cronRoutesApp(db, tenantId, allowAll).request("/cron");
      expect(listed.status).toBe(200);
      const { schedules } = (await listed.json()) as { schedules: Array<{ id: string }> };
      expect(schedules.map((row) => row.id).sort()).toEqual([scheduleId, stoppedId]);

      await seedDeployment(db, tenantId, "agent-v010");
      const delivered: string[] = [];
      const ticker = createCronTicker({
        db,
        intervalMs: 50,
        deliver: (message) => {
          delivered.push(message.subject);
        },
      });
      ticker.start();
      for (let i = 0; i < 250 && delivered.length === 0; i++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      ticker.stop();
      // Let an in-flight tick settle before close() ends the client.
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(delivered).toEqual(["legacy"]);

      const rows = await db.select().from(cronScheduleTable);
      const fired = rows.find((row) => row.id === scheduleId);
      const stopped = rows.find((row) => row.id === stoppedId);
      expect(fired?.lastFiredAt).toBeInstanceOf(Date);
      expect(stopped?.stoppedAt).toEqual(stoppedAt);
      expect(stopped?.lastFiredAt).toBeNull();
    } finally {
      await close();
    }
  });
});
