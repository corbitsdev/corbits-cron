# @corbits/cron — Architecture

## Shape

Two faces, one table. The CRUD mount writes schedules; the ticker turns due
rows into mail. The live run behind a definition name changes on every
restart and redeploy, so the address is resolved at fire time, never stored.

```
tenant CRUD  ──▶  cron.schedule
                      │
                      ▼
              createCronTicker
                      │
         ┌────────────┼────────────┐
         ▼            ▼            ▼
   live deployment  waiting     stopped
   → host deliver   (no run,    (agent
                    def exists)  deleted)
```

Mount absolute routes on the host app (`/api/tenants/:tenantId/cron`), never
a sub-router under a prefix.

## Ticker

Each tick runs in one transaction:

1. Select unstopped rows `FOR UPDATE SKIP LOCKED`. Two tickers racing the
   same table split due rows rather than double-fire.
2. Decide due in process: a row is due at the first matching minute after
   `lastFiredAt` (or `createdAt` if never fired). A missed window fires once
   for the most recent due minute, never once per missed tick. An expression
   with no fire in the lookahead window is never due.
3. Resolve the live deployment for `definitionName`. The mail local part is
   the anchor run id (`id = anchor_run_id`) of a live-status run, newest
   first; the domain comes from the tenant.
4. No live run, definition still there: set `waitingSince` once (not every
   tick spent waiting) and continue. No definition: set `stoppedAt` /
   `stoppedReason = agent_deleted` and never fire that row again.
5. Deliver. One schedule's failed delivery is its own — the tick still
   advances every due row (`lastFiredAt` now, `waitingSince` cleared) so a
   permanently undeliverable schedule cannot block the table or re-fire
   every minute forever.

`start()` is interval-based. A tick still in flight skips the next interval
rather than overlapping. `stop()` clears the timer; it does not cancel an
in-flight tick.

## Unroutable run triggers

The deliverer — not this package — rejects a deployment address that has no
live socket and no disconnect queue. The contract is owned by
`@corbits/webhooks` and matched structurally here so cron stays
dependency-free:

- `run_grants_not_routable`
- `run_mail_not_routable`

When `deliver` throws one of those (an object with `code`, `address`, and
`runId`), the ticker fails the named stale anchor **if** that run's sidecar
allocation already settled `released` or `failed`. A previous stack's death
leaves exactly this behind: a `running` anchor with a dead sidecar. Until
something marks the row terminal, every tick would keep delivering into the
dead run.

The error is still reported via `onDeliveryError` — it is a real delivery
failure, once, not tick noise. After the anchor is terminal, `resolveLiveDeployment`
returns null on the next due minute; the definition still exists, so the
schedule waits for the agent to come back.

If the allocation is still active, missing, or the run is already terminal,
`failStaleAnchorRun` is a no-op. The schedule still advances `lastFiredAt`.

## Host seams

| Seam | Role |
| --- | --- |
| `db` | Drizzle Postgres handle over Interchange tables plus `cron.schedule`. |
| `deliver` | Host mail. Receives `to`, `subject`, `body`, `tenantId`. |
| `requireTenantMember` | Gate on every CRUD route. |
| `onDeliveryError` | Host reporting for a failed `deliver`. |
| `onScheduleStopped` | Once, when the targeted agent is deleted. |
| `onScheduleWaiting` | Once each time a schedule starts waiting, not every waiting tick. |

`createRunTriggerCronDeliver` fans `message.to` over a `RunTriggerDeliverer`
(`to(address, body, tenantId, subject)`), the same shape as webhooks'
system-trigger deliverer.

## Persistence

Custom tables live on their own Postgres schema. `cron.schedule` holds
expression, definition name, subject, body, `lastFiredAt`, `waitingSince`,
`stoppedAt` / `stoppedReason`, and a real FK to Interchange `tenant` with
`ON DELETE CASCADE`. Migrations are idempotent and advisory-locked so
concurrent hub replicas cannot race the same DDL.
