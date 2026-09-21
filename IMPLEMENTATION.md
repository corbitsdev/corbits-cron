# @corbits/cron — Implementation

## Package

- Name: `@corbits/cron` `0.1.0`
- License: LGPL-2.1-only
- Public exports: `./src/index.ts` and `./src/migrations.ts` (TypeScript
  source; no `dist/`)
- `package.json` does not declare `engines`. Bun consumes the published
  source directly. Native Node does not load this extensionless TypeScript
  as-is.
- These design docs live at the repository root. The npm tarball currently
  ships `src/`, `README.md`, and `LICENSE`.

## Runtime dependencies

- `drizzle-orm` + `postgres` for the ticker transaction and `cron.schedule`
- `@intx/db` for Interchange schema (`tenant`, `workflowDefinition`,
  `workflowRun`, `sidecarAllocation`, `liveWorkflowRunStatuses`)
- `hono` for `mountCron`
- `arktype` for the create-schedule body

No dependency on `@corbits/webhooks`. Unroutable codes and the
`RunTriggerDeliverer` shape are duplicated structurally.

## Install

```sh
npm add @corbits/cron
pnpm add @corbits/cron
yarn add @corbits/cron
bun add @corbits/cron
```

## Public surface

From `@corbits/cron`:

- `mountCron(app, { db, requireTenantMember })` — absolute CRUD at
  `/api/tenants/:tenantId/cron`
- `createCronTicker({ db, deliver, intervalMs, onDeliveryError?,
  onScheduleStopped?, onScheduleWaiting? })` — `{ start, stop }`
- `createRunTriggerCronDeliver(deliverer)` — `DeliverCronMail` over a
  `RunTriggerDeliverer`
- `isValidCronExpression`, `nextCronFireAfter`, `cronExpressionCanFire`,
  `isValidTimeZone`, `zonedParts`, `CRON_FIELD_RANGES`,
  `MAX_LOOKAHEAD_MINUTES`
- `cronScheduleTable`, `applyCronMigrations` (also from
  `@corbits/cron/migrations`)
- `resolveLiveDeployment`, `definitionExists`, `failStaleAnchorRun`,
  `isUnroutableRunTrigger`, `RUN_GRANTS_NOT_ROUTABLE`,
  `RUN_MAIL_NOT_ROUTABLE`

## Ticker

```ts
import {
  createCronTicker,
  createRunTriggerCronDeliver,
} from "@corbits/cron";

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

Claim: `SELECT ... FROM cron.schedule WHERE stopped_at IS NULL FOR UPDATE
SKIP LOCKED`. Due-ness is a JS check against `nextCronFireAfter`. Delivery
and the `lastFiredAt` update share the same transaction.

Overlapping ticks: `inFlight` is a single promise; `runTick` returns early
when one is already open.

## Unroutable codes

Structural match (not `instanceof`):

```ts
{
  code: "run_grants_not_routable" | "run_mail_not_routable",
  address: string,
  runId: string,
}
```

`failStaleAnchorRun(db, runId, now)`:

1. Read `sidecar_allocation` for `anchor_run_id = runId`.
2. No-op unless status is `released` or `failed`.
3. `UPDATE workflow_run SET status = 'failed', ended_at = now` only while
   the row is still in `liveWorkflowRunStatuses`.

The ticker then reports `onDeliveryError` and still writes `lastFiredAt`.

## CRUD

| Route | |
| --- | --- |
| `GET /api/tenants/:tenantId/cron` | List |
| `POST /api/tenants/:tenantId/cron` | Create (`expression`, `definitionName`, `subject`, `body`); 400 `invalid_body` / `invalid_expression` / `unknown_definition` |
| `DELETE /api/tenants/:tenantId/cron/:id` | 404 `not_found` if missing |

Every route is 403 `forbidden` when `requireTenantMember` is false.

## Schema

Postgres schema `cron`, table `schedule`. FK to `{tenantSchema}.tenant(id)`
(`public` in deployment, a scratch schema in tests). Advisory lock
`hashtext('corbits_cron')` around idempotent DDL.

## Cron grammar

Single 5-field Vixie/POSIX parser shared by validation and next-fire. Day
of week accepts 0 and 7 as Sunday; matching normalises 7 → 0. Reversed
ranges (`10-5`) and the reversed step idiom (`5/2-10`) are rejected.

## Development

```sh
git clone https://github.com/corbitsdev/corbits-cron.git
cd corbits-cron
bun install
bun run typecheck
bun run test
```

`bun run test` is `bun test ./src`. Drizzle ticker tests skip when
`DATABASE_URL` is unset; they migrate into a scratch schema and never touch
a real tenant table.
