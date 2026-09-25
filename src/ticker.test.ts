import { expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { createCronTicker } from "./ticker.js";

test("a throwing onTickError does not leave the tick rejection unhandled", async () => {
  const client = postgres("postgres://127.0.0.1:1/unreachable", {
    max: 1,
    connect_timeout: 1,
  });
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  let reported = 0;
  const ticker = createCronTicker({
    db: drizzle(client),
    deliver: () => undefined,
    intervalMs: 10,
    onTickError: () => {
      reported++;
      throw new Error("host reporter failed");
    },
  });
  try {
    ticker.start();
    while (reported === 0) await new Promise((r) => setTimeout(r, 10));
    await new Promise((r) => setTimeout(r, 50));
  } finally {
    ticker.stop();
    process.off("unhandledRejection", onUnhandled);
    await client.end({ timeout: 0 });
  }
  expect(unhandled).toEqual([]);
});
