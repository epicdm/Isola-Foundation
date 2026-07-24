# R2 Phase 2C — Native EPIC Tenant Audit (2026-07-24)

Per `xp-clawith-r2-epic-tenant-cutover-and-legacy-inventory` Phase 2C.
Read-only audit of the live `clawith-v1110` instance (Postgres DB
`clawith`, container `clawith-v1110-postgres-1`) plus one supported-API
write carried over from the prior pass (the LLM model fix). No raw-DB
writes were made this pass; no secrets are reproduced below (tokens
masked or omitted).

## Headline finding: the instance is already small and clean

```
tenants: 2 total
  b349ae7a-34a8-4cac-9a3e-7293ea743c10  "Default"           (platform default, not customer-facing)
  6572bd90-0371-4041-986b-065379934f5d  "EPIC Front Desk"    (slug test-83a674)

agents: 1 total, across BOTH tenants
  81b38cd6-9fba-4cc8-8f87-1bce1a4aa162  "EMA"  tenant=EPIC Front Desk  status=idle  agent_type=native
```

There is exactly **one** agent on this entire instance. This structurally
satisfies most of the "prove nothing leaked in" requirement: there is no
Rex, no second/dormant EMA, no Lite Concierge, and no 0001/9043 tenant —
not because they were filtered out, but because they were never created
here. v1.11.0 has no shared history with the ~341-tenant v1.8.3 instance;
this is a from-scratch native tenant.

## Checklist: required production configuration

| Requirement | Status | Evidence |
|---|---|---|
| One customer-facing everything-agent | **Yes** | Exactly one agent exists, period (above). |
| Deterministic agent selection | **Yes, by construction** | `isola_bridge.py`'s `BridgeMessageIn.agent_id` is a required, caller-supplied UUID — there is no server-side "find an agent for this tenant" lookup to be non-deterministic. With only one agent existing anyway, ambiguity is doubly impossible today. |
| Correct instructions and identity | **Yes** | `/data/agents/{id}/soul.md` (the file the runtime actually reads, matching this codebase's Paperclip-lineage `instructionsEntryFile` convention) contains a complete, specific persona: identity ("EPIC Business Front Desk"), scope (existing customers + business prospects, Dominica/Caribbean), pricing guardrail (never quotes price/contract terms — human confirms), capability honesty (no phone/PBX claims), escalation triggers, and an explicit instruction never to surface reference codes/tokens to the customer. This is real production content, not a placeholder — see note below on where it differs from the DB display fields. |
| Supported model/provider | **Yes** | `primary_model_id` → `llm_models` row `provider=deepseek, model=deepseek-v4-pro, base_url=https://api.deepseek.com/v1`, `tool_calling_capability_source=probe` (live-verified, not assumed) — this is the fix carried over from the prior pass in this packet. Tenant's own `default_model_id` matches the same row. |
| Required knowledge / business context | **Partial** | Persona-level business context (pricing policy, escalation policy, capability boundaries) is present in `soul.md`. Deeper structured knowledge (e.g. a full FAQ/knowledge-base upload) was not found and is not required for the persona to function correctly — flagged as a known limitation, not a blocker. |
| Odoo integration | **Present, but indirect** | v1.11.0 has no native Odoo table/column at all (`tenant_settings` is empty for this tenant; no `odoo`/`integration` table exists anywhere in the v1.11 schema). Real account data instead flows through a governed MCP tool, `get_my_account` (see below), which calls the **Isola Foundation spine** (`https://isola-foundation.replit.app/api/customer/account`), which is what actually talks to Odoo. This is architecturally correct per Phase 2B's ownership table — v1.11 never touches Odoo credentials directly — but it means "Odoo integration" for this agent is really "spine integration," and the spine is the sixth system Phase 2A asked to keep distinct. |
| Approved tools | **Yes, tightly scoped** | Of ~130 catalog tools associated with this agent, only 3 are `enabled=true`: `finish` (system), `get_my_account` (custom/MCP), `escalate_to_human` (custom/MCP). No financial/file-deletion/business-system-write tools are enabled. |
| Approval and quota boundaries | **Present** | `agent_permissions`: `scope_type=company, access_level=use` (not `manage`). `autonomy_policy` JSON grants L1 (read_files) up to L3 (financial_operations, modify_soul, delete_files, send_external_message) tiers — L3 items are the ones requiring escalation/approval by this codebase's own convention, matching the persona's "use escalation tool" instruction. `max_tool_rounds=50`, `max_llm_calls_per_day=1000`. **Gap:** `max_tokens_per_day`/`max_tokens_per_month` are both NULL (unlimited) and `fallback_model_id` is unset — worth tightening before an actual Phase 3 cutover, not a Phase 2 blocker. |
| Escalation configuration | **Yes, real and governed** | `escalate_to_human(conversation_ref, reason)` (MCP tool, see below) calls the Foundation spine's `/api/customer/escalate`, passing the turn-scoped `conversation_ref` through verbatim, and surfaces the spine's own typed denial reasons (`unknown_or_expired_conversation_ref`, `ref_scope_mismatch`, `binding_unresolved`, `malformed_conversation_ref`) rather than ever claiming a handoff occurred that didn't. This is the same `conversation_ref`/escalation-ref mechanism this packet's own client (Phase 2E) is built to forward. |
| Channel association | **Correctly out-of-scope for v1.11** | v1.11 has no `waPhoneNumberId`-equivalent column anywhere in its schema — by design (Phase 2B): BFF's `tenant_registry` is the sole owner of number→agent mapping. See "the mapping that must still be pinned" below for the one real gap this creates. |
| Attribution fields | **Partially open — see below** | |

## Tool implementation detail (`isola-customer-tools` MCP server)

Both enabled custom tools are backed by a real service, not a stub:
`/opt/bff-v2/services/mcp-isola-customer-tools/server.py` (pm2-managed,
running 2+ days), registered in v1.11's `tools` table as MCP tools at
`http://192.168.32.1:8940/mcp` (reachable from the `clawith-v1110-backend-1`
container via the docker bridge gateway), **scoped to EPIC Front Desk's
own `tenant_id`** — not a shared/global tool row.

- `get_my_account(phone)` calls the spine's `/api/customer/account`,
  scoped by `tenant_id` + the caller's own phone — "this reads ONLY the
  caller's own account... cannot see other customers or any internal
  data" (verified by reading the implementation, not just the docstring).
  It also filters out draft/unissued Odoo invoices before returning data
  to the agent, directly relevant to the known invoice-state-discrepancy
  class of issue noted elsewhere in this engagement's history.
- `escalate_to_human(conversation_ref, reason)` is fail-closed: refuses
  to call the spine at all without a `conversation_ref`, never fabricates
  a successful handoff, and surfaces the spine's real denial codes.
- Both draw their bearer token and spine URL from `/opt/isola-runtime/.env`
  (shared secret storage location, not a functional dependency — this
  service never calls v1.8.3's own API or port 8800).

This is a materially stronger, more isolated tool design than the legacy
path's implicit trust in whatever v1.8.3 does internally (Phase 2A §6).

## Explicit leak checks

| Must not have leaked in | Checked | Result |
|---|---|---|
| Rex | Queried all agents on the instance | Does not exist anywhere on v1.11 |
| Dormant legacy EMA (a second/duplicate binding) | Queried all agents | Only one EMA row exists, and its id (`81b38cd6-...`) is a distinct native identity, not v1.8.3's EMA id (`8166ea11-...`) reused |
| Lite Concierge | Queried all agents | Does not exist on v1.11 |
| 0001 | Queried all tenants | Does not exist on v1.11 |
| 9043 | Queried all tenants | Does not exist on v1.11 |
| Test tenants or users | Queried all tenants/users | Only 2 tenants total (Default, EPIC Front Desk); one prior test user (`R1 Test Customer`) exists but is `is_active=false` **and** detached from any tenant (`tenant_id` NULL) — matches Gate 04's documented containment of the R1 tenant-isolation defect; several `isola_bridge`-registered "member" identities keyed by real-looking phone numbers are auto-created customer-contact rows from genuine prior test traffic, not agent configuration — flagged as residual data, not a config leak, see Known Limitations |
| Obsolete models | Queried `llm_models` + agent's `primary_model_id` | Points at `deepseek-v4-pro`, not the deprecated `deepseek-chat`; a `gpt-4o-mini` row also exists on the tenant but is not referenced by the tenant's `default_model_id` or the agent's `primary_model_id`/`fallback_model_id` — an available option, not a stale default |
| Stale credentials | Queried `agent_credentials` | Zero rows for this agent |
| Unordered agent selection | Reviewed `isola_bridge.py` request contract | Caller supplies `agent_id` explicitly; no server-side ambiguous lookup exists in this path |
| v1.8.3 IDs as hidden runtime dependencies | Compared agent/tenant UUIDs | v1.11's tenant id, agent id, and model id are all distinct from every v1.8.3-side id; the only cross-reference is a shared secret **file location** (`/opt/isola-runtime/.env`) used by the MCP tool server, which is a co-located-secrets convenience, not a call to v1.8.3's API or port |

## The mapping that must still be pinned (real, open item)

Phase 2C's own checklist item "correct attribution fields" surfaces one
genuine gap: **BFF's `tenant_registry` has no column today that would tell
it which v1.11 agent id to call for 3742.** The exact mapping this packet
establishes and that Phase 3 must use is:

```
tenant_registry.tenantId = 8166ea11-8db0-4f26-879a-e2067be0a018  (EPIC, 3742)
  → v1.11 tenant  = 6572bd90-0371-4041-986b-065379934f5d  ("EPIC Front Desk")
  → v1.11 agent   = 81b38cd6-9fba-4cc8-8f87-1bce1a4aa162  ("EMA")
```

This document is the pinned record of that mapping. Persisting it as a
queryable BFF-side column (rather than a hardcoded literal at the Phase 3
call site) is left as an explicit Phase 3 prerequisite, not implemented
here — doing so is itself a schema change, and this packet's Phase 2E
already committed to not touching production routing.

## Known limitations (carried into the final Phase 2 report)

1. No fallback model configured (`fallback_model_id` NULL).
2. No per-agent token quota (`max_tokens_per_day`/`month` NULL — unlimited).
3. No structured knowledge-base upload beyond the persona document itself.
4. Residual auto-created "member" identities from genuine prior (R1-era,
   owner-authorized) test traffic remain in the `users` table under EPIC
   Front Desk — inert (no agent config references them), but not deleted.
5. The BFF-side persisted mapping described above does not exist yet;
   Phase 3 needs it before cutover can be wired safely.
6. The MCP customer-tools server sources its secret from the v1.8.3 host's
   `.env` file location — a co-location convenience worth migrating off of
   before v1.8.3 is actually retired (R3), though it is not a functional
   dependency today.
