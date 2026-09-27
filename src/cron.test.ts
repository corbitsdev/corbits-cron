// Table-driven cron correctness: step-from-min, DOM/DOW OR, Sunday=7,
// bounded lookahead, and timezone / DST round-trips.
import { describe, expect, test } from "bun:test";

import {
  cronExpressionCanFire,
  cronIsDue,
  cronMatchesMinute,
  MAX_CRON_CLAUSES,
  MAX_CRON_EXPRESSION_LENGTH,
  parseCronExpression,
  isValidCronExpression,
  isValidTimeZone,
  nextCronFireAfter,
  zonedParts,
} from "./cron.js";

describe("isValidCronExpression", () => {
  test("accepts standard 5-field expressions", () => {
    expect(isValidCronExpression("*/5 * * * *")).toBe(true);
    expect(isValidCronExpression("0 9 * * 1")).toBe(true);
    expect(isValidCronExpression("15,45 * * * *")).toBe(true);
    expect(isValidCronExpression("0 0 13 * 5")).toBe(true);
  });

  test("accepts 7 as Sunday on day-of-week", () => {
    expect(isValidCronExpression("* * * * 7")).toBe(true);
    expect(isValidCronExpression("0 0 * * 0,7")).toBe(true);
  });

  test("rejects wrong field counts and garbage", () => {
    expect(isValidCronExpression("* * * *")).toBe(false);
    expect(isValidCronExpression("* * * * * *")).toBe(false);
    expect(isValidCronExpression("not a cron string at all")).toBe(false);
    expect(isValidCronExpression("")).toBe(false);
  });

  test("rejects every field out of range", () => {
    expect(isValidCronExpression("99 99 99 99 99")).toBe(false);
    expect(isValidCronExpression("0 0 32 * *")).toBe(false);
    expect(isValidCronExpression("0 0 * 13 *")).toBe(false);
    expect(isValidCronExpression("60 * * * *")).toBe(false);
    expect(isValidCronExpression("* * * * 8")).toBe(false);
  });

  test("rejects a reversed range", () => {
    expect(isValidCronExpression("10-5 * * * *")).toBe(false);
    expect(isValidCronExpression("10-5/2 * * * *")).toBe(false);
  });

  test("accepts the standard range-then-step idiom", () => {
    expect(isValidCronExpression("5-10/2 * * * *")).toBe(true);
  });
});

describe("step fields offset from field minimum", () => {
  // `*/2` on day-of-month (min=1) → 1,3,5… not 2,4,6…
  const cases: {
    name: string;
    expression: string;
    at: string;
    matches: boolean;
  }[] = [
    {
      name: "DOM */2 matches day 1",
      expression: "0 0 */2 * *",
      at: "2026-01-01T00:00:00Z",
      matches: true,
    },
    {
      name: "DOM */2 does not match day 2",
      expression: "0 0 */2 * *",
      at: "2026-01-02T00:00:00Z",
      matches: false,
    },
    {
      name: "DOM */2 matches day 3",
      expression: "0 0 */2 * *",
      at: "2026-01-03T00:00:00Z",
      matches: true,
    },
    {
      name: "minute */2 still matches 0 (min=0)",
      expression: "*/2 * * * *",
      at: "2026-01-01T00:00:00Z",
      matches: true,
    },
    {
      name: "minute */2 matches 2",
      expression: "*/2 * * * *",
      at: "2026-01-01T00:02:00Z",
      matches: true,
    },
    {
      name: "minute */2 does not match 1",
      expression: "*/2 * * * *",
      at: "2026-01-01T00:01:00Z",
      matches: false,
    },
    {
      name: "month */2 matches January (min=1)",
      expression: "0 0 1 */2 *",
      at: "2026-01-01T00:00:00Z",
      matches: true,
    },
    {
      name: "month */2 does not match February",
      expression: "0 0 1 */2 *",
      at: "2026-02-01T00:00:00Z",
      matches: false,
    },
  ];

  for (const c of cases) {
    test(c.name, () => {
      expect(cronMatchesMinute(c.expression, new Date(c.at))).toBe(c.matches);
    });
  }
});

describe("DOM / DOW OR when both restricted (POSIX/Vixie)", () => {
  // `0 0 13 * 5` = midnight on the 13th OR any Friday.
  const expression = "0 0 13 * 5";

  test("matches the 13th even when it is not Friday", () => {
    // 2026-01-13 is a Tuesday.
    expect(
      cronMatchesMinute(expression, new Date("2026-01-13T00:00:00Z")),
    ).toBe(true);
  });

  test("matches a Friday that is not the 13th", () => {
    // 2026-01-16 is a Friday.
    expect(
      cronMatchesMinute(expression, new Date("2026-01-16T00:00:00Z")),
    ).toBe(true);
  });

  test("does not match a day that is neither the 13th nor Friday", () => {
    // 2026-01-14 is a Wednesday.
    expect(
      cronMatchesMinute(expression, new Date("2026-01-14T00:00:00Z")),
    ).toBe(false);
  });

  test("when only DOM is restricted, DOW is ignored (AND with *)", () => {
    // Only the 15th, any weekday.
    expect(
      cronMatchesMinute("0 0 15 * *", new Date("2026-01-15T00:00:00Z")),
    ).toBe(true);
    expect(
      cronMatchesMinute("0 0 15 * *", new Date("2026-01-16T00:00:00Z")),
    ).toBe(false);
  });

  test("when only DOW is restricted, DOM is ignored", () => {
    // Every Monday at midnight.
    expect(
      cronMatchesMinute("0 0 * * 1", new Date("2026-01-12T00:00:00Z")),
    ).toBe(true);
    expect(
      cronMatchesMinute("0 0 * * 1", new Date("2026-01-13T00:00:00Z")),
    ).toBe(false);
  });
});

describe("day-of-week 0 and 7 are both Sunday", () => {
  test("expression with 7 matches a Sunday Date (day 0)", () => {
    // 2026-01-04 is a Sunday.
    expect(
      cronMatchesMinute("0 0 * * 7", new Date("2026-01-04T00:00:00Z")),
    ).toBe(true);
  });

  test("expression with 0 matches the same Sunday", () => {
    expect(
      cronMatchesMinute("0 0 * * 0", new Date("2026-01-04T00:00:00Z")),
    ).toBe(true);
  });

  test("neither matches a Monday", () => {
    expect(
      cronMatchesMinute("0 0 * * 7", new Date("2026-01-05T00:00:00Z")),
    ).toBe(false);
  });
});

describe("nextCronFireAfter + canFire bounds", () => {
  test("finds the next matching minute", () => {
    const next = nextCronFireAfter(
      "0-5 * * * *",
      new Date("2026-01-01T00:00:00Z"),
    );
    expect(next.toISOString()).toBe("2026-01-01T00:01:00.000Z");
  });

  test("impossible Feb 31 fails canFire and nextCronFireAfter", () => {
    expect(cronExpressionCanFire("0 0 31 2 *")).toBe(false);
    expect(() =>
      nextCronFireAfter("0 0 31 2 *", new Date("2026-01-01T00:00:00Z")),
    ).toThrow(/no fire time within the lookahead window/);
  });

  test("a once-a-year expression still finds its fire", () => {
    // Jan 1 at 00:00 — after Dec 31, next is next year.
    const next = nextCronFireAfter(
      "0 0 1 1 *",
      new Date("2026-06-01T00:00:00Z"),
    );
    expect(next.toISOString()).toBe("2027-01-01T00:00:00.000Z");
  });
});

describe("timezone matching and DST", () => {
  test("isValidTimeZone accepts IANA names and rejects garbage", () => {
    expect(isValidTimeZone("UTC")).toBe(true);
    expect(isValidTimeZone("America/Los_Angeles")).toBe(true);
    expect(isValidTimeZone("Europe/London")).toBe(true);
    expect(isValidTimeZone("Not/A_Zone")).toBe(false);
    expect(isValidTimeZone("")).toBe(false);
  });

  test("daily 09:00 America/Los_Angeles matches the correct UTC instant (PST)", () => {
    // 2026-01-15 is winter — PST = UTC-8, so 09:00 local = 17:00 UTC.
    const at = new Date("2026-01-15T17:00:00Z");
    expect(zonedParts(at, "America/Los_Angeles")).toMatchObject({
      hour: 9,
      minute: 0,
      day: 15,
      month: 1,
    });
    expect(cronMatchesMinute("0 9 * * *", at, "America/Los_Angeles")).toBe(
      true,
    );
    expect(cronMatchesMinute("0 9 * * *", at, "UTC")).toBe(false);
  });

  test("next fire for 09:00 America/Los_Angeles across a DST spring-forward", () => {
    // US Pacific spring forward 2026: 2026-03-08 02:00 → 03:00 local.
    // Before the transition (March 7 12:00 UTC = March 7 04:00 PST):
    // next 09:00 local is March 7 09:00 PST = March 7 17:00 UTC.
    const before = new Date("2026-03-07T12:00:00Z");
    const nextBefore = nextCronFireAfter(
      "0 9 * * *",
      before,
      "America/Los_Angeles",
    );
    expect(nextBefore.toISOString()).toBe("2026-03-07T17:00:00.000Z");
    expect(zonedParts(nextBefore, "America/Los_Angeles").hour).toBe(9);

    // After spring-forward, 09:00 PDT = UTC-7 → 16:00 UTC.
    const afterTransition = new Date("2026-03-09T12:00:00Z");
    const nextAfter = nextCronFireAfter(
      "0 9 * * *",
      afterTransition,
      "America/Los_Angeles",
    );
    expect(nextAfter.toISOString()).toBe("2026-03-09T16:00:00.000Z");
    expect(zonedParts(nextAfter, "America/Los_Angeles").hour).toBe(9);
  });

  test("next fire for 09:00 America/Los_Angeles across a DST fall-back", () => {
    // US Pacific fall back 2026: 2026-11-01 02:00 → 01:00 local.
    // After the transition, 09:00 PST = UTC-8 → 17:00 UTC.
    const afterFallback = new Date("2026-11-02T12:00:00Z");
    const next = nextCronFireAfter(
      "0 9 * * *",
      afterFallback,
      "America/Los_Angeles",
    );
    expect(next.toISOString()).toBe("2026-11-02T17:00:00.000Z");
    expect(zonedParts(next, "America/Los_Angeles").hour).toBe(9);
  });
});

describe("step without a range end runs to the field maximum", () => {
  test("5/2 on minutes is 5,7,…,59", () => {
    const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 0, minute));
    expect(cronMatchesMinute("5/2 * * * *", at(5))).toBe(true);
    expect(cronMatchesMinute("5/2 * * * *", at(7))).toBe(true);
    expect(cronMatchesMinute("5/2 * * * *", at(59))).toBe(true);
    expect(cronMatchesMinute("5/2 * * * *", at(6))).toBe(false);
    expect(cronMatchesMinute("5/2 * * * *", at(4))).toBe(false);
  });
});

describe("limits", () => {
  test("rejects an expression over the length cap", () => {
    const long = `${"0,".repeat(MAX_CRON_EXPRESSION_LENGTH)}0 * * * *`;
    expect(isValidCronExpression(long)).toBe(false);
  });

  test("rejects an expression over the clause cap", () => {
    const clauses = Array.from({ length: MAX_CRON_CLAUSES }, () => "1").join(
      ",",
    );
    expect(isValidCronExpression(`${clauses} * * * *`)).toBe(false);
  });

  test("never-firing expressions cannot fire; Feb 29 can", () => {
    expect(cronExpressionCanFire("0 0 31 2 *")).toBe(false);
    expect(cronExpressionCanFire("0 0 30 2 *")).toBe(false);
    expect(cronExpressionCanFire("0 0 31 4,6,9,11 *")).toBe(false);
    expect(cronExpressionCanFire("0 0 29 2 *")).toBe(true);
    expect(cronExpressionCanFire("0 0 31 2 5")).toBe(true);
  });
});

describe("cronIsDue", () => {
  const parsed = (expression: string) => {
    const result = parseCronExpression(expression);
    if (result === undefined) throw new Error(`unparseable: ${expression}`);
    return result;
  };

  test("a Feb 29 schedule created years earlier fires on Feb 29", () => {
    const after = new Date("2025-03-01T00:00:00Z");
    expect(
      cronIsDue(parsed("0 0 29 2 *"), after, new Date("2028-02-28T23:59:00Z")),
    ).toBe(false);
    expect(
      cronIsDue(parsed("0 0 29 2 *"), after, new Date("2028-02-29T00:00:30Z")),
    ).toBe(true);
  });

  test("Feb 29 across the 2100 non-leap gap", () => {
    expect(
      nextCronFireAfter("0 0 29 2 *", new Date("2096-03-01T00:00:00Z")),
    ).toEqual(new Date("2104-02-29T00:00:00Z"));
  });

  test("keeps Vixie OR when both day fields are restricted", () => {
    // 2026-01-16 is a Friday, not the 13th.
    expect(
      cronIsDue(
        parsed("0 0 13 * 5"),
        new Date("2026-01-15T00:00:00Z"),
        new Date("2026-01-16T00:00:00Z"),
      ),
    ).toBe(true);
  });

  test("a row last fired decades ago costs a bounded scan", () => {
    const start = performance.now();
    expect(
      cronIsDue(
        parsed("0 0 29 2 *"),
        new Date("1970-01-01T00:00:00Z"),
        new Date("2027-12-31T00:00:00Z"),
      ),
    ).toBe(true);
    expect(performance.now() - start).toBeLessThan(100);
  });
});

describe("cost is bounded", () => {
  test("a 5,000-clause expression is rejected without scanning", () => {
    const big = Array.from({ length: 5000 }, () => "1").join(",");
    const start = performance.now();
    expect(parseCronExpression(`${big} 0 31 2 *`)).toBeUndefined();
    expect(cronExpressionCanFire(`${big} 0 31 2 *`)).toBe(false);
    expect(performance.now() - start).toBeLessThan(50);
  });

  test("the costliest accepted expression finds its fire quickly", () => {
    const minutes = Array.from({ length: MAX_CRON_CLAUSES - 4 }, (_, i) =>
      String(59 - i),
    ).join(",");
    const expression = `${minutes} 23 29 2 *`;
    expect(isValidCronExpression(expression)).toBe(true);
    const start = performance.now();
    nextCronFireAfter(expression, new Date("2096-03-01T00:00:00Z"));
    expect(performance.now() - start).toBeLessThan(100);
  });
});
