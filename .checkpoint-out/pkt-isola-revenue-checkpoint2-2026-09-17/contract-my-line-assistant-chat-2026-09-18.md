# My Line Assistant (in-app chat) — backend contract — ACKNOWLEDGED v1 — 2026-09-18

Authority: `execution_plan/directive-personal-line-support-agent-chat-2026-09-18`
(isola-current-plan v7.30, line 15). Supersedes anything either session heard
about a retracted contract, `/api/lite/chat/send`, or an `X-Internal-Secret`
finding — none of that came from verified inspection and none of it is used
below. Everything in this file was read directly, this session, from the
commit named. **Not yet acknowledged by LINE — do not wire UI to this until
LINE confirms the same revision.**

## Base

- Repo: `epicdm/isolav2`. Branch: `deploy/bffv2-prod-2026-09-15` (the deployed
  trunk, per `reference_bffv2_origin_remote_is_not_isolav2`).
- HEAD read from: `7b29963c` ("Merge PR #179: Acrobits Custom Tab entry
  endpoint").
- AGENT's worktree: `C:\epic-workspace\_wt-bffv2-assistant-chat-backend-2026-09-18`,
  branch `feat/bffv2-assistant-chat-backend-2026-09-18`.

## What already exists — verified by direct read, not assumed

- `app/api/chat/route.ts` (lines 72–131) — a REAL, already-deployed PWA chat
  route DOES exist (this corrects an earlier claim that no chat route exists
  anywhere — that claim only checked `app/api/lite/*`; this route lives at
  `app/api/chat/`, outside that tree). Its PWA branch (`X-Isola-Phone` header
  present) is gated by `validateInternalSecret` (`app/lib/internal-auth.ts`)
  — i.e. it expects a SERVER-SIDE caller (a proxy holding the secret after
  validating its own session), never a browser/app holding the secret
  directly. **We do not reuse this route** — see "Why a new route" below.
- `app/lib/lite-concierge.ts:4268` — `getConciergeReply(phone, text)` — the
  real, single brain both WhatsApp and the existing `/api/chat` PWA path use.
  Confirmed it: loads/saves the shared `ConciergeContext` (keyed by phone),
  runs `reconcileIdentity()` every turn (refuses on ambiguous phone
  ownership — `PWA_TO_WHATSAPP_LINE`), handles deterministic persistent-mode
  actions (balance, call, top-up, upgrade, rates), and falls through to an
  LLM reply (legacy DeepSeek, or AgentOS via `pwaReplyViaEngine` →
  `conciergeEngineReply` in `agentos-engine.ts` when the concierge Agent row
  has an explicit engine binding — unconfirmed whether any binding is live
  today; `pwaReplyViaEngine`'s own comment says it is reply-only and does not
  call `escalate()` or `ensureConciergeConversation()`).
- `app/lib/lite-auth.ts:86` — `resolveLiteAccount(cookie, u, k)` — the
  canonical Lite identity resolver already used by `/api/lite/calls`,
  `/api/lite/wallet`, etc. Session cookie first (no credential in transit),
  `u`/`k` fallback. Returns `{accountId, sipUsername}` from ONE row, by
  primary key — not an `ownerPhone` lookup, so it does not hit the
  multi-holder ambiguity `lite-owner-phone.ts` documents at length.
- `prisma/schema.prisma:261` — `WhatsAppMessage` (`agentId, phone, role,
  content, timestamp, sessionType`) — the durable transcript table, already
  what `handleConciergeMessage` (WhatsApp webhook) writes to via
  `recordConciergeMessage` + `mirror()` (Chatwoot sync).
- `prisma/schema.prisma:249` — `Conversation.supervisionMode`
  (`ai_active`/`owner_active`) — the live human-takeover state, re-read on
  every WhatsApp send via `sendTimeGateAllowsFor` (`lite-concierge.ts:704`).
- `app/lib/webhook/ingress.ts:211` — `checkDedup(key: string)` — generic
  atomic `INSERT ... ON CONFLICT DO NOTHING` on `inbound_dedup`, not
  Meta-specific; takes any string key.

## THE GAP — why `getConciergeReply` cannot be called bare

Traced `getConciergeReply`'s legacy branch (no AgentOS binding — the
production default; binding is written only by an endpoint documented as
"not yet authorised", `agentos-engine.ts:61`) end to end:

- The onboarding branch (line ~4464) and the persistent-mode LLM fallback
  branch (line ~4447) both `return` a plain string. Neither calls
  `recordConciergeMessage` nor `mirror()` — confirmed by grepping every call
  site of `recordConciergeMessage(..., 'user', ...)`: there is exactly ONE,
  inside `handleConciergeMessage` (the WhatsApp webhook, line 2161).
  `getConciergeReply` never calls it.
- Neither branch checks `Conversation.supervisionMode` at all. The
  `owner_active` suppression only exists inside `pwaReplyViaEngine`'s
  AgentOS branch (`sendTimeGateAllowsFor` via `conciergeEngineReply`'s
  `deps.gateAllows`), which the legacy branch never reaches.

**So, as deployed today: calling `getConciergeReply` from a new surface
would (a) never persist or mirror either side of the turn to the shared
transcript/Chatwoot, and (b) let the AI answer even while a human has
`owner_active` on the WhatsApp side of the SAME conversation.** This is a
real defect in the currently-shipped `/api/chat` PWA path too, not something
new introduced by this feature.

REVISED (after implementation design): closing this does NOT require editing
`lite-concierge.ts` at all. Every primitive needed is already exported from
it — `getConciergeAgent()`, `ensureConciergeConversation()`,
`recordConciergeMessage()`, `mirror()`, `getConciergeReply()` — so the new
route WRAPS `getConciergeReply` with the missing takeover-check and
record/mirror calls at the route level, using those exports exactly as
designed, rather than modifying the shared function's internals. Lower risk
(zero change to code every other caller, including `/api/chat`, depends on)
for the identical safety property. `/api/chat`'s PWA path is NOT fixed by
this delta — it is a pre-existing, separately-owned defect, named here but
out of this packet's scope (not mine to touch — Lane A/whoever owns that
route can apply the same wrapper pattern).

## Why a new route (not reusing `/api/chat`)

`/api/chat`'s PWA branch is designed for a caller that already holds
`X-Internal-Secret` server-side (a proxy in front of it). Requirement: never
expose that secret to the client. Rather than build a second proxy tier, the
new endpoints below live in the SAME `app/api/lite/*` tree, using the SAME
`u`/`k` + `lite_sess` cookie convention every other Lite route already uses
— no secret changes hands with the client at all, because the phone is
resolved server-side, in-process, from the authenticated `LiteAccount` row,
and `getConciergeReply` is called as a plain function import (no HTTP hop,
no bearer).

## The two endpoints

### `GET /api/lite/assistant/history?u=&k=&limit=`
- Auth: `resolveLiteAccount` (cookie or u/k) — same as `/api/lite/calls`.
- Scope: `WhatsAppMessage` where `agentId=<concierge agent id>`,
  `phone=account.ownerPhone`, `sessionType='customer'`, ordered by
  `timestamp` asc, capped at `limit` (default 50, max 200). This scoping
  inherently excludes staff private notes (`mirrorStaffNote` never calls
  `recordConciergeMessage` — confirmed) and other customers (phone-scoped).
- 200: `{ messages: [{id, role:'user'|'assistant', text, at}], supervisionMode, handoffActive }`.
- 401 unauthenticated. `handoffActive = supervisionMode === 'owner_active'`.

### `POST /api/lite/assistant/message`
- Auth: same resolver, `lite_sess` cookie checked FIRST via
  `req.cookies.get(LITE_SESSION_COOKIE)?.value` (confirmed live: minted by
  `app/api/lite/wa-open/route.ts:96-97` on WhatsApp one-tap sign-in), `u`/`k`
  accepted as optional fields in the JSON BODY as fallback — never query
  params on a POST, matching `topup/start`/`billpay/pay`'s convention.
  (Note: `billpay/pay` calls `resolveLiteAccount(null, ...)` — it never
  actually reads the cookie despite being "cookie-capable". Not repeated
  here.)
- Body: `{ u?: string, k?: string, text: string, clientMessageId: string }` —
  `clientMessageId` is a UUID the client mints once per send attempt and
  resends unchanged on retry.
- Identity: `phone` is read ONLY from the authenticated account's own
  `ownerPhone` — never from the request body. `getConciergeReply`'s own
  `reconcileIdentity()` independently re-verifies binding and refuses
  (`PWA_TO_WHATSAPP_LINE`) on ambiguity — reused unmodified.
- Dedup: `checkDedup(`lite-assistant:${accountId}:${clientMessageId}`)` — a
  replayed `clientMessageId` returns the previously recorded reply instead
  of re-invoking the LLM or re-mirroring.
- Takeover: read `Conversation.supervisionMode` for `(agentId, phone)`
  BEFORE calling `getConciergeReply`. `owner_active` → `{state:
  'awaiting_human'}` immediately — no LLM call, no record, no mirror,
  nothing to duplicate. Re-checked again AFTER the reply (same pattern as
  `say()`'s `sendTimeGateAllowsFor`) before recording — a human can take
  over mid-generation.
- On success: records BOTH turns to `WhatsAppMessage` (direct
  `prisma.whatsAppMessage.create`, not `recordConciergeMessage` — that
  helper discards the created row, and the route needs the id/timestamp
  back for the response) and mirrors both via the exported `mirror()` (the
  fix from "THE GAP" above, applied at the route level — see REVISED note).
- 200: `{state:'replied', reply:{id, role:'assistant', text, at}}` |
  `{state:'awaiting_human'}` | `{state:'failed', retryable: boolean}`.
- 401 unauthenticated · 400 missing `text`/`clientMessageId` · 404 account
  has no `ownerPhone` yet (never provisioned — UI should point at WhatsApp
  onboarding, same redirect `getConciergeReply` itself already gives a
  fresh visitor).

## What this does NOT do

No `sendWhatsAppMessage`/Meta call anywhere in this path — an in-app
question can never cause a duplicate outbound WhatsApp message. No new
runtime, no second bot: same `ConciergeContext`, same `WhatsAppMessage`
rows, same Chatwoot conversation the WhatsApp channel already owns for this
phone. No escalation-trigger detection added (matches `pwaReplyViaEngine`'s
existing reply-only contract) — anything needing a human already gets
`PWA_TO_WHATSAPP_LINE`/`awaiting_human`, which points at WhatsApp, where the
real takeover contract lives.

## Acknowledgment

- [x] AGENT (this session) — implemented against this exact revision.
  Backend candidate: `epicdm/isolav2` PR #180 (draft, NOT merged/deployed),
  branch `feat/bffv2-assistant-chat-backend-2026-09-18`, HEAD `faecfc6f`,
  based on `deploy/bffv2-prod-2026-09-15` @ `7b29963c`. 15 focused tests
  green, `tsc` clean on the new files.
- [x] LINE (isola-foundation-98) — confirmed final. UI aligned:
  `epicdm/isola-mobile` commit `e5045fe58b96ed3e782ced79730ac4af548bc72b`,
  PR #15 (held from merge by Lane A pending this backend landing), 24/24 new
  UI checks pass, 105/105 existing pass. Recorded jointly in Port:
  `dec-assistant-chat-contract-jointly-agreed-2026-09-18` (Ratified,
  `decided_by` both sessions explicitly).

## Auth clarification (added after LINE's question, resolved before
## implementation — see the POST endpoint section above for the final shape)

Confirmed `lite_sess` IS a real, live cookie (minted by
`app/api/lite/wa-open/route.ts:96-97`). Found, in passing, that
`app/api/lite/billpay/pay/route.ts` calls `resolveLiteAccount(null, ...)` —
it never actually reads the cookie despite using the cookie-capable
resolver. Not fixed here (not this packet's lane), named so it is not
rediscovered.
