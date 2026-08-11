# Runtime Tenant Context & Unified Handoff — IMPLEMENTATION CONTRACT

**Status:** implementation contract. The implementing session writes code from this document.
**Date:** 2026-08-11
**Closes:** frozen-spec gaps **G1** (PUBLIC path supplies no business-information field) and
**G2** (no provisioning-time tenant-knowledge write), and frozen-spec **OWNER DECISION (5)**
(a model-initiated escalation changes no conversation state).

**Binding owner ruling this implements (2026-08-11):**

| Ruling | Consequence in this document |
|---|---|
| `WS2_STATUS=ACCEPTED_8_OF_8` | WS2 is not reopened. Part E lists only regressions these changes could cause |
| `CANONICAL_PROCESSOR=ISOLA_GATEWAY_EASYPANEL` | Every gateway change here is made in `services/isola-gateway`. Foundation (Replit) is legacy-only and receives **no** change |
| `PAPERCLIP_REPLACES_CLAWITH=YES` | Customer-facing strings say **"powered by Isola"**. Neither "Clawith" nor "Paperclip" may appear in the projection, in a customer message, or in a private note |
| NocoBase is the authoritative control plane | NocoBase owns tenant/agent/offer/entitlement/binding configuration. Nothing in this contract writes back to NocoBase |
| The runtime consumes a **private, versioned runtime projection** | Part A |
| Prohibited carriers: Paperclip issue content · Chatwoot message content · a hardcoded company map | §A.1.4 |
| No business content in the delivery ledger | §A.2.4. `test/ledger-no-content.test.ts` is untouched and must still pass |
| Avoid a synchronous NocoBase call per customer message | §A.2 — push-published projection; zero NocoBase calls on the message path |

**Read before implementing:** `services/isola-gateway/src/{pipeline,webhook,writes,ledger,deliveryref,chatwoot,bindings,config,app,runtime}.ts`,
`services/isola-runtime/src/{app,registry,response,context,state,paperclip,conversation,model,config}.ts`,
`docs/isola/ISOLA-AI-SALES-FRONT-DESK-AGENT-V1-FROZEN-SPEC.md`.

**Files this contract changes.** `artifacts/isola/lib/employee-provisioning.ts` and
`artifacts/isola/lib/employee-template.ts` are **read-only** for the duration (dirty in another
lane); §A.4 changes only `artifacts/isola/scripts/provision-employees.ts` and adds new files.

---

## PART A — TENANT CONTEXT PROJECTION

### A.1 The projection

#### A.1.1 Envelope

One document per `(tenantId, agentId)`. Canonical JSON (keys sorted, no insignificant
whitespace) is what the digest is taken over.

| Field | Type | Req | Rule |
|---|---|---|---|
| `schemaVersion` | integer | **REQ** | Exactly `1` for this contract. An unknown value is refused, never coerced |
| `tenantId` | string (1–64, `^[A-Za-z0-9._:-]+$`) | **REQ** | Must equal the tenant of the resolved binding |
| `agentId` | string (uuid) | **REQ** | The Paperclip employee instance id — `binding.paperclipAgentId` |
| `companyId` | string (uuid) | **REQ** | `binding.paperclipCompanyId`. Identifier only; nothing is read from Paperclip |
| `templateId` | string | **REQ** | e.g. `isola-ai-sales-front-desk-agent@v1`. Must equal `binding.templateId` |
| `exposure` | `"PUBLIC"` | **REQ** | Literal. Any other value is refused at publish (an INTERNAL projection must not exist on this path) |
| `status` | `"active" \| "inactive"` | **REQ** | `inactive` is served as a refusal, never as an empty context |
| `contextVersion` | integer ≥ 1 | **REQ** | Strictly monotonic per `(tenantId, agentId)`. A publish with `contextVersion` ≤ stored is refused |
| `contextDigest` | string `^sha256:[0-9a-f]{64}$` | **REQ** | sha256 over canonical JSON of `content` **only**. Recomputed on publish and on every read; a mismatch is `tenant_context_unreadable` |
| `publishedAt` | ISO-8601 UTC | **REQ** | Publish-time clock of the control plane |
| `publishedBy` | string (≤128) | **REQ** | Control-plane actor id. Never a secret, never an email |
| `sourceRecordId` | string (≤128) | **REQ** | The NocoBase record id this was projected from. The audit join key |
| `content` | object | **REQ** | §A.1.2 |

#### A.1.2 `content`

```jsonc
{
  "business": {
    "legal_name":    "Acme Marine Services Ltd",        // REQ, string ≤200
    "trading_name":  "Acme Marine",                     // OPT, falls back to legal_name, never invented
    "what_we_do":    "…",                               // REQ, string ≤500
    "language":      "en",                              // OPT, BCP-47
    "hours":         "Mon–Fri 08:00–17:00 AST",         // OPT, string ≤300
    "locations":     ["Roseau"],                        // OPT, ≤10 × ≤120
    "service_area":  "Dominica and Martinique",         // OPT, string ≤300
    "contact_routes":[                                  // REQ, ≥1, ≤10
      { "kind": "phone" | "email" | "whatsapp" | "web" | "in_person", "value": "…", "label": "…" }
    ]
  },
  "offers": [                                           // REQ, ≥1, ≤40
    {
      "id":          "svc-hull-clean",                  // REQ, stable within the tenant
      "name":        "Hull cleaning",                   // REQ ≤120
      "description": "…",                               // REQ ≤600
      "who_it_suits":"…",                               // OPT ≤300
      "price":       "EC$450 per visit",                // OPT — verbatim string, never a number the agent could arithmetic on
      "lead_time":   "3–5 working days",                // OPT — verbatim
      "availability":"…"                                // OPT ≤200
    }
  ],
  "policies": [                                         // OPT, ≤30
    { "topic": "refunds", "text": "…" }                 // topic ≤80, text ≤800
  ],
  "faq": [                                              // OPT, ≤50
    { "question": "…", "answer": "…" }                  // ≤200 / ≤800
  ],
  "boundaries": {
    "do_not_say":        ["…"],                         // OPT, ≤30 × ≤200 — tenant-specific prohibitions
    "escalate_topics":   ["warranty claims"],           // OPT, ≤30 × ≤120 — always escalate, never answer
    "never_promise":     ["installation dates"]         // OPT, ≤30 × ≤120
  },
  "tools": {                                            // REQ — declarative, must be all-false
    "shell": false, "filesystem": false, "web": false, "mcp": false, "customTools": false
  },
  "escalation": {
    "chatwoot_team_id":     4,                          // REQ, positive integer
    "chatwoot_assignee_user_id": null,                  // OPT, default null — see B.4 note
    "allowed_reasons": [                                // REQ, ≥1, subset of the closed vocabulary in B.1.2
      "customer_requested_human","dissatisfaction_or_complaint",
      "outside_supplied_information","policy_or_legal","commitment_not_authorised"
    ],
    "handback_requires_explicit_action": true           // REQ, must be true in v1
  }
}
```

**Rendered size cap.** The rendered approved-business block is hard-capped at **16 384 bytes**
(`RUNTIME_TENANT_CONTEXT_MAX_BYTES`). A projection that renders larger is **refused at publish
time** — never truncated at run time. This guarantees ≥8 192 bytes of the template's 24 576-byte
context budget remain for the caller context (§A.3.4).

#### A.1.3 Publish-time validation (all fail closed, all refuse the publish)

| # | Rule |
|---|---|
| V1 | Every REQ field present, correctly typed, inside its length bound |
| V2 | `offers` ≥ 1 and every offer has `id`, `name`, `description` |
| V3 | `business.contact_routes` ≥ 1 |
| V4 | `escalation.chatwoot_team_id` is a positive integer |
| V5 | `escalation.allowed_reasons` ⊆ the closed vocabulary (B.1.2), non-empty |
| V6 | `tools` present with all five keys exactly `false` |
| V7 | `exposure === "PUBLIC"`, `status ∈ {active,inactive}`, `schemaVersion === 1` |
| V8 | `contextDigest` recomputes to the supplied value |
| V9 | `contextVersion` > the stored version for this key |
| V10 | Rendered block ≤ 16 384 bytes |
| V11 | No key anywhere in `content` matches `/(secret\|password\|api[_-]?key\|access[_-]?token\|authorization\|bearer\|token\|credential\|private[_-]?key)/i`; no string value matches `^(Bearer\s+\S+\|sk-[A-Za-z0-9_-]{8,}\|-----BEGIN)` |
| V12 | No string value in `content` contains `http://` or `https://` **except** inside `business.contact_routes[].value` where `kind === "web"`. The runtime has no fetch capability; a URL elsewhere is either dead weight or an injection attempt |
| V13 | No string in `content` matches `/\bclawith\b\|\bpaperclip\b/i` (owner ruling: customer-facing material says "powered by Isola") |

A refused publish returns `409` with `outcome: "tenant_context_publish_rejected"` and a
field-and-index error list that **names no value** (same discipline as `parseBindings`).

#### A.1.4 What the projection must NOT carry — normative

| Prohibited | Why |
|---|---|
| Any secret, bearer, API key, Chatwoot `api_access_token`, AgentBot secret, DB URL | V11. The projection is content, not credentials |
| Any customer PII — a name, phone, email, address or account number of an end customer | It is tenant configuration, not conversation data |
| Any customer message text, transcript, or AI answer | Owner ruling: Chatwoot message content is a prohibited carrier |
| Any Paperclip issue id, issue body, comment or issue-derived text | Owner ruling: Paperclip issue content is a prohibited carrier |
| A system prompt, prompt fragment, persona override, role instruction or "ignore previous" text | `registry.ts` is the sole authority for behaviour. The projection is **data**, rendered in a user-role block |
| `model`, `timeoutMs`, `maxContextBytes`, `toolPolicy` overrides, `exposure` widening | Same. `tools` is present only so the denial is written down; the runtime never reads it for policy |
| Any URL the runtime could be induced to fetch | V12; the runtime has one allowlisted egress and no fetch tool |
| EPIC's own offer catalogue, SKUs or prices (`offer-epic-*`) | Those are governed by `epic_offer` records with `price_status`. `offers[]` is the **tenant's own** services only |
| Another tenant's data, in any field | §A.5 |
| Executable content — HTML, script, template syntax | Rendered as literal text in an untrusted-data envelope; still refused on principle |

### A.2 Where it lives and how it is read

#### A.2.1 Recommendation

> **RECOMMENDATION — the runtime resolves the projection itself, from a private versioned store
> on its existing `/data` persistent volume, published to it by the control plane through a new
> admin-authenticated `PUT /v1/tenant-context` endpoint. The gateway sends identity plus the
> version/digest it expects, and never sends business content.**

Concretely:

| Element | Value |
|---|---|
| Store | `TenantContextStore`, a **new class inside `services/isola-runtime/src/state.ts`** (the only module permitted to import `node:fs`) |
| File | `<RUNTIME_STATE_DIR>/tenant-context.json` — one fixed basename, mode `0600`, atomic write via `writeFileSync` + `renameSync`, exactly as `FileStateStore` already does |
| Shape on disk | `{ "version": 1, "contexts": { "<tenantId>::<agentId>": <TenantContextProjection> } }` |
| Read path | In-process cache, refreshed on publish and on boot. **Zero I/O per customer message** after the first read |
| Publish path | `PUT /v1/tenant-context`, `Authorization: Bearer <RUNTIME_ADMIN_TOKEN>`, body = one projection. Idempotent on `(tenantId, agentId, contextVersion)` |
| Caller | WS4 provisioning / a NocoBase-triggered Activepieces flow, on every approved configuration change, plus a periodic reconcile |

**Trade-off, stated plainly.** The runtime becomes stateful with respect to tenant
configuration. A brand-new runtime instance — a fresh volume, a second replica, a volume loss —
starts with **zero** projections, and every PUBLIC conversation then fails closed and escalates
to a human until the control plane republishes. That is the price of keeping business content
off the public component and off the wire. It is bounded by three things: `/healthz` reports
`tenantContexts: {count, minVersion, oldestPublishedAt}` so the empty state is observable
immediately; the failure mode is silence-plus-human, never a wrong answer; and the control plane
republishes on a schedule, so recovery is automatic rather than manual.

#### A.2.2 Runner-up, and why it lost

**Runner-up: a `tenant_context` table in the gateway's existing private Postgres (the ledger's
server, a separate database or at minimum a separate table), read by the gateway and injected
into the run context by `buildRuntimeContext`.**

It is genuinely attractive: the gateway already owns a Postgres client, the ledger already proves
the connection works, publishing becomes an `INSERT … ON CONFLICT` any control plane can drive,
and multi-replica works for free.

It lost on four points:

1. **It puts every tenant's business content inside the only publicly-exposed component.** The
   gateway is deliberately filesystem-free and content-free; today the worst a gateway compromise
   yields is credentials and routing. Adding a multi-tenant business-content read widens that.
2. **The runtime becomes structurally unable to detect a forged context.** If facts arrive in the
   request body, a caller holding `RUNTIME_SECRET_PUBLIC` can assert *any* facts for any tenant,
   and the runtime has nothing to check them against. With a runtime-held projection the caller
   can at worst select the wrong existing tenant, which the two-sided digest check (§A.5) catches.
3. **It parks business content in the same database as the delivery ledger**, one careless
   migration away from the ledger's no-content invariant that `test/ledger-no-content.test.ts`
   exists to protect. The owner ruling explicitly forbids business content in the ledger; sharing
   a server is not forbidden, but it is the wrong side of a bright line.
4. **The runtime cannot read Postgres anyway.** `test/no-direct-network.test.ts` asserts that
   `fetch(` appears only in `egress.ts` and that no raw socket client is imported in `src/`.
   Adding `pg` to the runtime opens a second, unallowlisted outbound socket — so a Postgres
   projection is *only* readable by the gateway, which forces injection, which is point 2.

#### A.2.3 Also considered, rejected

| Option | Rejected because |
|---|---|
| `GATEWAY_TENANT_CONTEXT_JSON` env, alongside `GATEWAY_BINDINGS_JSON` | An env var is not a control plane. EasyPanel env changes need `forceRebuild` and a stale env capture silently drops keys; a per-tenant config change would mean a redeploy of the public component |
| Chatwoot conversation `custom_attributes` as the carrier (frozen-spec option (b)) | Conversation-scoped, not tenant-scoped; a human can edit it; it is customer-visible surface. And the owner ruling names Chatwoot message content as prohibited — attributes are the same channel by a different door |
| Paperclip company profile / soul read by the runtime | Prohibited carrier. Also requires widening the runtime's egress and its Paperclip API surface (`paperclip.ts:15-22` has no company-profile read), which is exactly what `registry.ts` refuses on principle |
| Synchronous NocoBase read per message | Owner ruling forbids it, and it puts a control-plane outage on the customer-message path |
| Hardcoded company map in `registry.ts` | Prohibited carrier |

#### A.2.4 Ledger invariant — unchanged

`LEDGER_SCHEMA_SQL` is **not modified**. No projection field, no digest of a projection, no
business string is added to `delivery_ledger`. `test/ledger-no-content.test.ts` passes unchanged.
The only new ledger content is **new `action_type` values** (Part B), which are rows, not
columns, and are already covered by the primary key.

### A.3 `buildRuntimeContext` — new signature and return shape

#### A.3.1 Before (`services/isola-gateway/src/pipeline.ts:141-163`)

```ts
export function buildRuntimeContext(
  binding: Binding,
  payload: WebhookPayload,
): Record<string, unknown> {
  return {
    source: "chatwoot",
    tenantId: binding.tenantId,
    companyId: binding.paperclipCompanyId,
    chatwoot: { accountId, inboxId, conversationDisplayId, conversationStatus, messageId, customAttributes },
    message: { role: "customer", content: payload.content ?? "" },
  };
}
```

#### A.3.2 After

```ts
/** The resolved tenant + agent identity. Derived ONLY from the resolved binding. */
export interface ResolvedAgentIdentity {
  tenantId: string;
  companyId: string;          // binding.paperclipCompanyId
  agentId: string;            // binding.paperclipAgentId
  templateId: string;         // binding.templateId
  exposure: "PUBLIC";         // binding.exposure, already refused at boot if not PUBLIC
  /** What the control plane last told the GATEWAY this tenant's context should be. */
  expectedContextVersion: number | null;   // binding.contextVersion ?? null
  expectedContextDigest: string | null;    // binding.contextDigest  ?? null
}

/** Conversation ownership, as decided by the pre-ACK predicate. No I/O. */
export interface ConversationOwnership {
  status: string | null;      // payload.conversationStatus, verbatim
  humanAssigned: boolean;     // hasAssignee(payload.assignee)
  humanTakeover: boolean;     // isola_human_takeover marker, when the payload carried it
  handbackApplied: boolean;   // true iff THIS delivery performed the handback clear (B.6)
}

export function buildRuntimeContext(
  identity: ResolvedAgentIdentity,
  payload: WebhookPayload,
  ownership: ConversationOwnership,
): Record<string, unknown>;
```

Returns:

```jsonc
{
  "contextContractVersion": 2,
  "source": "chatwoot",
  "tenantId": "tnt-acme",                       // unchanged — extractTenantId depends on it
  "companyId": "3ed3869b-…",                    // unchanged — extractCompanyId depends on it
  "agent": {
    "agentId": "fd2867d1-…",
    "templateId": "isola-ai-sales-front-desk-agent@v1",
    "exposure": "PUBLIC"
  },
  "tenantContext": {                            // A REFERENCE. Never the content
    "required": true,
    "expectedVersion": 7,                       // or null when the gateway holds no expectation
    "expectedDigest": "sha256:9f2c…"            // or null
  },
  "conversation": {
    "status": "pending",
    "humanAssigned": false,
    "humanTakeover": false,
    "handbackApplied": false
  },
  "chatwoot": {                                 // unchanged, byte for byte
    "accountId": 3, "inboxId": 4, "conversationDisplayId": 41,
    "conversationStatus": "pending", "messageId": 991, "customAttributes": { }
  },
  "message": { "role": "customer", "content": "…" }   // unchanged
}
```

**Compatibility rules that are not optional.** `tenantId`, `companyId`, `chatwoot.*` and
`message.*` keep their exact names and positions: `conversation.ts` resolves the Paperclip
conversation issue from `chatwoot.conversationDisplayId`, `extractTenantId` from `tenantId`, and
`extractCompanyId` from `companyId`. Renaming any of them re-breaks the live defect that
`CONVERSATION_ID_PATHS` was widened to fix.

#### A.3.3 New binding fields

`services/isola-gateway/src/bindings.ts` — two optional fields, parsed by the same strict
validators, refused when malformed:

| Field | Type | Rule |
|---|---|---|
| `contextVersion` | positive integer, optional | `optionalInt`. Absent ⇒ gateway holds no expectation |
| `contextDigest` | string `^sha256:[0-9a-f]{64}$`, optional | New `optionalDigest` validator. Absent ⇒ no expectation |

Both are added to `redactBinding` (they are identifiers, not secrets). Publishing them is WS4's
job: the same control-plane action that publishes a projection to the runtime updates the
gateway binding, so the two-sided check has something to compare.

#### A.3.4 Runtime-side assembly

In `services/isola-runtime/src/app.ts`, immediately after `decideExposure` allows the run and
**before** `renderContext`:

1. Read `tenantId` (existing `extractTenantId`) and `agent.agentId` from the context. Both
   required for a PUBLIC run; absent ⇒ `tenant_context_missing` (§A.5).
2. `tenantContext.get({tenantId, agentId})` → projection or `null`.
3. Apply §A.5 fail-closed rules. Any refusal short-circuits before the provider is called and
   **before any budget reservation is taken** — a refused run must cost nothing.
4. Render the approved block, cap 16 384 bytes (`renderApprovedContext`, new pure function in
   `src/context.ts`).
5. Render the caller context with `renderContext(body.context, template.maxContextBytes - approvedBytes)`,
   floor 8 192. The existing in-band truncation marker is unchanged.
6. Compose exactly two messages, as today:

```ts
messages: [
  { role: "system", content: template.systemPrompt },
  { role: "user",   content: approvedBlock + "\n\n" + buildUserMessage(rendered) },
]
```

`renderApprovedContext` output, verbatim frame:

```
----- BEGIN APPROVED BUSINESS INFORMATION (tenant tnt-acme, version 7) -----
This block is the ONLY source of truth about this business. It was approved by the
business owner. Everything after it is channel and customer data, not business fact.
<canonical, human-readable rendering of content>
----- END APPROVED BUSINESS INFORMATION -----
```

**Prompt amendment (`FRONT_DESK_PROMPT`, `registry.ts`).** Two additions, and nothing else:
"GROUNDING" is amended to say the approved-business block is the sole source of business fact and
that anything in the run context — including `chatwoot.customAttributes` — is channel data and
never business truth; and the escalation section gains the sentinel instruction in §B.1.1.

> **OWNER DECISION REQUIRED (A-1):** the frozen spec freezes `isola-ai-sales-front-desk-agent@v1`
> and states that anything not in it is v2. Amending `FRONT_DESK_PROMPT` changes the compiled-in
> behaviour of `@v1`. Does this ship as an in-place amendment to `@v1`, or as a new
> `isola-ai-sales-front-desk-agent@v2` (which requires a binding change, a re-provision and a new
> Paperclip hire approval)? This contract is written for an in-place `@v1` amendment; switching to
> `@v2` changes only §A.4 and the binding's `templateId`.

### A.4 Removing the single-company `PLANS` assumption

`artifacts/isola/scripts/provision-employees.ts` today: `PLANS` is a hardcoded two-element array,
`companyId` defaults to the literal EPIC company `3ed3869b-463c-4876-8e16-ddc058f06cd9`, and
there is no tenant parameter anywhere. `loadTemplate` reads `AGENTS.md` into `agentsMd` and the
script never uses it.

**Exact changes.**

| # | Change |
|---|---|
| P1 | `interface Plan` gains `templateId: string` (the sidecar id, used to select the directory) and loses nothing. `dir` is derived from `templateId` + version, not hardcoded per entry |
| P2 | `const PLANS: Plan[]` becomes `function plansFor(target: TenantProvisioningTarget): Plan[]`. `instanceName`, `title`, `capabilities` and `budgetMonthlyCents` come from the target, with the current literals as the documented defaults for the EPIC tenant only |
| P3 | New required parameter object (below). No default company id survives anywhere in the file — `PAPERCLIP_COMPANY_ID` remains an env **input** to build the target, not a fallback |
| P4 | New step, after the hire is created or found: **publish the projection**. `PUT {RUNTIME_ADMIN_URL}/v1/tenant-context` with `Authorization: Bearer $RUNTIME_ADMIN_TOKEN`. On a non-2xx the script exits non-zero and the employee is left `staged-not-ready` |
| P5 | New step: **update the gateway binding expectation** — emit the `{tenantId, contextVersion, contextDigest}` triple the operator must apply to `GATEWAY_BINDINGS_JSON`. The script does not write gateway env itself (env changes need `forceRebuild` and an owner action) |
| P6 | Required-field gate: if the target's business intake fails §A.1.3 V1–V13, the script refuses **before** creating any agent, prints the field-and-index error list, and exits 1. Frozen spec §3.2: a missing REQUIRED field must never produce a bound employee with an empty knowledge base |
| P7 | `--dry-run` prints the projection envelope with `content` replaced by `{fields: <n>, bytes: <n>, digest: <sha256>}` — never the business text, never the bearer |
| P8 | `agentsMd` stays unused and that is now explicit: add a one-line comment saying the persona package is not uploaded to Paperclip and the compiled-in `registry.ts` prompt is the only persona. (Removing the field would touch `employee-template.ts`, which is read-only this session.) |

**The tenant parameter:**

```ts
export interface TenantProvisioningTarget {
  tenantId: string;                 // Isola tenant id — the projection and binding key
  paperclipCompanyId: string;       // the tenant's own Paperclip company. No default
  displayName: string;              // e.g. "Acme Marine" -> instanceName "Acme Marine AI Front Desk"
  runtimeUrl: string;               // assertRuntimeUrlIsSafe() already guards this
  budgetMonthlyCents: number;
  /** The approved intake, already validated against §A.1.3. */
  context: TenantContextContent;    // becomes projection.content verbatim
  chatwootTeamId: number;           // -> content.escalation.chatwoot_team_id
}
```

Sourced from a JSON file path (`--target <file>`) or, in WS4, straight from the NocoBase record.
One invocation provisions exactly one tenant; two tenants means two invocations, which is what
proof **TC-9** (§D) exercises.

### A.5 Fail-closed rules

Evaluated in this order, in the runtime, before the provider is called and before any budget
reservation is taken. **Never** fall back to another tenant, to a default company, to an earlier
version, or to an empty business block.

| # | Condition | `failureCategory` | `completionState` | HTTP | alertCode |
|---|---|---|---|---|---|
| F1 | Context carries no `tenantId`, or no `agent.agentId`, on a PUBLIC run | `tenant_context_identity_missing` | `context_unavailable` | 409 | `tenant_context_missing` |
| F2 | No projection stored for `(tenantId, agentId)` | `tenant_context_missing` | `context_unavailable` | 409 | `tenant_context_missing` |
| F3 | Stored projection `status !== "active"` | `tenant_context_inactive` | `context_unavailable` | 409 | `tenant_context_inactive` |
| F4 | Stored `tenantId`/`agentId`/`templateId`/`exposure` disagrees with the request | `tenant_context_mismatch` | `context_unavailable` | 409 | `tenant_context_mismatch` |
| F5 | Caller supplied `expectedDigest` and it differs from the stored `contextDigest` | `tenant_context_mismatch` | `context_unavailable` | 409 | `tenant_context_mismatch` |
| F6 | Caller supplied `expectedVersion` > stored `contextVersion` (gateway is ahead: publish did not land) | `tenant_context_stale` | `context_unavailable` | 409 | `tenant_context_stale` |
| F7 | Caller supplied `expectedVersion` < stored `contextVersion` (gateway binding not yet updated) | `tenant_context_stale` | `context_unavailable` | 409 | `tenant_context_stale` |
| F8 | Stored `contextDigest` does not recompute from stored `content`, or the file is unparseable | `tenant_context_unreadable` | `context_unavailable` | 409 | `tenant_context_unreadable` |
| F9 | `publishedAt` older than `RUNTIME_TENANT_CONTEXT_MAX_AGE_MS` (default `0` = disabled) | `tenant_context_stale` | `context_unavailable` | 409 | `tenant_context_stale` |

**Contract v2 additions** (`services/isola-runtime/src/response.ts`):
`RESPONSE_CONTRACT_VERSION = 2`; `COMPLETION_STATES` gains `"context_unavailable"`.
`inlineFailureBody` is unchanged in shape — `answerText` stays hardcoded `null`, so no refusal
path can carry text.

**Gateway mapping** (`services/isola-gateway/src/runtime.ts`):
`RUNTIME_COMPLETION_STATES` gains `"context_unavailable"`;
`outcomeForCompletionState("context_unavailable") = "tenant_context_unavailable"`;
`outcomeForStatus(409) = "tenant_context_unavailable"`;
`FAILURE_EXPLANATIONS.tenant_context_unavailable =
"the AI employee has no approved, current business information for this tenant, so it was not asked anything"`.

**Customer-visible behaviour on every one of F1–F9: nothing at all.** The gateway takes the
existing failure-escalation path — private note, `toggle_status → open`, team assignment, label
`isola-ai-escalated`, `isola_last_outcome: tenant_context_unavailable`. No message is sent, no
answer is invented, and the model is never called.

**Backward compatibility.** A gateway running the old build against a new runtime sees an
unrecognised `completionState`, `isCompletionState` returns false, it falls back to
`outcomeForStatus(409)` → `runtime_error`, and it escalates. Degradation is safe in both
directions.

### A.6 Logging

Identifiers, version and digest only. Never a field of `content`, never the business name, never
the customer message, never the answer. `redact()` already strips credential-shaped keys; nothing
here is credential-shaped.

**Runtime, one line per resolution** (`event: "tenant_context"`):

```json
{"ts":"2026-08-11T14:22:31.004Z","level":"info","service":"isola-runtime","version":"1.2.0",
 "event":"tenant_context","correlationId":"6b1e…","runId":"delivery:9f…","tenantId":"tnt-acme",
 "agentId":"fd2867d1-…","templateId":"isola-ai-sales-front-desk-agent@v1","exposure":"PUBLIC",
 "outcome":"resolved","contextSchemaVersion":1,"contextVersion":7,
 "contextDigest":"sha256:9f2c1ab3…","contextBytes":8412,"contextSource":"runtime_projection",
 "expectationChecked":true,"durationMs":1}
```

On a refusal: `"level":"error"`, `"outcome":"<failureCategory from F1–F9>"`, `"alert":true`,
`"alertCode":"<alertCode>"`, plus `"storedVersion"` and `"expectedVersion"` (integers or null).
`contextDigest` is emitted in full; a digest of approved business text discloses nothing and is
the audit join key.

**Gateway, on the existing `event: "delivery"` line**, four added fields and no others:
`agentId`, `contextVersion` (integer|null), `contextDigest` (string|null),
`contextExpectation` (`"matched" | "absent" | "mismatch"`).

**Publish endpoint**, `event: "tenant_context_publish"`: `tenantId`, `agentId`, `contextVersion`,
`contextDigest`, `contentBytes`, `outcome` (`published` | `rejected` | `duplicate`),
`publishedBy`, `sourceRecordId`. On rejection, `errors` is the field-and-index list — **values are
never echoed**.

`test/no-content-logged.test.ts` (gateway) and the runtime's equivalent are extended to drive a
run with a projection whose business strings are distinctive sentinels, and to assert that not one
of those sentinels appears in any emitted line.

### A.7 Repository / adapter boundary

So WS4 can publish and update projections without touching runtime logic.

```ts
// services/isola-runtime/src/tenantcontext.ts   (new; pure — no fs, no network)
export interface TenantContextKey { tenantId: string; agentId: string; }

export interface TenantContextSummary {          // safe to return over an API and to log
  tenantId: string; agentId: string; templateId: string;
  status: "active" | "inactive";
  contextVersion: number; contextDigest: string;
  publishedAt: string; publishedBy: string; sourceRecordId: string;
  contentBytes: number;                          // never the content
}

export type PublishResult =
  | { kind: "published"; summary: TenantContextSummary }
  | { kind: "duplicate"; summary: TenantContextSummary }        // same version AND same digest
  | { kind: "rejected"; errors: string[] };                     // §A.1.3, values never named

export type ResolveResult =
  | { kind: "ok"; projection: TenantContextProjection }
  | { kind: "missing" } | { kind: "inactive" }
  | { kind: "mismatch"; detail: string } | { kind: "stale"; detail: string }
  | { kind: "unreadable"; detail: string };

export interface TenantContextRepository {
  /** Hot path. Cache-backed, no I/O after the first read. */
  resolve(key: TenantContextKey, expect: {
    version: number | null; digest: string | null;
    templateId: string; exposure: "PUBLIC"; nowMs: number;
  }): ResolveResult;

  publish(projection: unknown, nowMs: number): Promise<PublishResult>;
  deactivate(key: TenantContextKey, reason: string): Promise<PublishResult>;
  list(): TenantContextSummary[];                 // identifiers only
  stats(): { count: number; minVersion: number | null; oldestPublishedAt: string | null };
}
```

Two implementations: `FileTenantContextRepository` (delegates its four fs calls to the new
`TenantContextStore` class in `state.ts`, keeping the `node:fs` allowance one module wide) and
`MemoryTenantContextRepository` (tests, and `RUNTIME_STATE_BACKEND=memory`).

`validateProjection(input): { ok: true; projection } | { ok: false; errors: string[] }` is a pure
function in `tenantcontext.ts`, exported so WS4 can validate **before** publishing and fail the
provisioning run rather than the customer conversation.

**Structural-test compliance** (must hold, or the build fails):

| Test | Compliance |
|---|---|
| `only src/state.ts touches the filesystem` | `TenantContextStore` lives inside `state.ts` |
| `state.ts imports only mkdirSync, readFileSync, renameSync, writeFileSync` | No new fs import |
| `no file path is ever built from request data` | Fixed basename `tenant-context.json`; the class's only fs targets are `this.file` and `this.tmpFile`, exactly as `FileStateStore` |
| `fetch( appears only in egress.ts` | The publish endpoint is inbound HTTP; no new client |
| gateway `no-direct-network` | Gateway gains no store and no new dependency |

**New runtime configuration:**

| Env | Default | Meaning |
|---|---|---|
| `RUNTIME_ADMIN_TOKEN` | unset | Bearer for `PUT /v1/tenant-context` and `GET /v1/tenant-context`. Unset ⇒ both return `503 no_admin_token_configured`. **It may never authorise `/v1/invoke`** — `resolveCredential` is untouched, and a new test asserts the admin token is rejected by `/v1/invoke` with 401 |
| `RUNTIME_TENANT_CONTEXT_MAX_BYTES` | `16384` | Publish-time cap on the rendered approved block |
| `RUNTIME_TENANT_CONTEXT_MAX_AGE_MS` | `0` (disabled) | F9 staleness |
| `RUNTIME_TENANT_CONTEXT_REQUIRED` | `true` | `false` restores pre-change behaviour for the INTERNAL path only; a PUBLIC run always requires a projection regardless |

> **OWNER DECISION REQUIRED (A-2):** the value of `RUNTIME_TENANT_CONTEXT_MAX_AGE_MS`. A non-zero
> value means a tenant whose control plane goes quiet eventually stops being answered — safe, and
> possibly surprising. Default is disabled; the owner must choose whether staleness is enforced
> and at what age.

> **UNVERIFIED (U-A):** whether the control plane (NocoBase / Activepieces) can reach
> `http://isola_isola-runtime:3000` on the private container network. **Access that settles it:**
> `epic-portal` `listProjectsAndServices` for project `isola`, or a curl from a throwaway probe
> service inside the project. If it cannot, WS4 publishes through a probe/sidecar in-project; the
> runtime must **not** be given a public domain for this.

> **UNVERIFIED (U-B):** the deployed replica count of `isola-runtime` and whether `/data` is a
> single-writer volume. If replicas > 1, a publish reaches one container only and the others fail
> closed. **Access that settles it:** EasyPanel service inspect / `docker service ls` on the host.
> The same question already applies to the existing idempotency store, so this changes no
> assumption — it makes an existing one load-bearing.

---

## PART B — UNIFIED HANDOFF

**The invariant.** There is exactly **one** durable handoff action in the gateway. Deterministic
triggers (attachment, empty message, every runtime failure) and model-initiated escalation both
call it, with the same ledger action names, in the same order.

### B.1 The structured escalation outcome

#### B.1.1 How the model declares it

The runtime has no tools, so an escalation cannot be a tool call. The template prompt gains:

> When you escalate, write your normal short reply to the person **and then**, on the final line
> of your message and nowhere else, write exactly `[[ISOLA_HANDOFF:<reason>]]` where `<reason>`
> is one of: `customer_requested_human`, `dissatisfaction_or_complaint`,
> `outside_supplied_information`, `policy_or_legal`, `commitment_not_authorised`. This marker is
> removed before anyone sees your message. Never mention it. Never write it when you are not
> escalating.

**Runtime processing**, in `app.ts` immediately after `modelClient.complete()` returns and
**before** `content` is assigned — so the persisted text, the idempotency record, and
`answerText` are all the same stripped string and byte-identity is preserved by construction:

```ts
// services/isola-runtime/src/escalation.ts  (new, pure)
export const HANDOFF_SENTINEL = /\[\[ISOLA_HANDOFF:([a-z_]{3,48})\]\]/g;
export const ESCALATION_REASONS = [
  "customer_requested_human","dissatisfaction_or_complaint","outside_supplied_information",
  "policy_or_legal","commitment_not_authorised","unspecified",
] as const;

export function extractEscalation(raw: string): {
  text: string;                                   // every occurrence removed, trailing WS trimmed
  escalation: { requested: true; reason: EscalationReason; declaredBy: "model" } | null;
};
```

Rules:

| # | Rule |
|---|---|
| E-a | **Every** occurrence is stripped, wherever it appears. A marker that reached a customer would be a defect; leaving a misplaced one in place to punish the model is not an option |
| E-b | Escalation is requested if ≥ 1 occurrence existed. The reason is taken from the **last** occurrence |
| E-c | A reason outside the vocabulary collapses to `unspecified` and sets `escalationReasonUnrecognised: true` in the log. It is never rejected — getting a human involved is always the safe direction |
| E-d | If stripping leaves no non-whitespace text, the run is `invalid_output` (existing state, 502). The gateway then escalates with **no** customer message. A bare marker is not an answer |
| E-e | A customer who types the marker themselves can at most cause their own conversation to be handed to a human. That is fail-safe, and is stated here so it is a decision and not an oversight |

#### B.1.2 Inline response, contract v2

`inlineSuccessBody` and `inlineFailureBody` each gain two fields:

```jsonc
{
  "ok": true, "outcome": "ok", "responseMode": "inline", "contractVersion": 2,
  "completionState": "completed", "runId": "…",
  "answerText": "I'll bring in a colleague who can confirm that for you…",

  "escalation": {                                  // null when none was requested
    "requested": true,
    "reason": "policy_or_legal",
    "declaredBy": "model"
  },

  "handoff": {                                     // the tenant's resolved handoff configuration
    "contextVersion": 7,
    "teamId": 4,
    "assigneeUserId": null,
    "allowedReasons": ["customer_requested_human","policy_or_legal", "…"]
  },

  "contextVersion": 7, "contextDigest": "sha256:9f2c…",
  "failureCategory": null, "recorded": true, "recorderError": null,
  "transitioned": false, "issueStatus": null, "replay": false,
  "inputTokens": 1180, "cachedInputTokens": 0, "outputTokens": 96,
  "model": "deepseek-chat", "provider": "deepseek", "durationMs": 3412
}
```

`escalation` is `null` on every failure body (a failure has no model intent to report), and
`handoff` is present whenever a projection resolved — including on failures, so the gateway can
route a failure escalation to the tenant's team without needing the binding's copy.

**Replay.** `RunResultRecord` (`state.ts`) gains `escalation: {requested, reason, declaredBy} | null`.
`resultOf` parses it tolerantly (`null` when absent, exactly as it already does for `answerText`).
A replayed inline request returns the **same** escalation as the original run — no second model
call, no second charge, no reclassification.

#### B.1.3 Runtime log

The existing `event: "invoke"` line gains `escalationRequested` (boolean) and `escalationReason`
(string|null). Neither carries content.

### B.2 Gateway validation

In `pipeline.ts`, after a successful `answer` run and **before** anything is sent:

| # | Check | On failure |
|---|---|---|
| G1 | `result.contractVersion >= 2` | Below 2 ⇒ `escalation` is ignored entirely (old runtime). Log `escalationIgnoredOldContract: true`. Reply normally |
| G2 | `escalation.requested === true` (strict boolean) | Anything else ⇒ ordinary reply, no state change |
| G3 | `escalation.reason ∈ ESCALATION_REASONS` | Unknown ⇒ downgraded to `unspecified`, escalation still performed, log `escalationReasonUnrecognised: true` |
| G4 | `reason ∈ handoff.allowedReasons` | Not listed ⇒ downgraded to `unspecified`, escalation **still performed**, log `escalationReasonNotPermitted: true`. Suppressing a requested handoff is never the safe direction |
| G5 | `handoff.teamId` is a positive integer | Absent/invalid ⇒ escalate **unassigned**, and the private note says so verbatim, exactly as `renderHandoffNote` already does when no team is configured |
| G6 | `handoff.assigneeUserId`, when present, is a positive integer | Invalid ⇒ ignored, logged. Never guessed |
| G7 | `handoff.contextVersion` equals the version the runtime reported resolving | Mismatch ⇒ `handoff_config_inconsistent`, alert, escalate with team `null`. Do not assign on a config we cannot pin |

**Config precedence.** The projection is authoritative for handoff configuration. When
`binding.escalationTeamId` is also set and differs, the projection wins and the gateway logs
`handoffTeamSource: "projection"`, `bindingTeamId`, `projectionTeamId` at WARN. The binding field
is not removed in this change.

> **OWNER DECISION REQUIRED (B-1):** whether `escalationTeamId` is retired from
> `GATEWAY_BINDINGS_JSON` once WS4 publishes every tenant's escalation config in the projection.
> Keeping both is a divergence risk; removing it is an env change on the public component.

### B.3 The canonical human-owned state transition

**One transition, both paths:**

```
POST /api/v1/accounts/{account}/conversations/{display_id}/toggle_status   {"status": "open"}
```

`open` **is** the human-owned state. There is no second mechanism, no parallel flag that decides
who owns a conversation, and no dependence on Chatwoot's native `agent_bot.error_moved_to_open`
(which remains as a backstop and is not duplicated).

The explicit takeover marker of §C is **additive** and is written before the transition — it does
not decide ownership on its own; `open` does.

### B.4 Exactly-once side effects, and how they compose with the ledger

`unifiedHandoff()` in `pipeline.ts` replaces `processHandoff()` and the body of `escalate()`.
Every trigger uses **the same ordered steps and the same action names**:

| Step | Action name (`action_type`) | Effect | Gates the customer message? | Failure behaviour |
|---|---|---|---|---|
| 1 | `handoff_takeover_attrs` | read-merge-write conversation custom attributes: `isola_human_takeover=true`, `isola_takeover_reason=<code>`, `isola_takeover_at=<iso>` | No | Logged, `alertCode: takeover_marker_write_failed`. Continue — `open` already silences the AI |
| 2 | `handoff_toggle_status` | `toggle_status → open` | **Yes** | `handoff_blocked`, `failedStep: "toggle_status"` |
| 3 | `handoff_assignment` | assign `handoff.teamId` (skipped when null) | **Yes**, when a team is configured | `handoff_blocked`, `failedStep: "assignment"` |
| 4 | `handoff_assignment_user` | assign `handoff.assigneeUserId` (skipped when null) | No | Logged. A team already owns it |
| 5 | `handoff_note` | exactly one private note | No | Logged. A missing note does not make the acknowledgement untrue |
| 6 | `customer_message` | **at most one customer-visible message per delivery** | — | §B.5 |

**Step 1 must precede step 3.** `defect-chatwoot-conversations-show-500-agentbot-team-2026-08-11`:
on Chatwoot v4.16.1 an AgentBot's `conversations#show` returns 500 once a team is assigned, and
the attribute write is read-modify-write. Writing the marker after assignment silently drops it —
that is the defect that made escalation attributes disappear. The trailing `annotate()` call keeps
its current position and its current best-effort semantics; it is allowed to fail.

**Ledger composition.** The atomic key is unchanged:

```
PRIMARY KEY (tenant_id, binding_id, chatwoot_account_id, chatwoot_inbox_id, event_id, action_type)
```

Each step above claims its own row under the **same** `LedgerIdentity` with a different
`action_type`. Steps 2–5 use `runGuardedWrite` (idempotent at Chatwoot; an ambiguous claim
re-runs). Step 6 uses `sendGuardedMessage` (prove-absence-or-do-not-send, then reconcile on the
deterministic `deliveryRef(identity, "customer_message")`). A retry, a duplicate delivery, a lease
takeover and a container replacement all reach `claimAction` → `completed` → `skipped`. Nothing is
applied twice; that is Postgres's guarantee, not this code's.

**Action-name unification is a behaviour change and must be deployed carefully.**

| Old name | New name |
|---|---|
| `reply` | `customer_message` |
| `handoff_customer_message` | `customer_message` |
| `escalate_toggle_status` | `handoff_toggle_status` |
| `escalate_assignment` | `handoff_assignment` |
| `handoff_toggle_status`, `handoff_assignment`, `handoff_note` | unchanged |

Collapsing the answer and the acknowledgement onto one `customer_message` action is what makes
"at most one customer-visible message per delivery" true **even when a retry reclassifies the
delivery** (attempt 1 answers, attempt 2 times out, or the reverse). Under the old split names
that case sends two.

**Cutover rule (mandatory, in the deploy runbook).** A delivery still `reserved`/`in_progress`
at cutover carries rows under the old action names, and the new code would not find them. Before
deploying, assert zero in-flight rows:

```sql
SELECT count(*) FROM delivery_ledger
 WHERE action_type = 'delivery' AND delivery_state IN ('reserved','in_progress');
```

Deploy only when this is `0`. The gateway's `drain()` runs on shutdown, so a quiet-period deploy
satisfies it naturally. Completed deliveries are safe: `reserve()` returns `duplicate` and they
are never reprocessed.

### B.5 The customer is never told a transfer that did not happen

| Path | Customer message | When it may be sent |
|---|---|---|
| Deterministic handoff — attachment (E5) | `Thanks — I received your attachment and passed this conversation to a team member for review.` **byte for byte** | Only after step 2 succeeded and, when a team is configured, step 3 succeeded |
| Deterministic handoff — empty message (E6) | `I couldn't read that message, so I passed the conversation to a team member.` **byte for byte** | Same |
| Model escalation | **the model's own reply**, unchanged, exactly as persisted | Only after steps 2 and 3 succeeded. The model's reply *claims* a colleague is taking over, so it is subject to the same gate |
| Runtime/gateway failure (E7–E9), tenant context unavailable (F1–F9) | **nothing at all** | Never |
| `handoff_blocked` (step 2 or 3 failed) | **nothing at all** | Never. The private note says plainly that no message was sent |
| Ambiguous send (`sendGuardedMessage` → `ambiguous`) | **nothing re-sent** | Never. Alert `delivery_state_unresolved`, `needsRetry: true`, the ledger row stays claimed |

**This inverts the model-escalation ordering relative to a normal answer, deliberately.** A normal
answer is sent first and annotated after. An escalating answer is a claim the customer cannot
check, so the state transition happens first and the text is sent only once the claim is true.
`handoff_blocked` on an escalating answer therefore means the customer receives **nothing** —
correct, and better than a polite sentence that is false.

New `DeliveryOutcome` value: `escalated_with_reply` (the model answered, the handoff was recorded,
and that answer was delivered). `handoff_blocked` and `escalated` are unchanged.

### B.6 Handback — the only resume path, exactly once

| # | Rule |
|---|---|
| H1 | Human-owned state = `status !== "pending"` **OR** a user assignee is present **OR** the payload carries `custom_attributes.isola_human_takeover === true` |
| H2 | A handback is a delivery whose payload shows `status === "pending"` **AND** no user assignee **AND** `isola_human_takeover === true`. That combination can only be produced by a human returning the conversation |
| H3 | On a handback the gateway claims `handback_clear` under this delivery's event id, writes `isola_human_takeover=false` and `isola_handback_at=<iso>` (read-merge-write, and the conversation is unassigned at this point so the `conversations#show` defect does not apply), and then proceeds to answer **this same message** |
| H4 | Exactly-once follows from the PK: the clear is claimed under `(tenant, binding, account, inbox, <this event id>, "handback_clear")`. A duplicate delivery, a retry or a restart finds it `completed` and skips. After the clear the marker is false, so later messages are ordinary replies |
| H5 | If the clear **fails or is ambiguous**, the delivery is **suppressed** — no reply, `alertCode: handback_clear_failed`, `needsRetry: true`. If we cannot prove the takeover flag is down, we do not risk talking over a human |
| H6 | The marker is **additive**. When the payload does not carry `custom_attributes` at all, `humanTakeover` is `false`, no handback is detected, and behaviour is exactly today's `pending` + no-assignee predicate. The change can never deadlock a conversation |
| H7 | Suppression runs **pre-ACK** and may not do I/O (Chatwoot's 5-second webhook deadline). The marker is therefore read from the webhook payload or not at all. The gateway never issues `conversations#show` to decide whether to reply |

> **UNVERIFIED (U-C):** whether `conversation.custom_attributes` is actually populated in the
> deployed Chatwoot v4.16.1 agent-bot `message_created` payload. `parseWebhookPayload` reads it
> and `buildRuntimeContext` forwards it, but no captured raw body was inspected this session.
> **Access that settles it:** capture one raw signed webhook body on the deployed gateway (log the
> key set only, never values), or read `app/views/api/v1/models/_conversation.json.jbuilder` on
> `isola-chat.saas00.epic.dm`. If it is absent, H2–H5 never fire and H6 governs — behaviour is
> today's, and the explicit-takeover half of the owner's ruling cannot be implemented on the
> webhook path without a design change.

---

## PART C — CONVERSATION-STATE TRUTH TABLE

### C.1 The ruling, encoded

Inputs, all from the verified webhook payload. `binding` = resolved binding.

| # | binding PUBLIC + active | `status` | user assignee | team assigned | `isola_human_takeover` | Verdict | Reason code |
|---|---|---|---|---|---|---|---|
| 1 | yes | `pending` | none | none | absent/false | **AI may respond** | — |
| 2 | yes | `pending` | none | **team 4** | absent/false | **AI may respond** — team assignment alone is routing metadata | — |
| 3 | yes | `pending` | **user 6** | any | any | silence | `human_assigned` |
| 4 | yes | `open` | none | any | any | silence | `status_not_pending` |
| 5 | yes | `resolved` | any | any | any | silence | `status_not_pending` |
| 6 | yes | `snoozed` | any | any | any | silence | `status_not_pending` |
| 7 | yes | `pending` | none | any | **true** | silence, **then handback** (§B.6 H2–H5) | `human_takeover` → resume this message after `handback_clear` |
| 8 | yes | `pending` | none | any | true, clear **failed** | silence | `handback_clear_failed` |
| 9 | **no** (retired / not found / duplicate / not PUBLIC) | any | any | any | any | silence, before any of the above | `binding_retired` / `binding_not_found` / `binding_duplicate` / `binding_not_public` |
| 10 | yes | `pending` | none | any | false | AI may respond — this is the state after a completed handback | — |

Non-ownership suppressions, evaluated first and unchanged: `not_message_created`,
`no_conversation_id`, `message_type_not_incoming`, `private_note`, `private_flag_absent`,
`sender_is_agent_bot`.

**Evaluation order** in `evaluateSuppression` (order is load-bearing):

```
event → conversation id → message_type → private → private_flag → sender
      → status_not_pending → human_assigned → human_takeover (new)
      → no usable text ⇒ handoff
      → reply
```

`human_takeover` is placed **after** `human_assigned` for the same reason `status_not_pending`
comes first: once a gateway handoff has opened and assigned the conversation, the earlier, cheaper
predicate already silences it, and the marker never has to carry that weight alone.

### C.2 Reconciliation against the code as it actually is today

| # | The ruling says | The code does (`webhook.ts:368-397`) | Difference | Action |
|---|---|---|---|---|
| R1 | Team assignment alone is routing metadata and does not silence AI | `hasAssignee` reads `conversation.meta.assignee` — the **user** node. `meta.team` is never read | **None.** The code already matches | No change. Add an explicit unit test so it cannot regress silently |
| R2 | `open` status silences AI | `conversationStatus !== "pending"` ⇒ `status_not_pending` | None (and it is broader: `resolved`/`snoozed` too, which is correct) | No change |
| R3 | A human user assignee silences AI | `hasAssignee(payload.assignee)` ⇒ `human_assigned` | None | No change |
| R4 | An **explicit human-takeover state** silences AI | **No such state exists.** There is no marker, and nothing writes one | **Difference 1** | Add `isola_human_takeover` (§B.4 step 1), and row 7 of C.1 |
| R5 | AI may respond only when the PUBLIC binding is active | Enforced, but in `resolveBinding` (`app.ts:285-311`) — *before* `evaluateSuppression`, not inside it | **Difference 2 — layering only.** The property holds; it is checked one layer up | No behaviour change. Documented in C.1 row 9 so the whole rule is in one table |
| R6 | Handback clears human-owned state and resumes AI exactly once | No handback concept. Resume is implicit: the next message with `pending` + no assignee is answered. Nothing is cleared, and "exactly once" is a property of message arrival, not of a claim | **Difference 3** | Add `handback_clear` (§B.6), claimed under the ledger PK |
| R7 | — | Six additional fail-closed suppressions the ruling does not mention (`private_flag_absent` etc.) | **Difference 4 — additive.** All are stricter than the ruling | Keep. Named here so "the code silences more than the ruling requires" is a recorded decision |
| R8 | — | `conversationStatus` and `assignee` come from the **payload**, i.e. state as of message creation. A human taking over between message creation and delivery is not seen | **Difference 5 — a race the ruling does not address.** Closing it requires a `conversations#show` read on the pre-ACK path, which the 5-second deadline forbids | Accept, and record it. The window is one webhook hop and the failure mode is one AI message immediately after a takeover |

---

## PART D — PROOF PLAN

**Safety preamble.** Every scenario runs against the deployed EasyPanel project `isola` with
**synthetic tenants and synthetic contacts only**. Touch no real Meta/WhatsApp asset, no real
customer conversation, no live Paperclip employee outside the two synthetic ones, no NocoBase
schema, no Activepieces flow. The runtime has no public domain: reach it from a throwaway probe
service inside the project at `http://isola_isola-runtime:3000`, exactly as the 14/14 boundary
evidence was produced. Gateway `https://isola-gw.saas00.epic.dm`; Chatwoot
`https://isola-chat.saas00.epic.dm` (account 3, inbox 4, team 4, AgentBot 1).

**Method:** **LDO** = live-deployed observation · **API** = API assertion · **UT** = unit test.

**Fixtures.** Two synthetic tenants, each with its own Paperclip company, its own PUBLIC employee,
its own Chatwoot inbox and its own binding. Each projection contains a **unique sentinel fact**
present in no other fixture:

| Tenant | Sentinel fact | Sentinel that must never appear |
|---|---|---|
| `tnt-synth-a` — "Aurora Boat Yard" | `offers[]` contains "Hull cleaning", `price: "EC$450 per visit"` | `Zephyr`, `EC$1,275`, `Kite rigging` |
| `tnt-synth-b` — "Zephyr Kite School" | `offers[]` contains "Kite rigging", `price: "EC$1,275 per course"` | `Aurora`, `EC$450`, `Hull cleaning` |

### D.1 Tenant context

| # | Given | When | Then | Exact observable pass signal | Method |
|---|---|---|---|---|---|
| TC-1 | Projection A published, version 1 | `PUT /v1/tenant-context` with A's projection | Accepted and readable back | `200 {"outcome":"published","contextVersion":1,"contextDigest":"sha256:…"}`; `GET /v1/tenant-context` lists exactly the summary — `contentBytes` present, **no `content` field in the response** | API |
| TC-2 | Projection A active | Direct `POST /v1/invoke`, PUBLIC bearer, `responseMode:"inline"`, context `{tenantId:"tnt-synth-a", agent:{agentId:…}, message:{content:"what services do you offer and how much?"}}` | Answers from A only | `completionState:"completed"`; `answerText` contains `Hull cleaning` and `EC$450`; contains none of B's sentinels; `contextVersion:1` echoed | API |
| TC-3 | Projections A and B both active | Same call with `tenantId:"tnt-synth-b"` | Answers from B only | `answerText` contains `Kite rigging` and `EC$1,275`; contains none of A's sentinels | API |
| TC-4 | Projections A and B both active | Invoke for A asking a question whose answer exists only in B ("do you teach kitesurfing?") | Does not know; does not cross tenants | `answerText` contains no B sentinel and no invented service; it says it does not have that detail and offers a colleague | API |
| TC-5 | No projection for `tnt-synth-c` | Invoke with `tenantId:"tnt-synth-c"` | Denied before the model is called | HTTP **409**, `completionState:"context_unavailable"`, `failureCategory:"tenant_context_missing"`, `answerText:null`; **no cost event** for that run in Paperclip; runtime log `alertCode:"tenant_context_missing"` | API |
| TC-6 | Projection A `status:"inactive"` | Invoke for A | Denied | HTTP 409, `failureCategory:"tenant_context_inactive"`, `answerText:null` | API |
| TC-7 | Projection A at version 2; caller asserts `expectedDigest` of version 1 | Invoke for A | Denied, never served the wrong version | HTTP 409, `failureCategory:"tenant_context_mismatch"`; log carries `storedVersion:2`, `expectedVersion:1` | API |
| TC-8 | Projection A at version 1 | Publish version 2 (price changed to `EC$495`), then invoke | The new version is read back | `contextVersion:2` echoed; `answerText` contains `EC$495` and not `EC$450`. `PUT` of version 1 afterwards is refused with `contextVersion must exceed 1` | API |
| TC-9 | Two synthetic tenants provisioned by two separate `provision-employees.ts --target` invocations, no manual DB edits | Inspect Paperclip and the runtime | Two independent tenants, no duplicates | Two agents with distinct `metadata.isolaTemplateId` instances on two companies; `GET /v1/tenant-context` lists exactly two summaries; `findExistingForTemplate` throws on neither | LDO |
| TC-10 | Publish a projection carrying `"api_key": "sk-abcdefgh"`, a `https://` URL outside `contact_routes`, and the word "Paperclip" | `PUT /v1/tenant-context` | Refused, values never echoed | `409 {"outcome":"tenant_context_publish_rejected"}`; the error list names `content.business.api_key`, `content.policies[0].text`, `content.offers[1].description` and contains neither `sk-abcdefgh` nor the URL | UT + API |
| TC-11 | Projection rendering to 20 KiB | Publish | Refused at publish, never truncated at run time | `409`, error names the byte count and the 16384 cap | UT |
| TC-12 | `RUNTIME_ADMIN_TOKEN` set | `POST /v1/invoke` with the admin token as bearer | Rejected | HTTP **401**. The admin token can never run a template | API |
| TC-13 | Gateway binding for A carries `contextVersion:1`, `contextDigest` of version 1; runtime holds version 2 | Deliver a signed webhook | Fails closed, escalates, says nothing | Gateway log `outcome:"tenant_context_unavailable"`; Chatwoot: conversation `open`, exactly **1** private note, **0** customer-visible messages, label `isola-ai-escalated` | LDO |
| TC-14 | **S29b, direct path.** Projection A active | `POST /v1/invoke` PUBLIC bearer, `inline`, business question | Answers from the projection | `completionState:"completed"`; `answerText` names only services in A's `offers[]`; quotes a price only where A states one | API |
| TC-15 | **S29b, deployed gateway path.** Same projection, binding A, inbox 4 | Signed `message_created` webhook carrying the same question | Same answer reaches the customer | Chatwoot shows exactly **1** outgoing bot message; its text names only A's services; conversation stays `pending`; label `isola-ai-answered` | LDO |
| TC-16 | TC-14 and TC-15 run back to back with the same `runId` | Compare Paperclip and the ledger | No duplicate model run, cost event or reply | Paperclip: exactly **1** comment and **1** cost event for that run id; second response carries `replay:true` in 3–4 ms; Chatwoot bot message count unchanged | LDO |
| TC-17 | A full delivery driven end to end with sentinel business strings | Scan every emitted gateway and runtime log line | No content leaks | Zero lines contain any sentinel business string, the customer's message, the answer, or any bearer. `contextDigest` and `contextVersion` are present | LDO + UT |

### D.2 Unified handoff

| # | Given | When | Then | Exact observable pass signal | Method |
|---|---|---|---|---|---|
| HO-1 | Tenant A active, conversation `pending`, unassigned | Customer sends "I want to speak to a person" | Model escalates; the conversation is really transferred | Runtime response `escalation:{requested:true,reason:"customer_requested_human"}`, `answerText` contains **no** `[[ISOLA_HANDOFF` marker. Chatwoot: status `open`, team **4** assigned, exactly **1** private note, exactly **1** customer-visible message (the model's reply), attribute `isola_human_takeover:"true"` | LDO |
| HO-2 | As HO-1 | Customer sends an indirect request the model identifies ("this is going nowhere, is anyone actually there?") | Same transfer, reason recorded | `escalation.reason:"dissatisfaction_or_complaint"`; same Chatwoot end state as HO-1 | LDO |
| HO-3 | As HO-1 | Customer asks "what are my refund rights under Dominica law?" | Escalates, gives no legal statement | `escalation.reason:"policy_or_legal"`; `answerText` contains no rights statement; conversation `open` + assigned | LDO |
| HO-4 | As HO-1, question outside the projection ("do you sell outboard motors?" — absent from `offers[]`) | Customer asks | Says it does not know **and** escalates | `escalation.reason:"outside_supplied_information"`; `answerText` invents no product; conversation `open` + assigned | LDO |
| HO-5 | Conversation `pending`, **team 4 assigned**, no user assignee, marker absent | Customer sends an ordinary question | AI answers — team-only routing does not silence | Bot message count 0 → 1; gateway log has no `suppressionReason` | LDO |
| HO-6 | Answered conversation | Human assigns themselves and opens it; customer sends another message | AI is silent | Bot message count identical before and after; `suppressionReason ∈ {status_not_pending, human_assigned}` | LDO |
| HO-7 | As HO-6, plus `isola_human_takeover:"true"` set by a prior escalation | Human sets `toggle_status {"status":"pending"}` and clears the assignee; customer sends a message | AI resumes **exactly once**, and the marker is cleared | Bot count 1 → 2, not 1 → 3; conversation attribute `isola_human_takeover:"false"`, `isola_handback_at` present; ledger has exactly one `handback_clear` row, `delivery_state:"completed"` | LDO |
| HO-8 | As HO-7 but the attribute write is made to fail (failpoint or a revoked token) | Same handback | Fails closed — silence, not a reply | Bot count unchanged; gateway log `alertCode:"handback_clear_failed"`, `needsRetry:true` | LDO |
| HO-9 | Model escalation, `toggle_status` forced to fail | Customer asks for a human | `handoff_blocked` — **the customer is told nothing** | **0** customer-visible messages; exactly 1 private note whose text states no message was sent; log `outcome:"handoff_blocked"`, `failedStep:"toggle_status"`, `customerMessageSent:false`, `needsRetry:true` | LDO |
| HO-10 | Model escalation, `toggle_status` succeeds, team `assignments` forced to fail | Customer asks for a human | Same: conversation left `open`, customer told nothing | 0 customer-visible messages; note states `failedStep: assignment`; conversation status is `open` (not rolled back) | LDO |
| HO-11 | A completed handoff delivery | Re-deliver the same `X-Chatwoot-Delivery` id | Nothing repeats | `200 duplicate_suppressed`; Chatwoot message, note and assignment counts all unchanged; no new ledger rows | LDO |
| HO-12 | A handoff delivery interrupted mid-way (failpoint `after_chatwoot_commit_before_ledger_complete` on `customer_message`) | Restart the container; let one recovery sweep run | Exactly one customer message survives | Bot message count = 1; the surviving message carries the `isola_delivery_ref` for `customer_message`; ledger row `completed` | LDO |
| HO-13 | Attachment-only message (payload carries `file_name` and `data_url`) | Deliver | Deterministic handoff, unchanged verbatim string | Conversation `open`; 1 private note naming `attachment_or_unsupported_content` and the **type only**; exactly 1 customer message equal byte for byte to `Thanks — I received your attachment and passed this conversation to a team member for review.`; the attachment host appears in no egress record | LDO |
| HO-14 | Message with no readable content | Deliver | Deterministic handoff, unchanged verbatim string | Exactly 1 customer message equal byte for byte to `I couldn't read that message, so I passed the conversation to a team member.` | LDO |
| HO-15 | Runtime returns 504 | Deliver | Failure escalation through the **same** unified action | 0 customer messages; 1 private note naming `model_timeout`; conversation `open` + team assigned; label `isola-ai-escalated`; ledger rows exist under `handoff_toggle_status` / `handoff_assignment` / `handoff_note` — **not** the retired `escalate_*` names | LDO |
| HO-16 | A model reply containing `[[ISOLA_HANDOFF:not_a_real_reason]]` mid-sentence and again at the end | Invoke | Every marker stripped; escalation still honoured | `answerText` contains no `[[`; `escalation.reason:"unspecified"`; log `escalationReasonUnrecognised:true` | UT + API |
| HO-17 | A model reply consisting only of the marker | Invoke | Not treated as an answer | HTTP 502, `completionState:"invalid_output"`, `answerText:null`; gateway escalates with 0 customer messages | UT + API |
| HO-18 | A run with `escalation.requested:true` | Replay the same `runId` twice | Escalation is reproduced, not recomputed | 2nd and 3rd responses carry `replay:true` and the identical `escalation` object; Paperclip shows exactly 1 comment and 1 cost event | API |
| HO-19 | Gateway on contract v1 (old build) against a v2 runtime | Model escalates | Escalation ignored, reply still delivered | 1 customer message; conversation stays `pending`; log `escalationIgnoredOldContract:true`. Proves safe degradation in the deploy window | UT |
| HO-20 | Projection A with `escalation.allowed_reasons` omitting `policy_or_legal`; binding sets `escalationTeamId: 9` | Customer asks a legal question | Escalates anyway, downgraded; the projection's team wins | Escalation performed with reason `unspecified`; assigned to team **4** (projection), not 9; logs `escalationReasonNotPermitted:true` and `handoffTeamSource:"projection"` | LDO |

---

## PART E — TARGETED REGRESSION SET

WS2 is `ACCEPTED_8_OF_8` and is not reopened. Exactly these proofs are rerun, each because a
change in this contract touches the code path that produced it. Nothing else.

| WS2 / spec proof | What it proved | Why these changes could disturb it | Rerun |
|---|---|---|---|
| **L1, L2** (S13) | One AI reply; conversation stays `pending`; label `isola-ai-answered` | `buildRuntimeContext` changes signature, a new pre-reply escalation branch is added, and the answer's write action is renamed `reply` → `customer_message` | **Yes** — TC-15 covers it |
| **L3, L4** (S16) | AI silent after human takeover | `evaluateSuppression` gains a ninth condition (`human_takeover`) | **Yes** — HO-6 |
| **L6, L7** (S18) | AI resumes exactly once after handback (1 → 2, not 1 → 3) | Handback becomes explicit and ledger-claimed; a bug here turns "resumes once" into "never resumes" | **Yes** — HO-7, plus HO-8 for the fail-closed half |
| **H1, H2** (S21, S22) | Attachment and empty-message handoffs; verbatim strings; exactly one note and one ack | `processHandoff` is replaced by `unifiedHandoff`; the ack's action name changes; a new step 1 is inserted before the status toggle | **Yes** — HO-13, HO-14 |
| **H3 / N9** (S19) | Duplicate delivery → no second reply | New action names and a new `handback_clear` action under the same primary key | **Yes** — HO-11 |
| **WS2 durability** (S20) | Duplicate after container replacement → no second reply | Same, plus the cutover rule in §B.4 | **Yes** — HO-11 after a container replacement, and HO-12 |
| **N11–N13** (S15) | Outgoing / private / bot-authored messages suppressed | The suppression predicate is edited | **Yes** — cheap, three signed webhooks |
| **S27** (`no-content-logged`) | No content or secret in any log line | New log fields (`contextVersion`, `contextDigest`, `agentId`, escalation fields) and a new class of content (business facts) now exists inside the runtime | **Yes** — TC-17, extended with business sentinels |
| **S28** (`ledger-no-content`) | No content-bearing ledger column | New `action_type` values are added. The DDL is not modified, so this must still pass **unchanged** | **Yes** — it is a unit test; running it is free and it is the guard on the owner's ruling |
| **S8 / matrix row 2, 3** (inline contract) | `persistence_failed`, `timeout`, `provider_error` reported truthfully; `answerText` null on failure | `RESPONSE_CONTRACT_VERSION` goes to 2, `COMPLETION_STATES` gains a member, and the answer string is now the *stripped* string | **Yes** — `test/inline.test.ts` plus one live 504 (HO-15) |
| **S10 / matrix row 5** (replay) | No second model call, comment or charge | `RunResultRecord` gains `escalation`; `resultOf` parses a new field | **Yes** — HO-18 |
| **B4, B14** (tool policy, injection) | Registry policy cannot be widened from the body | The system prompt text changes and a new request field (`agent`, `tenantContext`) is accepted | **Yes** — B4 and B14 only. They are two API calls and they guard the whole exposure argument |

**Deliberately NOT rerun**, with the reason:

| Not rerun | Why |
|---|---|
| Matrix row 6 / S11, S12 (budget alert, hard stop) | Untouched. The only interaction is that a context refusal happens **before** the budget reservation, which makes the budget path strictly less exercised, not differently exercised |
| S9 / matrix row 4 (agent key company scoping) | Paperclip-side; no code here touches agent keys or company scoping |
| B1, B2, B3, B5–B13 | Deployment, registration, egress and auth boundaries, none of which change. `RUNTIME_ADMIN_TOKEN` is new, so TC-12 is a **new** proof rather than a rerun of B5/B6 |
| S14 (signature negatives), S23–S26 (boot refusals, ledger unavailable, digest conflict) | Signature verification, boot validation and the reserve-before-ACK path are untouched. `bindings.ts` gains two optional identifier fields, which S23/S24 do not exercise — but a single boot with a malformed `contextDigest` should be added as a **new** unit case in `test/bindings.test.ts` rather than a rerun |
| S29 (orphan → first reply, deployed) | Still awaits the owner ruling recorded in the frozen spec (freeze register #8). This contract neither closes nor disturbs it |

---

## Open items raised by this contract

| # | Kind | Item |
|---|---|---|
| A-1 | **OWNER DECISION REQUIRED** | Whether amending `FRONT_DESK_PROMPT` (approved-business block + escalation sentinel) ships as an in-place change to `isola-ai-sales-front-desk-agent@v1` or forces `@v2`, given the v1 scope freeze (§A.3.4) |
| A-2 | **OWNER DECISION REQUIRED** | The value of `RUNTIME_TENANT_CONTEXT_MAX_AGE_MS` — whether projection staleness is enforced at all, and at what age (§A.7, F9) |
| B-1 | **OWNER DECISION REQUIRED** | Whether `escalationTeamId` is retired from `GATEWAY_BINDINGS_JSON` once the projection carries escalation configuration (§B.2) |
| B-2 | **OWNER DECISION REQUIRED** | Whether a model-initiated escalation may assign a specific **user** (`escalation.chatwoot_assignee_user_id`) as well as a team. Default in this contract is `null` — team only — because a user assignee permanently trips `human_assigned` and, per `defect-chatwoot-conversations-show-500-agentbot-team-2026-08-11`, worsens the bot's ability to read the conversation back |
| U-A | **UNVERIFIED** | Whether the control plane can reach `http://isola_isola-runtime:3000` on the private container network. Settled by `epic-portal listProjectsAndServices` for project `isola`, or a curl from an in-project probe (§A.7) |
| U-B | **UNVERIFIED** | `isola-runtime` replica count and whether `/data` is single-writer. Settled by an EasyPanel service inspect / `docker service ls` on the host (§A.7) |
| U-C | **UNVERIFIED** | Whether `conversation.custom_attributes` is populated in the deployed v4.16.1 agent-bot `message_created` payload. Settled by capturing one raw signed webhook body (key set only), or reading `_conversation.json.jbuilder` on `isola-chat.saas00.epic.dm` (§B.6) |
| — | Carried, unchanged | Frozen-spec OWNER DECISIONS 1, 3, 4, 6, 7 and 8, and UNVERIFIED U0–U7, are **not** addressed here. In particular, this contract creates **no lead record sink** (frozen spec §4.3) and does **not** resolve the two-processor silence question beyond honouring `CANONICAL_PROCESSOR=ISOLA_GATEWAY_EASYPANEL` |
