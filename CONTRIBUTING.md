# Contributing

## Internals

A tenant saves a cron expression, the agent to wake, and the mail to send it (`subject` / `body`). `createCronTicker` polls for due rows and hands each to the host's transport, so a schedule-triggered workflow is a `mail`-triggered one addressed at itself: at fire time the ticker mails `<run id>@<tenant domain>` for the definition's live anchor run.

Ticks claim due rows with `SELECT ... FOR UPDATE SKIP LOCKED`, so concurrent tickers never deliver one row twice.

Unroutable run triggers (`run_grants_not_routable` / `run_mail_not_routable`) fail a stale `running` anchor whose allocation already settled, so the next tick waits instead of retrying a dead address.
