# Contributing

## Development

```bash
git clone https://github.com/corbitsdev/corbits-cron.git
cd corbits-cron
bun install
bun run build
bun run typecheck
DATABASE_URL=postgres://localhost:5432/postgres bun run test
```

The `tests/` suites create and drop one database per suite, so `DATABASE_URL` needs a Postgres 13+ role with `CREATEDB`. They skip when `DATABASE_URL` is unset. `tests/upgrade-from-0.1.0.test.ts` migrates and writes with the published 0.1.0 package, then upgrades in place.

## Migrations

`migrations/*.sql` ship in the tarball and all run on every boot; there is no ledger. Every statement must be idempotent (`IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`). `"public".` references are rewritten to the host's `schema`.

## Internals

A tenant saves a cron expression, the agent to wake, and the mail to send it (`subject` / `body`). `createCronTicker` polls for due rows and hands each to the host's transport, so a schedule-triggered workflow is a `mail`-triggered one addressed at itself: at fire time the ticker mails `<run id>@<tenant domain>` for the definition's live anchor run.

Ticks claim due rows with `SELECT ... FOR UPDATE SKIP LOCKED`, so concurrent tickers never deliver one row twice.

Unroutable run triggers (`run_grants_not_routable` / `run_mail_not_routable`) fail a stale `running` anchor whose allocation already settled, so the next tick waits instead of retrying a dead address.
