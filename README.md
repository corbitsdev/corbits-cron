# @corbits/cron

Run an Interchange workflow on a cron schedule.

## Quickstart

```sh
npm add @corbits/cron
```

At boot, right after Interchange's `runMigrations`, apply this package's migrations with the same `config` and `schema`. The `cron.schedule` table is created on its own `cron` Postgres schema, with its tenant FK pointing into `schema`:

```ts
import { runMigrations } from "@intx/db";
import { runCronMigrations } from "@corbits/cron/migrations";

await runMigrations(config, { schema: "public" });
await runCronMigrations(config, { schema: "public" });
```

Mounting is `createCronRoutes(deps)` (schedule CRUD, routed under the host's tenant app) plus `createCronTicker(opts)` (the poller that turns a due row into mail) started together, on the hub's existing `db`. The function below is complete and mounts both:

```ts
import type { RequireGrant, TenantEnv } from "@intx/hub-api";
import type { Hono } from "hono";
import {
  createCronRoutes,
  createCronTicker,
  createRunTriggerCronDeliver,
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
  tenantApp: Hono<TenantEnv>,
  db: CronDb,
  requireGrant: RequireGrant,
  deliverer: RunTriggerDeliverer,
  onError?: (error: unknown) => void,
): CronTicker {
  tenantApp.route("/cron", createCronRoutes({ db, requireGrant }));

  const ticker = createCronTicker({
    db,
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
| `tenantApp` | `Hono<TenantEnv>` | The host's tenant-scoped app, whose middleware already placed `tenant` and `principal` on the context; schedule CRUD is mounted on it at `/cron`. |
| `db` | `CronDb` | The hub's existing drizzle handle — the same one `runCronMigrations` migrated into. |
| `requireGrant` | `RequireGrant` | The host's Interchange `createRequireGrant` result; every route is gated on a `cron-schedule` grant. |
| `deliverer` | `RunTriggerDeliverer` | Turns a due schedule's recipient into mail; `createRunTriggerCronDeliver` adapts it to the ticker's `DeliverCronMail` shape. |
| `onError` | `(error: unknown) => void` (optional) | Told about a failed delivery or a schedule that stopped, so the host can report it; defaults to `console.error`. |

`installCron` returns the `CronTicker` so the host can `.stop()` it on shutdown.

| Route | Grant | |
|---|---|---|
| `GET /cron` | `cron-schedule:*` `read` | List the tenant's schedules |
| `POST /cron` | `cron-schedule:*` `create` | Create (`expression`, `definitionName`, `subject`, `body`); 400 `unknown_definition` when no agent carries that name |
| `DELETE /cron/:id` | `cron-schedule:<id>` `manage` | Remove a schedule |

## How it works

A schedule targets an agent by its workflow definition name, so it survives redeploys. A schedule whose agent has no live run waits (`waiting_since`) and fires again once the agent is back; a schedule whose agent was deleted stops for good. A missed window fires once, for the most recent due minute.

## Development

```sh
git clone https://github.com/corbitsdev/corbits-cron.git
cd corbits-cron
bun install
bun run typecheck
bun run test
```

`bun run test` is `bun test ./src ./tests`; the `tests/` suites need a real Postgres at `DATABASE_URL` and skip without one.

## License

LGPL-2.1-only.
