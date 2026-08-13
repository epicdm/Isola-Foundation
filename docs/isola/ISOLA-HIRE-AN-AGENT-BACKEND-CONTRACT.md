# Isola Hire-an-Agent — CANONICAL backend contract

**Status:** CANONICAL. Supersedes both prior drafts.
**Ratified against:** the deployed `apps.isola_provisioning` Django backend, PR #3's gap
analysis, and the ratified Port decisions. (A candidate TypeScript validator was also
consulted; it has since been deleted — see §8.)

**Serving implementation:** `epicdm/isola-portal` PR #11 —
`packages/backend/apps/isola_provisioning/{hire_serializers,hire_views,catalogue}.py`.

**Supersedes**
- the earlier draft in this file (invented vocabulary — withdrawn, see §9);
- `docs/isola/HIRE-AGENT-BACKEND-CONTRACT.md` on `epicdm/isola-portal@feat/isola-hire-an-agent-2026-08-12` — its analysis is **adopted**, and that file must be reduced to a pointer to this document before PR #3 merges. This lane did not edit it (Cowork is patching that branch).

---

## 0. The two structural rules

> **R1 — Predefined only.** The portal hires a **catalogue entry**, never an agent
> specification. If a request can express an agent the catalogue does not already
> describe, the contract is wrong.
>
> **R2 — The portal never calls Paperclip.** Nor NocoBase, Activepieces or Chatwoot.
> Its only agent dependency is the Foundation API.

Unknown fields are a hard **400**, never ignored. Silently dropping an unrecognised key is
how a general creator re-emerges, one "harmless" passthrough at a time.

---

## 1. Vocabulary — one set of names, no synonyms

The earlier draft invented `catalogue_key` / `catalogue_version`. **The deployed backend
and the shipped frontend win.** Canonical names, matching `apps.isola_provisioning`:

| Canonical | Meaning | Rejected synonym |
|---|---|---|
| `template_id` | stable catalogue entry id (`staff-ops-coordinator`, `sales-front-desk`) | ~~`catalogue_key`~~ |
| `template_version` | immutable version of that entry | ~~`catalogue_version`~~ |
| `template_digest` | content hash of the resolved entry, **including exposure** | ~~`profile_digest`~~ |
| `idempotency_key` | caller-supplied, scopes retry | — |
| `correlation_id` | minted server-side, returned to the client | — |

**No translation boundary exists, and none may be introduced.** The canonical names above are
the only ones on the wire. The candidate that used the rejected names has been **deleted**
(§8); the authoritative validator is `apps/isola_provisioning/hire_serializers.py`, which
speaks the canonical set natively. **No adapter, alias or compatibility shim may be
introduced to revive the rejected vocabulary.**

---

## 2. Tenant identity — session only

Tenant comes **exclusively from the authenticated server-side session**. A tenant in the
body is a hard 400.

The existing route shape is `/api/isola/tenants/{tenant_id}/…`. That path parameter is an
**addressing assertion, not a source of identity**: it must match a tenant the session
holds membership in, and a mismatch returns **404, not 403** — the `_tenant_for` pattern
`views.py` already uses, which is correctly non-enumerating.

Evidenced as already true: an authenticated probe of
`GET /api/isola/tenants/8D3dp3z/company/` resolved only to the caller's own tenant
regardless of URL contents (`evidence-pm-cowork-uat3-uat4-authenticated-2026-08-12`).

**Canonical tenant key: `8D3dp3z`** (`decision-epic-customer-zero-canonical-tenant-key-8d3dp3z-2026-08-12`).
`AVQLG3L` is a synthetic acceptance fixture; `isola-uat-a` and `43b006e4` are prohibited
for production routing.

---

## 3. Server-resolved — never caller-authored

Resolved server-side from `(template_id, template_version)` and its registry row:
exposure · prompts and instructions · adapter and model · tools · URLs · permissions ·
budget · heartbeat and wake policy · lifecycle · acceptance job · Paperclip configuration.

**Exposure is omitted from the authoritative request entirely.** `INTERNAL`/`PUBLIC` is an
immutable property of the resolved entry. If a future client sends `exposure`, the server
**rejects with 400** on any mismatch rather than ignoring it — exposure gates whether an
agent can ever reach a customer channel, so it must be as trusted as an authorization
decision, not display metadata. The frontend's per-card exposure badge stays display copy
and must never be serialized into the request.

---

## 4. The wire contract

An earlier revision named five inputs and then said "exactly four fields". Both were true
of different things and the sentence was ambiguous. Resolved below: **five named inputs =
four JSON body fields + one server-generated value.**

Conventions taken from the deployed app (`apps/isola_provisioning/{urls,views,serializers}.py`),
not invented.

### 4.1 Inputs by location

| # | Location | Name | Required | Notes |
|---|---|---|---|---|
| 1 | **URL path** | `tenant_id` | yes | `<str:tenant_id>`, matching the existing route style. An **addressing assertion, not identity** — resolved only via `_tenant_for`, which filters `Tenant.objects.filter(members=request.user)` and returns **404 not 403**, so the endpoint cannot enumerate tenant ids. Checked **before** any tenant-specific state is exposed. |
| 2 | **Session** | authenticated user | yes | DRF `IsAuthenticated`. **The sole source of tenant identity.** |
| 3 | **Header** | `Content-Type: application/json` | yes | — |
| 4 | **JSON body** | `template_id` | yes | see schema |
| 5 | **JSON body** | `template_version` | yes | see schema |
| 6 | **JSON body** | `template_digest` | yes | see schema |
| 7 | **JSON body** | `idempotency_key` | yes | body, **not** a header — this app has no `Idempotency-Key` header convention, and inventing one here would be a second convention to maintain |
| 8 | **Server-generated** | `correlation_id` | n/a | minted server-side, **never accepted from the client**, returned in the response |
| 9 | **Server-generated** | hire id, step states, `external_ref`, `blocked_reason` | n/a | response only |

**No optional body fields exist.** All four are required.

### 4.2 Schema
`docs/isola/schemas/hire-request.schema.json` — `additionalProperties: false`, all four
required. It is the authority; this table is its prose.

### 4.3 Canonical request

```http
POST /api/isola/tenants/8D3dp3z/hires/ HTTP/1.1
Host: isola-portal.saas00.epic.dm
Content-Type: application/json
Cookie: sessionid=<authenticated session>

{
  "template_id": "sales-front-desk",
  "template_version": "v1",
  "template_digest": "sha256:3f8c1d9e2b7a4650c1de83f47a2b95c0e6d417a8b3925fce04d1b8a76e5c2093",
  "idempotency_key": "hire-sales-front-desk-8D3dp3z-001"
}
```

Exactly four JSON fields. No `exposure`. No `tenant_id` in the body. No `correlation_id`.

### 4.4 Validation and normalisation

- **Unknown property → 400**, listing the offending name. ⚠ **DRF serializers ignore
  unknown fields by default** — that default is precisely the silent-drop failure this
  contract forbids, so the serializer MUST override `to_internal_value` (or equivalent) to
  reject them. This is an implementation obligation, not a nicety.
- **Prohibited property → 400**, distinct message (see §4.6).
- **`null`** for any of the four → 400 `invalid_field`. `null` is never "absent".
- **Wrong type** (number, boolean, object, array where a string is required) → 400.
- **Whitespace:** values are `.strip()`ed before validation, matching
  `CompanyProfileSerializer.validate_legal_name`. A value that is empty after stripping →
  400. No other normalisation — `template_id` is **case-sensitive** and is not lower-cased
  (unlike `country`, which the deployed serializer upper-cases, because that is an ISO code
  and this is a registry key).
- Ordering: **404 tenant → 400 shape → 404 unknown template → 409 version/digest → 409
  idempotency conflict → 403 entitlement → 200/202**. Tenant resolution is first so no
  tenant-specific state leaks to a non-member.

### 4.5 Idempotency

Scope: **(authenticated tenant, requester, operation, `idempotency_key`)** — not the key
alone. The same key from a different requester or tenant is a different record.

- Same key + **identical canonical request** → the **original** result, replayed verbatim
  (`200`, not a second `202`). Canonical form = the four fields, whitespace-stripped,
  serialised with sorted keys.
- Same key + **different canonical request** → deterministic **409 `idempotency_conflict`**,
  naming the field that differs. The server never picks a winner.

```http
HTTP/1.1 409 Conflict
{
  "detail": "idempotency_conflict",
  "idempotency_key": "hire-sales-front-desk-8D3dp3z-001",
  "conflicting_fields": ["template_version"],
  "original_request_id": "hire_7Kq2mVx",
  "correlation_id": "0f2c8a51-6d3e-4b17-9c84-2a5f7e1b0d36"
}
```

### 4.6 Exposure is prohibited, not merely absent

**Any client-supplied `exposure` receives 400 — even when its value matches the resolved
template.** It is a prohibited property, not an unknown one, and gets its own message so
the refusal is unmistakable.

The server must not: accept a matching value · silently discard it · treat it as advisory ·
normalise it into the resolved template.

```http
POST /api/isola/tenants/8D3dp3z/hires/
{ "template_id": "sales-front-desk", "template_version": "v1",
  "template_digest": "sha256:3f8c…2093", "idempotency_key": "hire-…-001",
  "exposure": "PUBLIC" }

HTTP/1.1 400 Bad Request
{
  "detail": "prohibited_field",
  "field": "exposure",
  "message": "exposure is resolved server-side from the template registry and must never be supplied by the caller"
}
```

`"PUBLIC"` there is the *correct* value for that template and is still rejected. Accepting
a matching value would make the field load-bearing the day the template changes.

The **response** may report the server-resolved exposure, after authorization.

### 4.7 Failure summary

| Condition | Status |
|---|---|
| tenant not a membership of the session | **404** (before any tenant state) |
| unknown property | **400** |
| prohibited property (`exposure`, `tenant_id`, any behaviour field) | **400** |
| `null`, wrong type, empty-after-strip | **400** |
| unknown `template_id` | **404** |
| `template_version` / `template_digest` mismatch | **409**, never coerced to latest |
| same key, different canonical request | **409 `idempotency_conflict`** |
| missing entitlement | **403 `not_entitled`** |
| missing WS4 projection / `acceptance_job` | **202 + `BLOCKED`** (§6) — honest, not an error |

There is **no field through which behaviour can be supplied.** `display_name` and
`options` from the earlier draft are **dropped**: no catalogue entry defines a
`customisable` allowlist today, so accepting them would be accepting unvalidated input.

---

## 5. Lifecycle and state — reuse, do not reinvent

Reuse `constants.StepState` verbatim: `PENDING` · `BLOCKED` · `IN_PROGRESS` · `SUCCEEDED` ·
`FAILED` · `SKIPPED`, with its invariants — `SUCCEEDED` requires an `external_ref`,
`BLOCKED` requires a `blocked_reason`, transitions follow an explicit
`ALLOWED_STEP_TRANSITIONS` table.

A hire is a `ProvisioningRun` scoped to **one template** rather than the whole tenant,
keyed `(tenant, template_id)`.

**Submission creates a pending provisioning request. It never creates an accepted agent.**
The agent lands `staged-not-ready`; `accepted` requires a PASS from the entry's *current*
`acceptance_job` version (`ISOLA-ACCEPTANCE-JOBS-V1.md`). A job-version bump invalidates
prior acceptance.

**Exposure is enforced at the bind step, structurally.** The `chatwoot_workspace` and
`gateway_binding` steps must be *unreachable* for a hire resolved `INTERNAL` — enforced by
the transition table and service layer, not skipped by convention, so a bug elsewhere
cannot expose an INTERNAL agent.

This composes with deployed gateway enforcement: a binding routes only when
`status=active`, exposure `PUBLIC`, and `lifecycle` is exactly `"accepted"`
(precedence `match → status → exposure → lifecycle`). The WS4 projection must emit
`lifecycle` explicitly; omission yields a non-routable binding.

---

## 6. Honest blocked state

A hire that cannot proceed returns **which step is blocked and a human-readable reason**,
mirroring `blocked_steps` / `next_actionable_step`. Never a generic failure, never a
fabricated success.

While WS4 is unavailable (`bt-ws4-nocobase-control-plane-mapping-2026-08-12`), the endpoint
**must fail closed with `BLOCKED`** and a reason naming the missing projection. It must not
create a shadow tenant mapping or write directly to NocoBase.

---

## 7. Approval, idempotency, response

**Self-approval is refused** by comparing the approving principal against the requester —
the submitting session has the strongest incentive to wave its own work through. Paperclip
returning **409** to a direct `POST /agents` is the gate working, not a bug.

**Idempotent retry returns the same safe result**, scoped `(tenant, template_id,
idempotency_key)`; a different payload under a live key is **409**, never a silent winner.

**The response carries safe references only** — hire id, `correlation_id`, step states,
`external_ref`, blocked reasons. Never a credential, token, adapter config or raw provider
configuration. Credential-reference-only, without exception. Any URL rendered anywhere has
`user:password@` stripped first.

---

## 8. The serving validator — AMENDED 2026-08-12: the candidate is DELETED, not moved

> **This section previously directed moving `artifacts/isola/lib/hire-request-validator.ts`
> into the serving package. That instruction is WITHDRAWN.** It was written when no serving
> implementation existed. One exists now, and following the old text would have produced a
> second, contradictory validator. Amended in Port on
> `decision-canonical-hire-agent-backend-contract-2026-08-12` (ERRATUM 2).

**The authoritative validator is `packages/backend/apps/isola_provisioning/hire_serializers.py`**
in `epicdm/isola-portal` (PR #11). It validates the four-field body in the serving package,
in the language the server runs, and it implements this contract's §E4 obligation:
`to_internal_value` refuses unknown names before any field validation, with three
distinguishable refusal classes — `prohibited_field`, `unknown_field`, `invalid_field`.

**The candidate at `artifacts/isola/lib/hire-request-validator.ts` has been DELETED.** It was
untracked, imported by nothing outside its own test file, and — decisively — it did not merely
use the withdrawn *names*, it accepted a **seven**-field surface:
`catalogue_key, catalogue_version, profile_digest, display_name, options, idempotency_key,
correlation_id`. Three of those are prohibited by this contract: `display_name` and `options`
were dropped (§9), and `correlation_id` is server-generated and **never accepted from the
client** (§E1) — `hire_serializers.py` correctly lists it as prohibited. Moving it into the
serving package would have contradicted this contract, not merely duplicated it.

Its tests were used as a **conformance checklist** against PR #11 rather than as a rival
implementation, and every still-valid behaviour it covered is covered there. Where the two
disagreed, the candidate was wrong: it refused a hire outright when no acceptance job was
registered, whereas §6 requires **BLOCKED** with a named reason — which is what PR #11 does
(`BLOCKED_NO_ACCEPTANCE_JOB`).

Still required before the endpoint is considered ratified:

1. **Request-level** tests proving the endpoint cannot bypass the serializer — direct
   serializer tests are necessary but insufficient. (PR #11 ships 25 request-level tests
   through the DRF view.)
2. No second validator may be introduced in any other language or package.

---

## 9. What was withdrawn from the earlier draft

`catalogue_key`/`catalogue_version`/`profile_digest` (invented; superseded by §1) ·
`display_name` and `options` (no allowlist exists) · the Registry-V1 `POST
/v1/services/{id}/operations` framing (the deployed backend is
`/api/isola/tenants/{tenant_id}/…`; Registry-V1's *idempotency and correlation models* are
retained, its endpoint shape is not).

Retained and unchanged: R1/R2, unknown-field 400, server-resolved behaviour, fail-closed
acceptance, self-approval refusal, credential-reference-only.

---

## 10. Open before the endpoint ships

1. `AgentTemplate` registry model with `template_digest` — does not exist.
2. Per-entry `acceptance_job` content — absent, so `accepted` is currently unreachable. Correct fail-closed default.
3. WS4 projection — blocked.
4. Entitlement source for `not_entitled`.
5. PR #3's doc reduced to a pointer to this file.
