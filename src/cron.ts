// The single 5-field cron grammar `@corbits/workflows` speaks: one parser
// shared by validation and execution, so whatever validates here is
// exactly what matches here (previously two hand-rolled parsers could
// disagree). Semantics match Vixie/POSIX cron; see the functions below.
export type CronField =
  | "minute"
  | "hour"
  | "dayOfMonth"
  | "month"
  | "dayOfWeek";

/** Field order in a 5-field cron expression, paired with its valid range. */
export const CRON_FIELD_RANGES: Readonly<
  Record<CronField, readonly [number, number]>
> = {
  minute: [0, 59],
  hour: [0, 23],
  dayOfMonth: [1, 31],
  month: [1, 12],
  // 0 and 7 are both Sunday (POSIX); validation accepts either, matching
  // normalises 7 → 0 so a Date's getUTCDay() of 0 still matches `7`.
  dayOfWeek: [0, 7],
};

type CronClause = {
  readonly base: "*" | number;
  readonly rangeEnd?: number;
  readonly step?: number;
};

// Only base-range-step order is accepted (`5`, `5-10`, `*/2`, `5-10/2`) —
// the reversed `5/2-10` idiom is not supported.
const CLAUSE_PATTERN = /^(\*|[0-9]+)(?:-([0-9]+))?(?:\/([0-9]+))?$/;

function parseCronClause(raw: string): CronClause | undefined {
  const match = CLAUSE_PATTERN.exec(raw);
  if (match === null) return undefined;
  const [, base, rangeEnd, step] = match;
  const clauseBase: CronClause = { base: base === "*" ? "*" : Number(base) };
  const withRangeEnd =
    rangeEnd !== undefined
      ? { ...clauseBase, rangeEnd: Number(rangeEnd) }
      : clauseBase;
  return step !== undefined
    ? { ...withRangeEnd, step: Number(step) }
    : withRangeEnd;
}

/** True when `clause` is meaningful for `[min, max]`: values in range, and a
 * reversed range (`10-5`) rejected rather than silently never-true. */
function clauseInRange(
  clause: CronClause,
  [min, max]: readonly [number, number],
): boolean {
  if (clause.step !== undefined && clause.step <= 0) return false;
  if (clause.base === "*") return true;
  if (clause.base < min || clause.base > max) return false;
  if (clause.rangeEnd === undefined) return true;
  if (clause.rangeEnd < min || clause.rangeEnd > max) return false;
  return clause.rangeEnd >= clause.base;
}

/** Every value `clause` allows in `[min, max]`. A step without a range end
 * runs to the field maximum, so `5/2` on minutes is 5,7,…,59 (Vixie). */
function clauseValues(clause: CronClause, min: number, max: number): number[] {
  const start = clause.base === "*" ? min : clause.base;
  const end =
    clause.base === "*" ||
    (clause.rangeEnd === undefined && clause.step !== undefined)
      ? max
      : (clause.rangeEnd ?? clause.base);
  const step = clause.step ?? 1;
  const values: number[] = [];
  for (let value = start; value <= end; value += step) values.push(value);
  return values;
}

/** Bounds parse and match cost: a longer expression is rejected, not
 * scanned. */
export const MAX_CRON_EXPRESSION_LENGTH = 256;
export const MAX_CRON_CLAUSES = 64;

/** A cron expression parsed once into its allowed values per field. */
export type ParsedCron = {
  readonly minutes: readonly boolean[];
  readonly hours: readonly boolean[];
  readonly daysOfMonth: readonly boolean[];
  readonly months: readonly boolean[];
  /** 0–6; an expression's 7 is folded onto 0 (Sunday). */
  readonly daysOfWeek: readonly boolean[];
  /** Vixie: DOM and DOW OR when both are restricted, otherwise AND. */
  readonly dayFieldsOr: boolean;
};

// True when the field is restricted (not a bare wildcard or step-1). Vixie
// OR-semantics for DOM/DOW only apply when both fields are restricted.
function isDayFieldRestricted(field: string): boolean {
  return field !== "*" && field !== "*/1";
}

function parseField(
  field: string,
  [min, max]: readonly [number, number],
): boolean[] | undefined {
  const allowed = Array.from({ length: max + 1 }, () => false);
  for (const raw of field.split(",")) {
    const clause = parseCronClause(raw);
    if (clause === undefined || !clauseInRange(clause, [min, max])) {
      return undefined;
    }
    for (const value of clauseValues(clause, min, max)) allowed[value] = true;
  }
  return allowed;
}

/** Parses `expression`, or `undefined` when it is malformed, out of range or
 * over the length or clause cap. */
export function parseCronExpression(
  expression: string,
): ParsedCron | undefined {
  if (expression.length > MAX_CRON_EXPRESSION_LENGTH) return undefined;
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return undefined;
  if (fields.join(",").split(",").length > MAX_CRON_CLAUSES) return undefined;
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields as [
    string,
    string,
    string,
    string,
    string,
  ];
  const minutes = parseField(minute, CRON_FIELD_RANGES.minute);
  const hours = parseField(hour, CRON_FIELD_RANGES.hour);
  const daysOfMonth = parseField(dayOfMonth, CRON_FIELD_RANGES.dayOfMonth);
  const months = parseField(month, CRON_FIELD_RANGES.month);
  const weekdays = parseField(dayOfWeek, CRON_FIELD_RANGES.dayOfWeek);
  if (
    minutes === undefined ||
    hours === undefined ||
    daysOfMonth === undefined ||
    months === undefined ||
    weekdays === undefined
  ) {
    return undefined;
  }
  return {
    minutes,
    hours,
    daysOfMonth,
    months,
    daysOfWeek: weekdays
      .slice(0, 7)
      .map((on, day) => on || (day === 0 && weekdays[7] === true)),
    dayFieldsOr:
      isDayFieldRestricted(dayOfMonth) && isDayFieldRestricted(dayOfWeek),
  };
}

/** Loud, eager syntax + range validation (never a fire-time surprise like a
 * minute of 60). Whether it can ever actually fire is `cronExpressionCanFire`. */
export function isValidCronExpression(expression: string): boolean {
  return parseCronExpression(expression) !== undefined;
}

export type ZonedParts = {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly dayOfWeek: number;
};

/** Wall-clock parts of `at` in `timeZone`. Throws on an invalid IANA name —
 * user input must validate first via `isValidTimeZone`. */
export function zonedParts(at: Date, timeZone: string = "UTC"): ZonedParts {
  if (timeZone === "UTC") {
    return {
      year: at.getUTCFullYear(),
      month: at.getUTCMonth() + 1,
      day: at.getUTCDate(),
      hour: at.getUTCHours(),
      minute: at.getUTCMinutes(),
      dayOfWeek: at.getUTCDay(),
    };
  }
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hourCycle: "h23",
  }).formatToParts(at);

  let year = 0;
  let month = 0;
  let day = 0;
  let hour = 0;
  let minute = 0;
  let weekday = "";
  for (const part of parts) {
    if (part.type === "year") year = Number(part.value);
    else if (part.type === "month") month = Number(part.value);
    else if (part.type === "day") day = Number(part.value);
    else if (part.type === "hour") hour = Number(part.value);
    else if (part.type === "minute") minute = Number(part.value);
    else if (part.type === "weekday") weekday = part.value;
  }
  // en-US short weekday → 0=Sun … 6=Sat
  const dowMap: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  const dayOfWeek = dowMap[weekday];
  if (dayOfWeek === undefined) {
    throw new Error(
      `zonedParts: could not resolve weekday "${weekday}" in ${timeZone}`,
    );
  }
  return { year, month, day, hour, minute, dayOfWeek };
}

/** True when `timeZone` is a recognised IANA name (or `"UTC"`). */
export function isValidTimeZone(timeZone: string): boolean {
  if (timeZone === "UTC") return true;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date());
    return true;
  } catch {
    // report-error-ignore: Intl rejects unknown IANA names; that is the
    // false signal, not an operational failure.
    return false;
  }
}

function dayMatches(cron: ParsedCron, parts: ZonedParts): boolean {
  if (cron.months[parts.month] !== true) return false;
  const dom = cron.daysOfMonth[parts.day] === true;
  const dow = cron.daysOfWeek[parts.dayOfWeek] === true;
  return cron.dayFieldsOr ? dom || dow : dom && dow;
}

function parseOrThrow(expression: string): ParsedCron {
  const cron = parseCronExpression(expression);
  if (cron === undefined) {
    throw new Error(`"${expression}" is not a valid cron expression`);
  }
  return cron;
}

/** True when `expression` matches the wall-clock minute of `at` in
 * `timeZone`. DOM and DOW OR when both are restricted; otherwise AND. */
export function cronMatchesMinute(
  expression: string,
  at: Date,
  timeZone: string = "UTC",
): boolean {
  const cron = parseOrThrow(expression);
  const parts = zonedParts(at, timeZone);
  return (
    dayMatches(cron, parts) &&
    cron.hours[parts.hour] === true &&
    cron.minutes[parts.minute] === true
  );
}

/** The UTC minute `at` falls in, as a stable, comparable integer key. */
function minuteKey(at: Date): number {
  return Math.floor(at.getTime() / 60_000);
}

/** Bounds every search. Eight years plus a day covers the longest gap any
 * valid expression has: Feb 29 across a skipped century leap year. */
export const MAX_LOOKAHEAD_MINUTES = (8 * 366 + 1) * 24 * 60;

/** The first matching minute key in `[from, to]`, or `undefined`. Skips
 * whole non-matching hours and days, so a scan costs a few steps per day
 * however long the expression. Offsets are whole minutes and every skip
 * stops at or before the next local hour or midnight, so DST cannot jump
 * past a match. */
function firstMatchBetween(
  cron: ParsedCron,
  from: number,
  to: number,
  timeZone: string,
): number | undefined {
  let minute = from;
  while (minute <= to) {
    const parts = zonedParts(new Date(minute * 60_000), timeZone);
    const toNextHour = 60 - parts.minute;
    if (!dayMatches(cron, parts)) {
      minute += Math.max(toNextHour, (23 - parts.hour) * 60 - parts.minute);
      continue;
    }
    if (cron.hours[parts.hour] !== true) {
      minute += toNextHour;
      continue;
    }
    const next = cron.minutes.indexOf(true, parts.minute);
    if (next === parts.minute) return minute;
    minute += next === -1 ? toNextHour : next - parts.minute;
  }
  return undefined;
}

/** The next minute at or after `after` (exclusive) that `expression`
 * matches. Always returns a UTC instant, even when matching is zoned. */
export function nextCronFireAfter(
  expression: string,
  after: Date,
  timeZone: string = "UTC",
): Date {
  const start = minuteKey(after) + 1;
  const next = firstMatchBetween(
    parseOrThrow(expression),
    start,
    start + MAX_LOOKAHEAD_MINUTES,
    timeZone,
  );
  if (next === undefined) {
    throw new Error(
      `"${expression}" has no fire time within the lookahead window` +
        (timeZone === "UTC" ? "" : ` in ${timeZone}`),
    );
  }
  return new Date(next * 60_000);
}

/** True when a UTC minute after `after` and at or before `now` matches.
 * Only the last lookahead window before `now` is searched: a valid
 * expression fires inside every such window, so an old `after` never
 * makes the scan longer or hides a fire. */
export function cronIsDue(cron: ParsedCron, after: Date, now: Date): boolean {
  const to = minuteKey(now);
  const from = Math.max(minuteKey(after) + 1, to - MAX_LOOKAHEAD_MINUTES);
  return firstMatchBetween(cron, from, to, "UTC") !== undefined;
}

const DAYS_IN_MONTH = [0, 31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** Arithmetic, no scan. Hours and minutes always have a value, and a
 * restricted DOW fires every month, so only a DOM-only day list can miss
 * every chosen month (Feb 30, Apr 31). Feb 29 counts: leap years come. */
export function parsedCronCanFire(cron: ParsedCron): boolean {
  return cron.months.some((inMonth, month) => {
    if (!inMonth) return false;
    if (cron.dayFieldsOr) return true;
    const dayFits = cron.daysOfMonth.some(
      (on, day) => on && day <= (DAYS_IN_MONTH[month] ?? 0),
    );
    return dayFits && cron.daysOfWeek.some(Boolean);
  });
}

/** True when `expression` is valid and some minute ever matches it. Used
 * at save time to reject an impossible expression. */
export function cronExpressionCanFire(
  expression: string,
  timeZone: string = "UTC",
): boolean {
  if (!isValidTimeZone(timeZone)) return false;
  const cron = parseCronExpression(expression);
  return cron !== undefined && parsedCronCanFire(cron);
}
