# Notification outbox drain — Replit Scheduled Deployment wiring

`POST /api/internal/notify-drain` runs the NotificationOutbox drain worker
(`lib/notify-drain.ts`) once per call: claim due rows, send via the channel
adapter, record sent/failed/dead_letter. It is NOT wired to a scheduler by
this PR — nothing runs automatically until the steps below are done.

Same wiring pattern as `app/api/internal/voicemail-poll` — a plain
authenticated POST endpoint, scheduler-agnostic (works with a Replit
Scheduled Deployment, cron+curl, or any other external trigger without code
changes).

## 1. Secrets (Replit → this app's Secrets pane)

| Secret | Purpose |
|---|---|
| `NOTIFY_DRAIN_ENABLED` | Must be exactly `true` to un-403 the route. Leave unset/false until ready. |
| `NOTIFY_DRAIN_TOKEN` | Bearer token the Scheduled Deployment sends. Generate a random 32+ byte value — do NOT reuse `VOICEMAIL_POLL_TOKEN` or any other existing secret. |
| `NOTIFY_OUTBOX_ENABLED` | Set to `true` only when ready to have producers (e.g. the voicemail-catch owner alert in `lib/voicemail-poller.ts`) enqueue into NotificationOutbox instead of sending directly. Defaults OFF — existing direct-send behavior is unchanged while this is off. |

## 2. Create the Scheduled Deployment

In the Replit UI (or via Replit's deployment API/CLI once available in this
environment):

1. New Deployment → type **Scheduled**.
2. Command: a one-liner that POSTs to this route with the bearer token, e.g.
   ```bash
   curl -sS -X POST "$APP_BASE_URL/api/internal/notify-drain" \
     -H "Authorization: Bearer $NOTIFY_DRAIN_TOKEN" \
     -o /dev/null -w "%{http_code}\n"
   ```
   (`$APP_BASE_URL` and `$NOTIFY_DRAIN_TOKEN` as Scheduled Deployment
   secrets/env, matching the app's own values above.)
3. Schedule: `*/5 * * * *` (every 5 minutes — matches the voicemail-poll
   cadence).
4. Confirm the deployment's outbound network path can reach this app's
   public URL.

## 3. Verify before relying on it

- Flip `NOTIFY_DRAIN_ENABLED=true`, leave `NOTIFY_OUTBOX_ENABLED=false`.
- Trigger one manual run (or `curl` the route by hand with the token) and
  confirm `{ "ok": true, "result": {...} }` with `claimed: 0` (nothing
  enqueued yet, since no producer is flag-on).
- Only then flip `NOTIFY_OUTBOX_ENABLED=true` and confirm a real missed-call
  owner alert produces a `NotificationOutbox` row that transitions
  `pending` → `sending` → `sent` with an `external_ref` on the next drain
  run, and that the WhatsApp message actually lands.
- If a send is expected to fail (e.g. a bad template name), confirm the row
  goes `failed` with a `next_attempt_at` in the future and a non-empty
  `failure_reason`, and that it eventually reaches `dead_letter` after
  `max_attempts` (5) unsuccessful tries rather than retrying forever.
