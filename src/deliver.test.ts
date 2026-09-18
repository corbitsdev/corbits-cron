import { expect, test } from "bun:test";

import { createRunTriggerCronDeliver } from "./deliver";

test("every recipient of a due schedule gets its own trigger", async () => {
  const calls: Array<[string, string, string, string | undefined]> = [];
  const deliver = createRunTriggerCronDeliver({
    to: async (address, content, tenantId, subject) => {
      calls.push([address, content, tenantId, subject]);
    },
  });

  await deliver({ to: ["run-a@x", "run-b@x"], subject: "Daily", body: "go", tenantId: "t1" });

  expect(calls).toEqual([
    ["run-a@x", "go", "t1", "Daily"],
    ["run-b@x", "go", "t1", "Daily"],
  ]);
});

test("a failed recipient stops the fan-out so the ticker can report it", async () => {
  const deliver = createRunTriggerCronDeliver({
    to: async (address) => {
      if (address === "run-a@x") throw new Error("not routable");
    },
  });

  expect(
    deliver({ to: ["run-a@x", "run-b@x"], subject: "s", body: "b", tenantId: "t1" }),
  ).rejects.toThrow("not routable");
});
