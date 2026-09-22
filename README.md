# @corbits/cron

Cron schedules for an Interchange hub. A tenant saves a cron expression, the agent to wake, and the mail to send it (`subject` / `body`). `createCronTicker` polls for due rows and hands each to the host's transport, so a schedule-triggered workflow is a `mail`-triggered one addressed at itself.

## Runtime support

The published export is TypeScript source (`./src/index.ts`); Bun consumes it directly. Native Node does not load this extensionless TypeScript source as-is.

## Quickstart

```sh
npm add @corbits/cron
pnpm add @corbits/cron
yarn add @corbits/cron
bun add @corbits/cron
```

`mountCron(app, opts)` registers schedule CRUD directly on the host app at `/api/tenants/:tenantId/cron`. Every field of `opts` is a host responsibility:

| `opts` | Type | What the host provides |
| --- | --- | --- |
| `db` | `CronDb` | Schedules are stored there. `createDB` (from `@intx/db`) opens a handle from a `{ host, port, user, password, database }` config; a hub that already has one passes it as `db` instead. |
| `requireTenantMember` | `(ctx: unknown, tenantId: string) => boolean` | Membership check for the tenant. Return `true` when the caller may manage that tenant's schedules. |

The program below is complete: it builds the same `host`/`port` config `createDB` and `applyCronMigrations` both need, runs the migration, opens a handle, and mounts the scheduler on a fresh Hono app. A hub that already has a `CronDb` passes it as `db` instead and skips `createDB` here.

```ts
import { createDB } from "@intx/db";
import { applyCronMigrations, mountCron } from "@corbits/cron";
import { Hono } from "hono";

const dbConfig = {
  host: process.env["DB_HOST"] ?? "localhost",
  port: Number(process.env["DB_PORT"] ?? 5432),
  user: process.env["DB_USER"] ?? "postgres",
  password: process.env["DB_PASSWORD"] ?? "postgres",
  database: process.env["DB_NAME"] ?? "interchange",
};
const databaseUrl = `postgres://${dbConfig.user}:${dbConfig.password}@${dbConfig.host}:${String(dbConfig.port)}/${dbConfig.database}`;

await applyCronMigrations(databaseUrl, { tenantSchema: "public" });

const { db } = createDB(dbConfig);

const app = new Hono();
mountCron(app, {
  db,
  requireTenantMember: (ctx, tenantId) => {
    const c = ctx as { get(key: "tenant"): { id: string } };
    return c.get("tenant").id === tenantId;
  },
});

export default app;
```

The inline `requireTenantMember` reads the tenant the host middleware already placed on the request context. It lets any caller manage the matching tenant here — a real hub replaces the body with its own membership check before exposing this beyond local development.

| Route | |
|---|---|
| `GET /api/tenants/:tenantId/cron` | List the tenant's schedules |
| `POST /api/tenants/:tenantId/cron` | Create (`expression`, `definitionName`, `subject`, `body`); 400 `unknown_definition` when no agent carries that name |
| `DELETE /api/tenants/:tenantId/cron/:id` | Remove a schedule |

`createCronTicker(opts)` turns due rows into mail through the host's delivery function:

| `opts` | Type | What the host provides |
| --- | --- | --- |
| `db` | `CronDb` | The host's existing drizzle/Postgres handle. |
| `deliver` | `DeliverCronMail` | Called with `{ to, subject, body, tenantId }` for each due schedule. `createRunTriggerCronDeliver` adapts a run-trigger deliverer to this shape. |
| `intervalMs` | `number` | Poll interval, for example `60_000`. |
| `onDeliveryError` | `(error, schedule) => void` (optional) | Told about a delivery that failed, so the host can report it. |
| `onScheduleStopped` | `(schedule) => void` (optional) | Told once when a schedule stops because the agent it targets was deleted. |
| `onScheduleWaiting` | `(schedule) => void` (optional) | Told once each time a schedule starts waiting for its agent's next run. |

A host wires it with the same `db` handle and a `deliver` function; `createRunTriggerCronDeliver` adapts an existing run-trigger deliverer to the `{ to, subject, body, tenantId }` shape.

`createRunTriggerCronDeliver` is structurally compatible with `@corbits/webhooks`'s `createRunTriggerDeliverer`, so a host can point cron at the same system-trigger deliverer it built for webhooks.

## How it works

A schedule targets a live deployment by workflow definition name — stable across redeploys. At fire time the ticker mails `<run id>@<tenant domain>`. A schedule whose agent has no live run waits (`waiting_since`); a schedule whose agent was deleted stops. Ticks claim due rows with `SELECT ... FOR UPDATE SKIP LOCKED`. A missed window fires once for the most recent due minute. Unroutable run triggers (`run_grants_not_routable` / `run_mail_not_routable`) fail a stale `running` anchor whose allocation already settled.

## Development

```sh
git clone https://github.com/corbitsdev/corbits-cron.git
cd corbits-cron
bun install
bun run typecheck
bun run test
```

`bun run test` is `bun test ./src`.

## License

LGPL-2.1-only.
