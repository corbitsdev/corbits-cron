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

At boot, alongside the rest of the hub's own migrations, apply this package's migration against the hub's database and schema:

```ts
await applyCronMigrations(databaseUrl, { tenantSchema });
```

Mounting is `mountCron(app, opts)` (schedule CRUD, at `/api/tenants/:tenantId/cron`) plus `createCronTicker(opts)` (the poller that turns a due row into mail) started together, on the hub's existing `db`. The function below is complete and mounts both:

```ts
import type { Hono } from "hono";
import {
  createCronTicker,
  createRunTriggerCronDeliver,
  mountCron,
  type CronDb,
  type CronTicker,
  type RunTriggerDeliverer,
} from "@corbits/cron";

/**
 * Mounts schedule CRUD and starts the ticker on the host's own db.
 * `deliverer` is usually built from `@corbits/webhooks`'s
 * `createRunTriggerDeliverer` + `createTenantSystemSender` — the same
 * system-trigger deliverer a host already has wired up for webhooks.
 */
export function installCron(
  app: Hono,
  db: CronDb,
  deliverer: RunTriggerDeliverer,
  onError?: (error: unknown) => void,
): CronTicker {
  mountCron(app, {
    db,
    requireTenantMember: (ctx, tenantId) => {
      const c = ctx as { get(key: "tenant"): { id: string } };
      return c.get("tenant").id === tenantId;
    },
  });

  const ticker = createCronTicker({
    db,
    intervalMs: 60_000,
    deliver: createRunTriggerCronDeliver(deliverer),
    onDeliveryError: (error, schedule) => {
      if (onError) onError(error);
      else console.error("cron delivery failed", schedule.id, error);
    },
    onScheduleWaiting: (schedule) => {
      console.log("cron schedule waiting for its agent", schedule.id, schedule.definitionName);
    },
    onScheduleStopped: (schedule) => {
      const error = new Error(`cron schedule stopped: ${schedule.reason} (${schedule.definitionName})`);
      if (onError) onError(error);
      else console.error(error);
    },
  });
  ticker.start();
  return ticker;
}
```

| Param | Type | What the host provides |
| --- | --- | --- |
| `app` | `Hono` | Schedule CRUD is mounted on it at `/api/tenants/:tenantId/cron`. |
| `db` | `CronDb` | The hub's existing drizzle handle — the same one `applyCronMigrations` migrated into. |
| `deliverer` | `RunTriggerDeliverer` | Turns a due schedule's recipient into mail; `createRunTriggerCronDeliver` adapts it to the ticker's `DeliverCronMail` shape. |
| `onError` | `(error: unknown) => void` (optional) | Told about a failed delivery or a schedule that stopped, so the host can report it; defaults to `console.error`. |

`installCron` returns the `CronTicker` so the host can `.stop()` it on shutdown.

The inline `requireTenantMember` reads the tenant the host's own tenant middleware already placed on the request context — it relies on that middleware having already authorized the request, not on any check of its own.

| Route | |
|---|---|
| `GET /api/tenants/:tenantId/cron` | List the tenant's schedules |
| `POST /api/tenants/:tenantId/cron` | Create (`expression`, `definitionName`, `subject`, `body`); 400 `unknown_definition` when no agent carries that name |
| `DELETE /api/tenants/:tenantId/cron/:id` | Remove a schedule |

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
