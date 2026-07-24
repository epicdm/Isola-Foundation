# R2 Phase 2B — v1.11-Native Target Design (2026-07-24)

Per `xp-clawith-r2-epic-tenant-cutover-and-legacy-inventory` Phase 2B.
Builds directly on `CLAWITH-R2-PHASE2A-CURRENT-CONTRACT.md`. This is a
design document — nothing described here is activated in production. The
staged client it describes (Phase 2E, isolav2 PR #70) exists but is not
wired into the live webhook path.

## Target flow

```
BFF webhook (app/api/whatsapp/webhook/route.ts)
  → number-scoped dispatch switch (isV11NativeDispatchTarget(), Phase 2E)
      false (today, incl. 3742) → existing dispatchInboundToClawith() → v1.8.3, UNCHANGED
      true  (Phase 3 cutover only, not yet) → dispatchToIsolaBridgeV11()
  → v1.11 native dispatch (POST /api/isola/bridge/message, clawith-v1110)
  → EPIC tenant (native v1.11 tenant + agent rows, Phase 2C)
  → 3742 customer-facing everything-agent ("EMA" / EPIC Front Desk agent)
  → native chat runtime (enqueue_chat_runtime → Run → ChatMessage), approved
    tools/context applied inside v1.11 itself
  → reply result (typed: {reply, run_id, matched_session, status,
    correlation_id} or a typed error, never a bare string)
  → BFF outbound (sendWhatsAppMessage → dispatchToMeta) — UNCHANGED, same
    function used today regardless of which backend generated the reply
```

The switch, the client, and the BFF-side outbound/persistence/Chatwoot-mirror
code are all already shared infrastructure — Phase 2B does not propose
duplicating any of §7-§9 of the Phase 2A contract. Only the box between
"dispatch switch" and "reply result" changes backend.

## Data ownership by system

| Responsibility | v1.8.3 (today) | v1.11-native (target) | BFF (unchanged either way) |
|---|---|---|---|
| Tenant + agent identity records | v1.8.3's own Postgres (`isolaruntime`) | v1.11's own Postgres (`clawith-v1110`), via `/tenants/self-create` + `agents.py` — **not** raw DB writes | `tenant_registry` row maps `waPhoneNumberId` → which backend + which agent id to call; BFF does not own persona/config either way |
| Persona / instructions | v1.8.3 DB, fetched via Paperclip SOUL lookup (Phase 2A §10a) | v1.11 DB directly, on the agent row itself — no external lookup | — |
| Model / provider config | v1.8.3 `LLMModel`-equivalent row | v1.11 `LLMModel` row (`enterprise.py` `llm-models` API), per-agent | — |
| Knowledge / business context | v1.8.3, via Paperclip-sourced SOUL content | v1.11, stored natively against the agent | — |
| Tools | Opaque to BFF; inside v1.8.3 | v1.11's own agent tool-binding (`agents.py` permissions) | BFF has zero visibility into tool execution either way — unchanged |
| Approvals / quotas | Opaque to BFF beyond the `auto`/`confirm` gate | v1.11's own approval/quota config on the agent, **plus** the same BFF-side `auto`/`confirm` gate stays as-is | `agent.approvalMode` gate is BFF-side and applies identically regardless of backend |
| Escalation config | Opaque to BFF | v1.11 agent config (`escalate_to_human`-style tool, exercised in the Phase 2 synthetic test) | Human-takeover check (`isHumanActive`) stays BFF-side, unchanged |
| Odoo integration | v1.8.3 calls Odoo directly using BFF-forwarded login/password (Phase 2A §5) | v1.11 calls Odoo directly using its **own** stored integration reference for the agent — BFF stops forwarding raw Odoo credentials in the request body; v1.11 resolves them itself the same way it resolves everything else about that agent | BFF no longer needs to read `tenant_registry.odooDb`/`agentOdooPasswordRef` for this path once cut over — that becomes v1.11-internal |
| Conversation persistence (inbound/outbound rows) | BFF | BFF, unchanged | `prisma.whatsAppMessage.create()` before dispatch, `sendWhatsAppMessage()` after — same code either way |
| Meta transport | BFF | BFF, unchanged | `dispatchToMeta()` — v1.11 never calls Meta, confirmed by inspection of `isola_bridge.py` (no Meta/WhatsApp SDK import) |
| Chatwoot mirror | BFF | BFF, unchanged | `chatwootMirrorInbound`/`Outbound` — fire outside the dispatch fork, unaffected by which backend is chosen |
| Paperclip mirror | BFF (fire-and-forget outbound only) + v1.8.3 (hard reply-generation dependency) | BFF (fire-and-forget outbound only, unchanged) — **v1.11 has zero Paperclip dependency for reply generation** | See "Paperclip's role" below |

## Paperclip's role in the target design

Per the packet's explicit instruction: Paperclip must remain a supporting
mirror/ticket integration unless deployed evidence proves it is required
to generate the reply, and must not become the tenant, agent, or runtime
source of truth.

**Evidence gathered this pass:** `isola_bridge.py`'s request schema
(`BridgeMessageIn{agent_id, phone, text, external_conversation_id,
conversation_ref, correlation_id}`) has no Paperclip field at all, and its
implementation (already read in full, Phase 2 investigation) resolves the
agent, its model, its tools, and its persona entirely from v1.11's own
database via `enqueue_chat_runtime`/`open_run_state_reader` — there is no
outbound HTTP call to Paperclip anywhere in this file. This was confirmed
by direct inspection, not inference.

**Conclusion:** in the target design, Paperclip is **not required to
generate the reply** and therefore, per the packet's own rule, must not be
added as a dependency of the v1.11-native path. The only Paperclip role
that survives into the target design is the existing BFF-side
`paperclipMirrorOutbound()` fire-and-forget mirror (Phase 2A §10b), which
is unchanged by this packet, gated on `PAPERCLIP_FANOUT_ENABLED`, and never
blocks a reply. This is a strictly smaller Paperclip footprint than today's
contract, not a larger one — the target design *removes* a fail-closed
dependency rather than reproducing it.

## What changes vs. what doesn't, precisely

**Changes (Phase 3 cutover only, not this packet):**
- `isV11NativeDispatchTarget(3742's phone_number_id)` flips from `false` to
  `true` in `V11_NATIVE_DISPATCH_PNIDS`.
- `dispatchInboundToClawith()`'s call site is replaced with a call to
  `dispatchToIsolaBridgeV11()` for numbers where the switch is `true`.
- BFF stops resolving/forwarding `paperclip_agent_id` and raw Odoo
  credentials for those numbers (no longer meaningful — v1.11 doesn't take
  them).

**Does not change, ever, as part of this design:**
- Meta transport, inbound/outbound persistence, Chatwoot mirroring,
  `agent.approvalMode` gating, human-takeover checks, dead-letter behavior
  on failure, the annotation-stripping guard (kept defensively even though
  v1.11's typed contract makes it less likely to be needed) — all of this
  is BFF-side infrastructure that is backend-agnostic today and stays that
  way.
- 9043 and 0001's own `tenant_registry` rows and `containerUrl` values —
  untouched by this design; the switch is `phone_number_id`-scoped, not a
  global flag (Phase 2E, already built and tested).

## Rollback design

Because the switch is a plain env-var allowlist read fresh on each call
(`isV11NativeDispatchTarget()`, no caching), reverting a live cutover is
removing one entry from `V11_NATIVE_DISPATCH_PNIDS` and redeploying — no
data migration to undo, since v1.8.3's `tenant_registry` row and
`containerUrl` are left in place, not deleted, until a separate,
explicitly-approved Phase 3/R3 retirement step. This mirrors the Phase
2A §12 principle: no destructive step is taken before the replacement is
proven.
