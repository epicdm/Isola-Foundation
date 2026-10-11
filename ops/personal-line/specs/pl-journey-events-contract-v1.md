# Personal Line journey events — source contract v1 (plsvc → SeldonFrame), Lane A 2026-10-11

Scope: design §2 of `subscriber-account-slice-v1.md`, narrowed by PM `coord-pm-seldonframe-native-funnel-automations-personal-line-2026-10-11`
and the conformance audit `ev-lane-a-integration-conformance-audit-2026-10-11`. Receiver built in `epicdm/isola-seldonframe`
(branch `epic/personal-line-account-slice-2a-2026-10-11`); the plsvc sender (outbox + emitter) is NOT built yet.

## Transport (one route)
`POST {SeldonFrame}/api/webhooks/personal-line/{workspaceId}` — chosen over the packet's `/api/v1/events` and the spec's
`/api/v1/integrations/personal-line/events` because it follows the fork's own precedents: the inbound-webhook family
(`app/api/webhooks/composio|resend|stripe`) and the per-workspace webhook path (`app/api/v1/voice/openai/webhook/[orgId]`).

Headers: `X-PL-SF-Kid`, `X-PL-SF-Ts` (unix s), `X-PL-SF-Sig` = base64url(HMAC-SHA256(events key, `"<ts>.<raw body>"`)).
±300 s. The events key is that workspace's `personal-line-events` secret in `workspace_secrets` (set on the
settings/integrations "Personal Line" card). 503 not configured · 401 any signature failure · 422 invalid event ·
200 processed or duplicate · 409 identity conflict.

## Body (strict; unknown keys refused)
`{event_id: uuid, type, occurred_at: ISO, version: int ≥ 1, pl_account_id, wa_id, facts}`;
`facts` ⊆ `{plan, trial_end, registration_now, activated_at, first_call_at, did_masked}`.

## Types — each has exactly one valid source
| type | only valid source in plsvc | required proof fact |
|---|---|---|
| `pl.line_created` | explicit confirmed provisioning (`provisionLine` success) | — |
| `pl.app_activated` | first LIVE SIP registration (AMI listener, listenerConnected) | `registration_now=registered`, `activated_at` |
| `pl.registration_changed` | live registration state change | `registration_now` |
| `pl.first_call` | first ANSWERED call in the Magnus CDR | `first_call_at` |
| `pl.signup_started` | (R1 S-a) a verified WhatsApp sign-up began; **accepted by the receiver, no plsvc emitter yet** | — |
| `pl.trial_ending` | (R1 S-a) the trial's own end is near; **accepted, no plsvc emitter yet** | `trial_end` |
| `pl.trial_expired` | (R1 S-a) the trial's end has passed; **accepted, no plsvc emitter yet** | `trial_end` |
| `pl.plan_purchased` | provider-confirmed payment | `plan` — **type only; no emitter until a payment provider exists (Fiserv blocked)** |

Not PL events: a lead is the native intake form; an app link opened is NOT activation.

R1 S-a (fork commit `d0c76582`): the receiver now accepts all eight types (it answered 422 for `signup_started` / `trial_ending` /
`trial_expired` before). Projection of every type = one native activity entry + the bus event + the version-guarded fact merge;
NO deal move and NO probability (journey progress is not probability).

## Portal link (R1 S-c) - same workspace, same events key, its own MAC label
`POST {SeldonFrame}/api/webhooks/personal-line/{workspaceId}/portal-link`, body `{request_id: uuid, pl_account_id}` (exactly these keys),
headers as above but `X-PL-SF-Sig` = base64url(HMAC-SHA256(events key, `"pl-sf-portal-link-v1.<ts>.<raw body>"`)) - domain-separated, so an
event signature never opens this door. 503 not configured · 401 signature · 422 body · 409 `replayed_request` / `portal_unavailable` ·
404 `account_not_linked` · 429 `rate_limited` · 200 `{ok, url, expires_at}`. The URL (`/customer/<slug>/wa-link?token=`) is single use,
10 minutes, bound to the contact linked to that account, and is returned to plsvc only; plsvc hands it to the adapter, which posts it
into the verified sender's own WhatsApp conversation. Cross-repo signing vector: key `portal-link-vector-key-0123456789abcdef`,
ts 1800000000, body `{"request_id":"0b6f2c1e-6a51-4d6e-9d8e-1f2a3b4c5d01","pl_account_id":"accA"}` -> `BddSF9Da7uXkNRLoZ-uuZtvWtJavVcusObqDBWuWzdY`.

## Receiver semantics (verified by unit tests; staging proof in the status file)
- Dedupe: `integration_event_inbox (org_id, provider, event_id)` — a duplicate is a no-op 200; an unfinished claim is
  re-claimable after 30 s.
- Ordering: `integration_subject_facts` merges facts only when `version > last_version`; an older version never
  overwrites newer facts. A stale `pl.registration_changed` is not announced on the bus; stale milestones still are (once).
- Identity: the subscriber's contact is reached ONLY through `external_identities` (written only here, never by forms,
  chat, email or a matching phone). A first event for an account creates a NEW contact with the verified wa_id.
- Projection: one native activity (timeline) per event + `emitSeldonEvent(type, …)` → `workflow_event_log` + native
  automations; `pl.*` are in the automation trigger suggestions. **No deal/probability change** (journey is not
  probability; forward-only stage moves are a later slice).

## Sender obligations (plsvc, NOT BUILT)
`sf_event_outbox` row written in the same transaction as the engine change; delivery with retry + backoff;
`version` monotonic per account; a backfill command that replays current state as events (also how lines that
pre-date the integration get linked).
