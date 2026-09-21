# @corbits/cron

Cron schedules for an Interchange hub. A tenant saves a cron expression, the agent to wake, and the mail to send it (`subject` / `body`). `createCronTicker` polls for due rows and hands each to the host's transport, so a schedule-triggered workflow is a `mail`-triggered one addressed at itself.

## Install

```sh
npm add @corbits/cron
pnpm add @corbits/cron
yarn add @corbits/cron
bun add @corbits/cron
```

## Use

Apply migrations, then mount CRUD at `/api/tenants/:tenantId/cron` on the host app (never a sub-router under a prefix):

```ts
import { Hono } from "hono";
import { applyCronMigrations } from "@corbits/cron/migrations";
import { mountCron } from "@corbits/cron";

await applyCronMigrations(databaseUrl);

const cronApp = new Hono();
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
| `POST /api/tenants/:tenantId/cron` | Create (`expression`, `definitionName`, `subject`, `body`); 400 `unknown_definition` when no agent carries that name |
| `DELETE /api/tenants/:tenantId/cron/:id` | Remove a schedule |

## Full example

```ts
import {
  createCronTicker,
  createRunTriggerCronDeliver,
  isValidCronExpression,
} from "@corbits/cron";

if (!isValidCronExpression("0 9 * * 1-5")) {
  throw new Error("invalid expression");
}

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

`createRunTriggerCronDeliver` is structurally compatible with `@corbits/webhooks`'s `createRunTriggerDeliverer`, so a host can point cron at the same system-trigger deliverer it already built for webhooks.

## How it works

A schedule targets a live deployment by workflow definition name — stable across redeploys. At fire time the ticker mails `<run id>@<tenant domain>`. No live run is a wait (`waiting_since`), not a stop; only a deleted agent stops the row. Ticks claim due rows with `SELECT ... FOR UPDATE SKIP LOCKED`. A missed window fires once for the most recent due minute. Unroutable run triggers (`run_grants_not_routable` / `run_mail_not_routable`) fail a stale `running` anchor whose allocation already settled.

## Contributing

```sh
bun install
bun run typecheck
bun run test
```

`bun run test` is `bun test ./src`.

## License

LGPL-2.1-only.
