# Voicemail poll — Replit Scheduled Deployment wiring

`POST /api/internal/voicemail-poll` runs the per-tenant voicemail poller
(`lib/voicemail-poller.ts`) once per call. It is NOT wired to a scheduler by
this PR — nothing runs automatically until the steps below are done.

Owner decision (2026-07-15): use a **Replit Scheduled Deployment**, not
Inngest (the mechanism Isola Lite uses in production on deepseek). This
route is deliberately scheduler-agnostic — it's a plain authenticated POST
endpoint — so it works with a Scheduled Deployment, Inngest, cron+curl, or
any other external trigger without code changes.

## 1. Secrets (Replit → this app's Secrets pane)

| Secret | Purpose |
|---|---|
| `VOICEMAIL_POLL_ENABLED` | Must be exactly `true` to un-403 the route. Leave unset/false until ready. |
| `VOICEMAIL_POLL_TOKEN` | Bearer token the Scheduled Deployment sends. Generate a random 32+ byte value — do NOT reuse `ISOLA_AGENT_TOOLS_TOKEN` or any other existing secret. |
| `VOICE00_SSH_HOST` | voice00 SSH host (defaults to `voice00`; set to the real reachable host/IP if this app's network can't resolve that hostname). |
| `VOICE00_SSH_USER` | voice00 SSH user (defaults to `epicdm`). |
| `VOICEMAIL_CATCH_DELIVER` | Set to `true` only when ready to actually send WhatsApp alerts to `Tenant.owner_phone`. Defaults OFF — the poller will store catches but not deliver. |
| `VOICEMAIL_CATCH_TEMPLATE` | Optional override for the WA template name. Defaults to `isola_missed_call_alert` (same template Lite uses — confirm it's approved on each tenant's WABA before flipping `VOICEMAIL_CATCH_DELIVER` on). |

**Prerequisite not covered by this PR:** the Replit Repl (or wherever this
route runs) needs outbound SSH reachability to voice00 with a key already
trusted there, exactly like the deepseek bff-v2 host has today. If Replit's
network can't reach voice00 directly, this route will error on every poll
(`ls`/`cat`/`base64` over SSH will fail) — that's a network/access
prerequisite to confirm before enabling, not something this code can paper
over.

## 2. Create the Scheduled Deployment

In the Replit UI (or via Replit's deployment API/CLI once available in this
environment):

1. New Deployment → type **Scheduled**.
2. Command: a one-liner that POSTs to this route with the bearer token, e.g.
   ```bash
   curl -sS -X POST "$APP_BASE_URL/api/internal/voicemail-poll" \
     -H "Authorization: Bearer $VOICEMAIL_POLL_TOKEN" \
     -o /dev/null -w "%{http_code}\n"
   ```
   (`$APP_BASE_URL` and `$VOICEMAIL_POLL_TOKEN` as Scheduled Deployment
   secrets/env, matching the app's own values above.)
3. Schedule: `*/5 * * * *` (every 5 minutes — matches the Lite Inngest cron
   cadence this replaces).
4. Confirm the deployment's outbound network path can reach this app's
   public URL.

## 3. Verify before relying on it

- Flip `VOICEMAIL_POLL_ENABLED=true`, leave `VOICEMAIL_CATCH_DELIVER=false`.
- Trigger one manual run of the Scheduled Deployment (or `curl` the route
  by hand with the token) and confirm `{ "ok": true, "result": {...} }`
  with `tenantsScanned` >= 1 for a tenant that has `magnus_sip_username`
  set.
- Check a `TenantVoicemailCatch` row was created for any real voicemail on
  voice00 for that tenant.
- Only then flip `VOICEMAIL_CATCH_DELIVER=true` and confirm the WA alert
  actually lands on `Tenant.owner_phone` for a real test call — SHA/config
  claims are not "done" without that live-path check (per this project's
  zero-guessing doctrine).

## Known gaps carried over from this PR (see also PR description)

- No `scripts/transcribe_otp.py` exists in this repo yet — `lib/voicemail-catcher.ts`
  degrades gracefully (empty transcript → unconfident catch) until that
  script is ported over from deepseek `/opt/bff-v2/scripts/transcribe_otp.py`.
- No consent gate on the outbound WA delivery (see commit message on
  `lib/voicemail-poller.ts` for the reasoning — owner-self-notification,
  not customer marketing).
- No per-tenant voicemail quota/counter (Lite's `aiCatchesUsed` /
  `aiCatchesResetAt` free-allowance model was deliberately not ported).
