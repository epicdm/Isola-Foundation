# R2 Phase 2A — Current BFF ↔ v1.8.3 Contract (2026-07-24)

Per `xp-clawith-r2-epic-tenant-cutover-and-legacy-inventory` Phase 2A. Read
directly from the live deployed source (`/opt/bff-v2` on deepseek,
commit `9eed9463` / branch `feat/isola-bridge-v11-staged-client`, itself
built on `fix/bffv2-retire-dashboard-reseller-campaigns-broadcast`) and the
live `isolav2` Postgres database (port 5433). All values below are masked.
Nothing in this document changes production behavior.

## 0. Correction to a prior canonical document

`CLAWITH-R16-3742-TRUTH-PROOF.md` section B (2026-07-24, "CORRECTED")
concludes that 3742's live customer-facing processor is bff-v2's own
`session-detector.ts` → `handleCustomer()` path (native Anthropic Claude
call, zero v1.8.3 dependency). A live query of `tenant_registry` run for
this packet contradicts that conclusion:

```
tenantId   = 8166ea11-8db0-4f26-879a-e2067be0a018
businessName = "EPIC Communications Inc"
waPhoneNumberId = 975632242309171   (masked ...9171 — 3742)
containerUrl    = http://127.0.0.1:8800/api/internal/dispatch
clawithAgentId  = 8166ea11-8db0-4f26-879a-e2067be0a018   (same id, "EMA")
nativeChatwoot  = false
status          = active
```

`app/api/whatsapp/webhook/route.ts`'s `resolveTenant(incomingPhoneId)` is a
direct cache-first lookup against this exact table, keyed on the
`waPhoneNumberId` that was messaged. Because 3742 has an **active** row
here, every inbound message to 3742 takes the `if (tenant)` branch (route.ts
~L336) and — since `containerUrl` ends with `/api/internal/dispatch` and
`nativeChatwoot` is `false` — is routed to `dispatchInboundToClawith()`
(route.ts ~L479-494), **not** to `detectSession()`/`handleCustomer()`. The
session-detector path is only reached for phone_number_ids that have **no**
`tenant_registry` row at all (BFF's own directly-registered agents); 3742 is
not one of those.

**This session's own bug-fix work corroborates this**: the three
attribution bugs fixed and closed under Phase 0 (concierge stickiness,
missing inbound persistence, non-deterministic agent resolution) were all
found and fixed *inside* `dispatchInboundToClawith()` and its immediate
callers, and directly resolved real production symptoms on live 3742
traffic. That would not have been possible if this were dead code for 3742.

**Conclusion carried forward into this document and into Phase 2B:** the
real, live, revenue-bearing dependency this packet exists to replace is
`dispatchInboundToClawith() → dispatchToClawith() → http://127.0.0.1:8800/api/internal/dispatch`.
The R16 doc's section B should be treated as superseded for 3742
specifically; its section A (Meta/WABA webhook-ownership proof) and
section C (Rex / legacy-EMA channel-config rows being dormant) are
unaffected by this correction and still stand.

## 1. Endpoint and authentication

- **Endpoint:** `POST {tenant.containerUrl}` — for EPIC/3742,
  `http://127.0.0.1:8800/api/internal/dispatch` (v1.8.3, same host as BFF).
- **Auth:** static bearer token, `Authorization: Bearer ${BFF_CLAWITH_SHARED_SECRET}`
  (BFF env var, one shared secret for all tenants dispatched this way —
  not tenant-scoped, not rotated per-tenant).
- **Timeout:** 60,000 ms (`AbortSignal.timeout(60000)` in
  `dispatchToClawith()`, `app/lib/clawith-dispatch.ts`) — sized for LLM
  latency, no retry on timeout (surfaces as `ClawithDispatchError(0, ...)`).

## 2. Request schema (masked example)

```json
{
  "agent_id": "8166ea11-...e018",
  "paperclip_agent_id": "<resolved live per-message, see §5>",
  "paperclip_company_id": "<tenant.paperclipCompanyId>",
  "user_text": "Hi, do you have availability this week?",
  "user_id": "1767***111",
  "session_id": "8166ea11-...e018:1767***111",
  "history": [ { "role": "user", "content": "..." }, { "role": "assistant", "content": "..." } ],
  "caller_phone": "1767***111",
  "owner_phone": null,
  "odoo_url": "http://127.0.0.1:8069",
  "odoo_db": "epic",
  "odoo_login": "agent_epic@isola.internal",
  "odoo_password": "<agentOdooPasswordRef, opaque>"
}
```

- `agent_id` = `tenant.clawithAgentId` (deterministic since the Phase 0 fix;
  previously an unordered `findFirst`).
- `session_id` is **message-scoped** in practice (`tenantId:fromPhone`), and
  `history` is an **in-process, non-persisted** rolling buffer
  (`getUserHistory`/`appendUserMessage`, keyed by the same string) — it does
  not survive a BFF process restart. This is the current, real behavior for
  conversational continuity, not a design choice being proposed forward.
- `odoo_*` fields are populated only when `tenant_registry.odooDb` and
  `agentOdooPasswordRef` are both set; otherwise omitted entirely (no Odoo
  context sent, and v1.8.3 is expected to run without it in that case).

## 3. Response schema (masked example)

```json
{
  "draft": "Hi! Yes, we have Tuesday and Thursday afternoons open this week...",
  "soul_codepoints": 4821,
  "skills_count": 3,
  "skills": [ "..." ],
  "errors": []
}
```

- `draft` is the only field BFF actually uses to build a customer reply
  (after a BFF-side cleanup pass, see §6).
- `soul_codepoints`/`skills_count`/`skills` are logged, not otherwise acted
  on by BFF.

## 4. Tenant / agent identity resolution (BFF side, deterministic since Phase 0)

```
agent = ownerAgent
     ?? (tenant.clawithAgentId ? Agent.findFirst({ id: tenant.clawithAgentId }) : null)
     ?? Agent.findFirst({ tenantId: tenant.tenantId })   // legacy fallback only
```

`ownerAgent` (the message sender IS the configured owner phone, scoped to
the exact number messaged) short-circuits to a completely separate
owner-router path (Hermes queries, brief-approvals, probation replies) and
**never reaches `dispatchToClawith()` at all** for text messages — only
non-text owner messages (audio, interactive) fall through to dispatch,
where the runtime is expected to detect `caller_phone == owner_phone` itself
and adjust its persona accordingly (role=owner vs role=customer is **not**
a separate field in the request body — the v1.8.3 runtime infers it from
comparing `caller_phone` to `owner_phone`, both of which are sent on every
call regardless of who's asking).

## 5. Odoo context — ownership

BFF resolves and forwards Odoo connection details (§2) but does **not**
call Odoo itself for this path; v1.8.3 is the system that actually talks to
the tenant's Odoo instance using the forwarded login/password. BFF only
knows *whether* to forward them (based on `tenant_registry` columns being
populated), not what happens inside v1.8.3 once it has them.

## 6. Tools, approvals, quota boundaries

Not visible to BFF at all in this contract. `agent.approvalMode` (`'auto'`
vs `'confirm'`) is a **BFF-side** gate applied *after* v1.8.3 returns a
draft — it does not affect what v1.8.3 is allowed to do internally, only
whether BFF sends the resulting draft straight to the customer (`'auto'`)
or holds it back for a human operator in Chatwoot (`'confirm'`, no
MessageDraft/approval-card flow — that was retired; Chatwoot is now the
sole supervisor surface). Whatever tool-use, quota, or approval logic
exists *inside* v1.8.3 is entirely opaque to BFF and to this contract —
BFF has no visibility into it and enforces nothing itself beyond the
auto/confirm gate.

**Known legacy leakage BFF has to work around:** the LLM inside v1.8.3
sometimes hallucinates bracketed tool-call-like annotations
(e.g. `[ask_owner: ...]`) into `draft` despite prompt-level prohibition.
BFF strips these deterministically (`stripDraftAnnotations()`) before
either sending or holding the draft — this is a customer-facing-leak
guard, not a designed part of the contract, and is direct precedent for
why the v1.11-native client (Phase 2E) treats every upstream response as
untrusted and typed rather than assuming `draft`/`reply` is always
customer-safe as-is.

## 7. Persistence ownership

| Data | Owner | Mechanism |
|---|---|---|
| Inbound customer message row | **BFF** | `prisma.whatsAppMessage.create()` inside `dispatchInboundToClawith()`, added under the Phase 0 fix — v1.8.3 never writes to BFF's DB |
| Outbound reply row / send record | **BFF** | via `sendWhatsAppMessage()` → `dispatchToMeta()`'s own gated-send/audit path |
| Short-term conversational memory | **BFF, in-process only** | `getUserHistory`/`appendUserMessage`, keyed `tenantId:phone`, not durable |
| SOUL / skills / persona content | **v1.8.3** | fetched server-side inside v1.8.3 using `paperclip_agent_id`; BFF never sees this content, only receives the rendered `draft` |
| Dead-letter record on failure | **BFF** | `persistDeadLetter()`, `dead_letter` table |

## 8. Outbound (Meta) ownership

100% BFF. v1.8.3 never calls Meta directly — it only returns `draft` text;
`sendDispatchDirect()` → `sendWhatsAppMessage()` (`app/lib/whatsapp.ts`) is
what actually calls `dispatchToMeta()`. This holds for every dispatch path
in this codebase, not just Clawith-dispatch, and is expected to hold
identically for the v1.11-native path.

## 9. Chatwoot mirroring — ownership

100% BFF, and **independent of which backend generates the reply**:
- Inbound: `chatwootMirrorInbound(tenantId, from, text, contactName, metaMessageId)`
  fires *before* the `containerUrl` fork (route.ts ~L475), so it happens
  identically whether the tenant ends up on Clawith-dispatch,
  native-Chatwoot-agent-bot, or plain container-proxy.
- Outbound: `chatwootMirrorOutbound(tenantId, from, draft)` fires from
  inside `sendDispatchDirect()`, after a successful Meta send.
- Both are fire-and-forget (`void ...(...)`) — a Chatwoot outage cannot
  block or fail a customer reply.

## 10. Paperclip — two distinct roles, only one is a hard dependency

This is the most important finding for Phase 2B.

**(a) Reply-generation dependency (hard, fail-closed, load-bearing today):**
`resolvePaperclipAgentId()` makes a **live HTTP call to Paperclip** on
every single inbound message (`GET /api/companies/{companyId}/agents`,
matching on `runtimeConfig.isola.bffTenantId`) to obtain `paperclip_agent_id`,
which is then sent to v1.8.3 as a required field — v1.8.3 uses it
server-side to fetch SOUL/skills content. If Paperclip is unreachable or
the match fails, the message is **dead-lettered and no reply is sent**
(`PaperclipUnreachable` / `ClawithDispatchError` thrown, caught, persisted
to `dead_letter`, function returns). **In today's contract, Paperclip is
not optional — it is on the critical path for every reply.**

**(b) Outbound mirror (soft, fire-and-forget, not load-bearing):**
`paperclipMirrorOutbound()` fires after a successful Meta send, gated on
`PAPERCLIP_FANOUT_ENABLED` and a token being configured; failures here are
swallowed and never affect the customer-facing send that already happened.

**Implication for Phase 2B:** (a) is exactly the kind of dependency the
packet says must not be reproduced unless deployed evidence proves it's
required to generate the reply. It is required *for v1.8.3*, because that
is how v1.8.3 sources its persona/skills content. It is a legacy
implementation detail of the old runtime, not an inherent requirement of
"generating a reply" — v1.11.0's native agent model stores persona,
model config, and tools directly in its own database per-agent (see Phase
2C), with no Paperclip lookup anywhere in that path. (b) is the kind of
supporting/mirror role Paperclip is allowed to keep.

## 11. Error format and failure handling

No typed error contract from v1.8.3 to BFF beyond HTTP status + a
`{"detail": "..."}` body checked for a `paperclip_unreachable` prefix on
503. Everything else non-2xx becomes a generic `ClawithDispatchError`.
Transport failures (timeout, connection refused) become
`ClawithDispatchError(0, "transport: ...")`. In every failure case, BFF's
behavior is: dead-letter the raw inbound payload, log, **and send nothing
to the customer** — there is no customer-facing fallback message on
failure today.

## 12. Legacy behavior that must NOT be reproduced in the v1.11-native path

1. **Fail-closed live Paperclip dependency for reply generation** (§10a) —
   the whole reason v1.8.3 needs it is v1.8.3's own persona-storage
   design; v1.11.0 doesn't have that gap.
2. **Non-deterministic agent selection** — already fixed on the BFF side
   for this path (Phase 0); the v1.11-native path must resolve its agent
   the same explicit, single-row way (see Phase 2C/2D).
3. **Unfiltered trust of the upstream `draft`/`reply` field** — v1.8.3
   requires a BFF-side annotation-stripping patch after the fact; the
   v1.11-native client (Phase 2E) instead treats every response as a typed
   result and never assumes a non-2xx/malformed body is a safe customer
   reply.
4. **Ephemeral, in-process-only conversational history** — not something
   to intentionally carry forward as "the design"; it is a legacy
   limitation of this specific path, noted here for completeness, not
   something Phase 2B is required to fix, but also not to be presented as
   an intentional feature of the target design.
5. **A single shared static bearer secret across all tenants** — the
   v1.11-native bridge (`ISOLA_BRIDGE_V11_SECRET`, see Phase 2D/2E) is
   already a distinct secret from `BFF_CLAWITH_SHARED_SECRET`; this should
   remain a clean break, not a shared credential.
