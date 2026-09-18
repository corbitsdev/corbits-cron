# @corbits/cron

Cron schedules for an Interchange hub. A tenant saves a cron expression plus
a mail (`to` / `subject` / `body`); `createCronTicker` polls for due
schedules and hands each to the host's own transport, so a
schedule-triggered workflow is just a `mail`-triggered one addressed at
itself. The vendored Interchange workflow-trigger grammar has no native
`schedule` trigger — this package is the bridge, not a fork of it.

## Install

```
bun add @corbits/cron
```

## Mount (`mountCron`)

CRUD at `/api/tenants/:tenantId/cron`, registered directly on the host's
app (never a sub-router under a prefix):

```ts
const cronApp = new Hono<TenantEnv>();
mountCron(cronApp, {
  db,
  requireTenantMember: (ctx, tenantId) => {
    const c = ctx as { get(key: "tenant"): { id: string } };
    return c.get("tenant").id === tenantId;
  },
});
app.route("/", cronApp);
```

| Route | |
|---|---|
| `GET /api/tenants/:tenantId/cron` | List the tenant's schedules |
| `POST /api/tenants/:tenantId/cron` | Create a schedule (`expression`, `toAddress`, `subject`, `body`) |
| `DELETE /api/tenants/:tenantId/cron/:id` | Remove a schedule |

## Ticker (`createCronTicker`)

```ts
createCronTicker({
  db,
  intervalMs: 60_000,
  deliver: (message) =>
    lookups.persistMail({
      senderAddress: message.from,
      recipients: message.to,
      raw: buildRawMessage(message),
    }),
}).start();
```

Each tick claims due rows with `SELECT ... FOR UPDATE SKIP LOCKED`, so two
tickers racing the same table split the due rows rather than double-fire
any of them, and a schedule that missed several ticks fires once for the
most recent due minute, never once per missed tick. A schedule's failed
delivery is reported through `onDeliveryError` and never blocks the rest of
the table.

## Deliverer adapter (`createRunTriggerCronDeliver`)

Structurally compatible with `@corbits/webhooks`'s `createRunTriggerDeliverer`,
so a host can point a cron ticker at the same system-trigger deliverer it
already built for webhooks:

```ts
createCronTicker({
  db,
  intervalMs: 60_000,
  deliver: createRunTriggerCronDeliver(
    createRunTriggerDeliverer({
      router,
      materialize,
      tenantDomain,
      senderLocalPart: "cron",
      systemSender: createTenantSystemSender({ db, principalKeyStore }),
    }),
  ),
}).start();
```

## Schema / migrations

One table, on its own Postgres schema (`cron.schedule`), FK'd back to
Interchange's `tenant` table:

| Column | |
|---|---|
| `id` | primary key |
| `tenant_id` | FK → `tenant.id`, cascades on delete |
| `expression` | 5-field cron string |
| `to_address` | mail recipient |
| `subject`, `body` | mail content |
| `last_fired_at` | last tick this schedule fired |
| `created_at` | a fresh schedule is due at its first matching minute after this, never retroactively |

Applied idempotently, inside one advisory-locked transaction so concurrent
hub replicas cannot race the same DDL:

```ts
import { applyCronMigrations } from "@corbits/cron/migrations";

await applyCronMigrations(databaseUrl);
```

## License

LGPL-2.1
