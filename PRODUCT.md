# @corbits/cron — Product

## What it is

Cron schedules for an Interchange hub. A tenant saves a cron expression, the
agent to wake (by workflow definition name), and the mail to send it
(`subject` / `body`). `createCronTicker` polls for due rows and hands each to
the host's transport, so a schedule-triggered workflow is a `mail`-triggered
one addressed at itself.

## Why it exists

Hubs need a first-class way to wake an agent on a clock without the host
owning cron parsing, due-row claiming, or the wait-versus-stop rules when an
agent is between runs. Delivery is mail the host already knows how to send;
this package owns the schedule and the tick, not the socket.

## Who it is for

Interchange hub operators who already have a tenant app, a Postgres database
with Interchange's `tenant` / workflow tables, and a run-trigger mail
deliverer (the same shape `@corbits/webhooks` uses).

## What users can do

- Save, list, and delete a tenant's schedules at
  `/api/tenants/:tenantId/cron`.
- Point a ticker at those rows so a due schedule mails the agent's current
  live run (`<run id>@<tenant domain>`).
- Keep a schedule waiting when the agent exists but has no live run (a hub
  restart), and have it fire again when the run comes back.
- Stop a schedule only when the targeted agent is deleted — a later redeploy
  does not resume it.
- Have an unroutable run trigger (`run_grants_not_routable` /
  `run_mail_not_routable`) fail a stale `running` anchor whose sidecar
  allocation already settled, so the next tick waits instead of mailing the
  dead run every minute.

## Non-goals

- This package does not invent a sender address. Only the host knows which
  addresses its mail transport authorizes; the ticker names the tenant and
  the `to` list, never a from.
- It does not depend on `@corbits/webhooks`. `createRunTriggerCronDeliver`
  is structurally compatible with that package's deliverer so a host can
  reuse one, not so this package imports it.
- It is not a general-purpose cron daemon, timezone catalog, or job queue
  outside Interchange mail.

## License

LGPL-2.1-only.
