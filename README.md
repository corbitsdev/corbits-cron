# @corbits/cron

Cron schedules for an Interchange hub. A tenant saves a cron expression, the
agent to wake, and the mail to send it (`subject` / `body`);
`createCronTicker` polls for due schedules and hands each to the host's own
transport, so a schedule-triggered workflow is just a `mail`-triggered one
addressed at itself.

## The schedule contract

A schedule targets an agent's **live deployment**, named by its workflow
definition's name (the name of the `workflow`-kind asset its source lives
in) — stable across redeploys, unlike a run address or a definition id. At
fire time the ticker resolves that name to the tenant's newest live anchor
run and mails `<run id>@<tenant domain>`, so a schedule keeps working after
a hub restart or a redeploy hands the agent a new run. An agent that exists
but has no live run right now is a gap, not an ending: the tick skips, marks
`waiting_since` and reports it once through `onScheduleWaiting`, and the
first tick that finds a live run again delivers and clears the marker. Only
a deleted agent — no workflow definition of that name left in the tenant —
stops the schedule (`stopped_at` plus `stopped_reason: "agent_deleted"`,
reported once through `onScheduleStopped`); a stopped schedule never fires
again. Creating a schedule is rejected only for a name no agent carries. The vendored Interchange workflow-trigger grammar has no native
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
| `POST /api/tenants/:tenantId/cron` | Create a schedule (`expression`, `definitionName`, `subject`, `body`); 400 `unknown_definition` when no agent carries that name |
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
| `definition_name` | the targeted agent's workflow definition name |
| `subject`, `body` | mail content |
| `last_fired_at` | last tick this schedule fired |
| `waiting_since` | set while the agent has no live run; cleared on the next delivery |
| `stopped_at`, `stopped_reason` | set when the targeted agent is deleted; a stopped schedule never fires again |
| `created_at` | a fresh schedule is due at its first matching minute after this, never retroactively |

Applied idempotently, inside one advisory-locked transaction so concurrent
hub replicas cannot race the same DDL:

```ts
import { applyCronMigrations } from "@corbits/cron/migrations";

await applyCronMigrations(databaseUrl);
```

## License

LGPL-2.1
