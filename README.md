# @corbits/cron

A Corbits hub module that wakes Interchange agents on five-field UTC cron schedules, mounted as `@intx/hub-api` routes on the hub (Interchange's multi-tenant control plane) and stored in its Postgres. A ticker mails each due schedule to its agent's current run, the running instance of the agent's workflow definition.

Schedules support create, list and delete. There is no edit: delete and recreate.

## Why @corbits/cron?

1. **Schedules follow the agent, not the run.** A schedule names an agent by its definition name, so it survives redeploys. It waits while the agent has no current run and stops for good when the agent is deleted.
2. **Mounts like any hub route.** `createCronRoutes` returns a `Hono<TenantEnv>` sub-app. Every route runs through the hub's `requireGrant`, the check that the calling principal (a user or agent account) holds a grant (a permission on a resource).
3. **Safe with several hub replicas.** Tickers claim due rows with `FOR UPDATE SKIP LOCKED`, so no schedule fires twice. Migrations are idempotent and run under an advisory lock on every boot.

## Install

```bash
bun add @corbits/cron @intx/authz @intx/db @intx/hub-api drizzle-orm hono postgres
```

Runs on Node >= 24.

## Quickstart

```ts
import { nextCronFireAfter } from "@corbits/cron";

console.log(nextCronFireAfter("0 9 * * *", new Date()));
```

Prints the next 09:00 UTC, the next time a schedule with that expression fires.

## Where it fits

[Interchange](https://github.com/faremeter/interchange) runs AI agents as principals with their own identity, permissions and credentials. Its hub holds tenants, principals, grants and workflow runs.

- **Runs in:** the hub, as routes on its Hono app, a ticker in its process and a table in its Postgres.
- **Plugs into:** [`@intx/hub-api`](https://github.com/faremeter/interchange/tree/main/packages/hub-api) routes and grants, and [`@intx/db`](https://github.com/faremeter/interchange/tree/main/packages/db) (its `DBConfig`, its `tenant` table as FK target, and its workflow definitions and runs).
- **Pairs with:** [`@corbits/webhooks`](https://github.com/corbitsdev/webhooks), whose run-trigger deliverer sends the mail, and the other Corbits hub modules, [`@corbits/mailbox`](https://github.com/corbitsdev/corbits-mailbox) and [`@corbits/artifacts`](https://github.com/corbitsdev/corbits-artifacts).

## Reference

### `createCronRoutes(deps)`

| `deps`         | Type           | What the host provides                       |
| -------------- | -------------- | -------------------------------------------- |
| `db`           | `CronDb`       | The hub's drizzle handle.                    |
| `requireGrant` | `RequireGrant` | From `@intx/hub-api`'s `createRequireGrant`. |

### Routes

Paths are relative to where the host mounts the sub-app.

| Method | Path   | Grant                         | Purpose                                                                                                                                            |
| ------ | ------ | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/`    | `cron-schedule:*` `read`      | `{ schedules: [...] }` for the caller's tenant.                                                                                                    |
| POST   | `/`    | `cron-schedule:*` `create`    | Create from `{ expression, definitionName, subject, body }`. 201 `{ schedule }`; 400 `invalid_body`, `invalid_expression` or `unknown_definition`. |
| DELETE | `/:id` | `cron-schedule:<id>` `manage` | Delete one schedule. `{ ok: true }`; 404 `not_found` when it is not in the caller's tenant.                                                        |

### `createCronTicker(opts)`

Returns `{ start(), stop() }`.

| `opts`              | Type                                   | Purpose                                                                            |
| ------------------- | -------------------------------------- | ---------------------------------------------------------------------------------- |
| `db`                | `CronDb`                               | The hub's drizzle handle.                                                          |
| `deliver`           | `DeliverCronMail`                      | Sends one due schedule's mail. `createRunTriggerCronDeliver(deliverer)` builds it. |
| `intervalMs`        | `number` (optional)                    | Poll period. Defaults to 60 000.                                                   |
| `onTickError`       | `(error) => void` (optional)           | A tick failed before delivering, such as a lost connection. The next tick retries. |
| `onDeliveryError`   | `(error, schedule) => void` (optional) | One delivery failed.                                                               |
| `onScheduleWaiting` | `(schedule) => void` (optional)        | A schedule started waiting for its agent's next run.                               |
| `onScheduleStopped` | `(schedule) => void` (optional)        | A schedule stopped because its agent was deleted.                                  |

A deliverer throws an error carrying `RUN_GRANTS_NOT_ROUTABLE` or `RUN_MAIL_NOT_ROUTABLE` (checked with `isUnroutableRunTrigger`) when a run's address is dead. If that run's sidecar is already released, the ticker marks the run failed so the schedule waits for the agent's next run.

### `runCronMigrations(dbConfig, { schema })`

From `@corbits/cron/migrations`. Takes the same arguments as `@intx/db`'s `runMigrations`. `schema` holds the host's `tenant` table, which must exist first. The schedule table always lives in the `cron` schema. Call it on every boot.

### Other exports

| Export                                                                                                                             | Use                                                  |
| ---------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `isValidCronExpression(expression)`                                                                                                | The check `POST /` runs.                             |
| `nextCronFireAfter(expression, after)`                                                                                             | The next matching UTC minute after `after`.          |
| `isUnroutableRunTrigger(error)`, `RUN_GRANTS_NOT_ROUTABLE`, `RUN_MAIL_NOT_ROUTABLE`                                                | The dead-address error contract a deliverer follows. |
| `CronRoutesDeps`, `CreateCronTickerOpts`, `CronTicker`, `CronDb`, `DeliverCronMail`, `RunTriggerDeliverer`, `UnroutableRunTrigger` | Types for the above.                                 |

## Using with Interchange

Run the migrations on every hub boot and build the routes:

```ts
import { timeWindowEvaluator } from "@intx/authz";
import { createDB, createGrantStore, runMigrations } from "@intx/db";
import { createRequireGrant } from "@intx/hub-api";
import { createCronRoutes } from "@corbits/cron";
import { runCronMigrations } from "@corbits/cron/migrations";

const dbConfig = {
  host: "localhost",
  port: 5432,
  user: "postgres",
  password: "postgres",
  database: "interchange",
};
await runMigrations(dbConfig, { schema: "public" });
await runCronMigrations(dbConfig, { schema: "public" });
const { db } = createDB(dbConfig);

export const cronRoutes = createCronRoutes({
  db,
  requireGrant: createRequireGrant({
    grantStore: createGrantStore(db),
    conditionRegistry: { time_window: timeWindowEvaluator },
  }),
});
```

Mount `cronRoutes` at `/cron` under `/api/tenants/:tenantId`, behind the hub's auth and tenant middleware. Grant each principal `cron-schedule:*` with `read` and `create` to list and create, and `manage` (on `cron-schedule:*` or one `cron-schedule:<id>`) to delete. `POST /cron` with `{ "expression": "0 9 * * *", "definitionName": "daily-report", "subject": "Run", "body": "go" }` then mails the `daily-report` agent every day at 09:00 UTC.

Start one ticker per hub process with `createCronTicker({ db, deliver: createRunTriggerCronDeliver(deliverer) })`, where `deliverer` is the hub's run-trigger deliverer from `@corbits/webhooks`' `createRunTriggerDeliverer`. Call `ticker.stop()` on shutdown. At fire time the ticker mails `<run id>@<tenant domain>` for the agent's current run, so the agent's workflow needs a `mail` trigger. Replicas share the table safely.

## Upgrading from 0.1

- `mountCron(app, opts)` is replaced by `app.route(path, createCronRoutes({ db, requireGrant }))`. Routes are no longer at `/api/tenants/:tenantId/cron`, but wherever the host mounts them.
- `requireTenantMember` is gone. Every route checks a `cron-schedule` grant, so principals need those grants before calling it, or they get 403.
- `applyCronMigrations(url, { tenantSchema })` is now `runCronMigrations(dbConfig, { schema })`, imported from `@corbits/cron/migrations`. Pass the old `tenantSchema` value as `schema`.
- `cronScheduleTable`, `CRON_FIELD_RANGES`, `cronExpressionCanFire`, `isValidTimeZone`, `zonedParts`, `MAX_LOOKAHEAD_MINUTES`, `resolveLiveDeployment`, `definitionExists`, `failStaleAnchorRun` and the types `CronField`, `ZonedParts`, `LiveDeployment`, `MountCronOpts`, `RequireTenantMember` are no longer exported.
- `@intx/db`, `@intx/hub-api`, `drizzle-orm`, `hono` and `postgres` are now peers.
- `createCronTicker`'s `intervalMs` is optional and defaults to one minute.
- Existing databases upgrade on first boot with no manual step. Every 0.1.0 schedule keeps its state and keeps firing.

## License

LGPL-2.1-only. See [LICENSE](https://github.com/corbitsdev/corbits-cron/blob/main/LICENSE).
