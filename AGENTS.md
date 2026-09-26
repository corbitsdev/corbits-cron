# AGENTS.md

## Purpose

`@corbits/cron` stores a tenant's cron schedules on the Interchange hub and
wakes agents on them. It owns the `cron` Postgres schema, the grant-gated
schedule routes and the ticker that turns a due row into run-trigger mail. It
does not own mail transport, run lifecycle or grants; those come from the host.

## Layout

- `src/cron.ts` — the one five-field UTC cron parser, used for validation and matching.
- `src/routes.ts` — `createCronRoutes`, CRUD over a tenant's schedules.
- `src/ticker.ts` — `createCronTicker`, polls due rows and hands each to the transport.
- `src/deliver.ts` — the system-trigger deliverer for schedule mail.
- `src/deployment.ts` — resolves a schedule's agent to its live anchor run at fire time.
- `src/schema.ts` — the `cron` schema's one table.
- `src/migrations.ts` — `runCronMigrations`, applies `migrations/*.sql`.
- `src/index.ts` — the only module consumers import from.
- `e2e/` — real-Postgres suites, including the 0.1.0 upgrade test.

## Rules

- A schedule names an agent by definition name; the run is resolved at fire time, never stored.
- The ticker mails `<run id>@<tenant domain>` for the definition's live anchor run.
- Ticks claim due rows with `SELECT ... FOR UPDATE SKIP LOCKED`, so concurrent tickers never deliver one row twice.
- A schedule that missed several ticks fires once for the latest due minute.
- Unroutable run triggers (`run_grants_not_routable` / `run_mail_not_routable`) fail a stale `running` anchor whose allocation already settled, so the next tick waits instead of retrying a dead address.
- Every migration statement is idempotent; there is no ledger.
- The acting tenant comes from the host context, never from a path parameter.

## Local development

```sh
bun install && bun run check
```
