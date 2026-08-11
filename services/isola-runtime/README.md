# isola-runtime

The isolated synchronous agent runtime for Isola's Paperclip employees.

Paperclip owns the employee records. When an employee runs, Paperclip's built-in
`http` adapter POSTs to this service, this service does the work synchronously,
and its **HTTP status** reports the outcome. Native OpenCode failed the
fail-closed tool-permission test, so this runtime exists specifically to have
**no tools at all**.

---

## 1. Security posture — this is the product, not a side effect

| Property | How it is enforced | Proved by |
|---|---|---|
| No shell, no child processes | `node:child_process` is never imported | `test/no-direct-network.test.ts` source scan |
| No filesystem access outside `RUNTIME_STATE_DIR` | `node:fs` is imported by exactly one module, `src/state.ts`, which imports exactly four functions and builds every path by joining a fixed basename onto the configured directory; the image `chmod`s `/app` read-only and runs as `node` | source scan (asserts the offender list is **exactly** `["state.ts"]`, and pins the imported symbols and the fs call targets) + `test/state.test.ts` containment tests + `Dockerfile` |
| No MCP | no MCP client, no transport, no import | source scan |
| No plugin or custom-tool mechanism | there is no extension point; templates are compiled-in constants | `src/registry.ts`, `test/registry.test.ts` |
| Outbound network restricted to an allowlist | every call goes through the single `safeFetch` in `src/egress.ts`; any other host throws `EgressBlockedError` | `test/egress.test.ts` + a source scan asserting `fetch(` appears only in `egress.ts` |
| No Paperclip volume or master key | the container declares no `VOLUME` and mounts nothing; `src/` never names such a path | source scan |
| No tool is ever offered to the model | the provider request body carries only `model`, `messages`, `stream` | `test/egress.test.ts` |
| A failed run is never dressed up as an answer | on timeout/provider error the content is `null` and the write-back says the run failed | `test/invoke.test.ts`, `test/recorder.test.ts` |

`toolPolicy` on every template is `{shell:false, filesystem:false, web:false,
mcp:false, customTools:false}` and a test asserts every field is false for every
template. The service has no code path that could honour a `true`.

> The `filesystem:false` tool policy is about the **model**: no template is ever
> given a filesystem tool, and the service has no mechanism to offer one. The
> service's own state store is a different thing — a single module, four fs
> functions, one configured directory, and no path that any request can
> influence.

---

## 2. The exposure boundary — two bearers, never one

There is deliberately **no single shared secret**.

Paperclip stores the bearer in the employee's `adapterConfig.headers`, and an
employee can read *and PATCH* its own `adapterConfig`. With one shared secret the
INTERNAL employee could read its own bearer and invoke the PUBLIC template. That
would defeat the only boundary this service exists to enforce.

So each exposure class gets its own bearer, and **the bearer decides** which
class of template the caller may run:

- `RUNTIME_SECRET_INTERNAL` — may only run templates whose registry exposure is `INTERNAL`
- `RUNTIME_SECRET_PUBLIC` — may only run templates whose registry exposure is `PUBLIC`

> **The two values must never be the same.** If they are, the boundary does not
> exist; the service logs a boot warning and rejects that bearer with 401 rather
> than guessing which class it meant.

### Decision order on `POST /v1/invoke`

| # | Check | Failure |
|---|---|---|
| 0 | Neither secret configured | `503 no_credential_configured` |
| 1 | Bearer matches a configured secret (constant-time) → **credential exposure** | `401 unauthorized` |
| 2 | `templateId` resolves in the in-code registry | `400 unknown_template`, nothing recorded |
| 3 | A credential is configured for **the template's** exposure | `503 no_credential_configured` — never a fallback to the other class |
| 4 | `templateExposure === credentialExposure` | `403 exposure_mismatch`, nothing recorded |
| 5 | The request's advisory `exposure` agrees with the credential | `403 exposure_mismatch` |

Step 5 keeps the original fail-closed rule: a missing, non-string or
unrecognised `exposure` collapses to `INTERNAL`, so **a `PUBLIC` template only
runs when the request explicitly and correctly declares `PUBLIC`**. The body can
only ever narrow the decision — it can never widen it. Step 4 is the real
boundary and nothing in the request body can bypass it.

Everything behaviour-bearing (system prompt, model, timeouts, tool policy,
exposure) is resolved server-side from the hardcoded registry. The request may
only *select* a template; it may never define one.

---

## 3. Endpoints

### `POST /v1/invoke`

Auth: `Authorization: Bearer <the exposure's secret>`.

Request body (everything is treated as untrusted):

```json
{
  "templateId": "epic-staff-operations-coordinator@v1",
  "exposure": "INTERNAL",
  "agentId": "<paperclip agent id>",
  "runId": "<paperclip run id>",
  "context": { "...": "whatever Paperclip sends" }
}
```

Responses — the status is the truth, because Paperclip discards the body:

| Status | `outcome` | Meaning |
|---|---|---|
| `200` | `ok` | Model answered; the result was written back (see `recorded`) and the issue was transitioned (see `transitioned` / `issueStatus`) |
| `200` | `duplicate_run_suppressed` | A duplicate of a run already in flight. Nothing was done a second time |
| `400` | `bad_request` / `unknown_template` | Malformed body, or a `templateId` not in the registry. Nothing recorded |
| `401` | `unauthorized` | Missing or unrecognised bearer |
| `402` | `budget_exhausted` | The monthly budget is fully committed. **The provider was not called**, the employee was paused, nothing was spent |
| `403` | `exposure_mismatch` | The credential is not authorised for this template's exposure class |
| `413` | `payload_too_large` | Body over `RUNTIME_MAX_REQUEST_BYTES` |
| `500` | `internal_error` | Unexpected runtime fault |
| `502` | `provider_error` | The model provider errored |
| `503` | `no_credential_configured` | No credential configured for that exposure class |
| `503` | `cost_delivery_unconfirmed` | Measured spend has not reached the ledger and is over the threshold. Fail closed rather than lose spend |
| `504` | `model_timeout` | The model exceeded the hard deadline |

A **replayed** run returns the original run's status and body with
`replay: true`. It never calls the provider, never posts a second comment,
never transitions twice and never charges twice.

Every response carries `correlationId` in the JSON body **and** in the
`X-Isola-Correlation-Id` header (Paperclip throws the body away, but curl-based
acceptance tests need it).

On `200` the body also carries `recorded: true|false` and `recorderError`.
**A recorder failure never flips a successful model run into a failed status** —
it is logged and reported as `recorded:false`.

### `GET /healthz`

No auth, no secrets:

```json
{
  "status": "ok",
  "version": "1.0.0",
  "templates": [{ "id": "...", "version": "v1", "exposure": "INTERNAL" }],
  "egressAllowlist": ["api.deepseek.com", "paperclip.example.test"]
}
```

### `GET /v1/templates`

Auth required (either bearer). Returns registry metadata — `id`, `name`,
`version`, `exposure`, `model`, `timeoutMs`, `maxContextBytes`, `toolPolicy`.
**Never the system prompt text.**

---

## 4. The run loop and the callbacks

> Fixes the P1 defect where **one wakeup produced 53 runs**.

`heartbeat.enabled = false` only stops the *timer*. Paperclip keeps
re-scheduling an employee that still has an actionable assigned issue, and the
`http` adapter cannot transition an issue — so the work never completes and the
agent is woken again, and again. The runtime therefore performs the callbacks
itself, in this order, authenticated as **the employee's own agent**:

1. **Comment** — `POST /api/issues/{issueId}/comments`, the model output, or the
   safe failure reason. This is the existing write-back recorder.
2. **Transition** — `PATCH /api/issues/{issueId}` with `{"status": ...}`.
   Success → **`in_review`**. Failure → **`blocked`**, and the comment names the
   owner and the exact next action.
3. **Cost event** — see section 5.

Every non-success outcome is treated as unrecoverable *from this runtime's point
of view*: it has no retry loop of its own, and leaving the issue actionable so
Paperclip can retry is exactly what produced the 53 runs. A human decides
whether to retry. Both `in_review` and `blocked` take the issue out of the
actionable set, which is what actually breaks the loop.

A **transition failure never flips a successful model run into a failed HTTP
status**, exactly as a recorder failure does not. It is logged and reported as
`transitioned: false`.

### Auth on every callback

`Authorization: Bearer <the employee's own agent API key>` and
`X-Paperclip-Run-Id: <runId>` on **every** call, reads included. Paperclip's
agent actors are company-scoped and a cost event is rejected with 403 unless its
`agentId` equals the calling agent, so a shared board key is the wrong
credential. Set `PAPERCLIP_AGENT_KEY_INTERNAL` and `PAPERCLIP_AGENT_KEY_PUBLIC`
— one per employee, matching the two-bearer design. Both fall back to
`PAPERCLIP_API_KEY`.

### No issue, no transition

The issue id is resolved only from explicit, unambiguous fields:
`issueId`, `issue_id`, `issue.id`, `task.issueId`, `task.issue_id`,
`task.issue.id`, `assignedIssue.id`, `paperclip.issueId`, `run.issueId`.
There is deliberately no "first element of the `issues` array" rule.
**An issue id is never guessed.** If none resolves, nothing is transitioned, the
runtime logs `outcome:"no_issue_context"`, and the HTTP status is still whatever
the model outcome earned.

### Idempotency

Keyed by `(companyId, agentId, runId)`; with no run id, by
`(companyId, agentId, issueId, sha256(context)[0:32])` — which is precisely the
re-dispatch shape that produced the 53 runs. A duplicate webhook, an adapter
retry or a process restart produces **exactly one** comment, one transition and
one cost event. A replay is a no-op that returns the original result with
`replay: true`; a duplicate of a run still in flight returns `200
duplicate_run_suppressed` and does nothing. Records expire after
`RUNTIME_IDEMPOTENCY_TTL_MS` so a legitimate re-run is possible later.

Outcomes that are a "not now" rather than a result — `402 budget_exhausted` and
`503 cost_delivery_unconfirmed` — release the claim so the run can be retried
once the condition clears.

---

## 5. Metering, reservations and budget

> Fixes the P1 defect where **after 53 runs the agent reported
> `spentMonthlyCents: 0`**.

Paperclip's `http` adapter discards the adapter response, so cost and usage
never reach it on their own and the native 80% alert and 100% hard stop can
never fire. This runtime is the only component that sees the provider's usage
response, so metering originates here. **Paperclip remains the canonical
ledger**: every figure derived here is pushed into it as a cost event, and the
budget enforced against is read back from it.

### The sub-cent accumulator — the important part

Paperclip's `costCents` is an **integer** and a DeepSeek run costs a small
fraction of a cent. Rounding down sends 0 forever, which is the defect. Rounding
up invents up to a whole cent per run — 53 cents of fabricated spend per wakeup.

So cost is accumulated in **microcents** (1 cent = 1,000,000 microcents; a token
costs exactly its cents-per-Mtok rate in microcents, so all arithmetic stays in
safe integers) and an integer-cent event is emitted **only once at least one
whole cent has accrued**. The remainder is carried forward and never dropped:

```
sum(emitted costCents) * 1e6 + carry == total accrued microcents     (exactly)
```

An emitted event may therefore aggregate several sub-cent runs. Its
`heartbeatRunId` is the run that tipped it over one cent, and its token counts
are the aggregate since the last emission — no usage is lost.

### Cost provenance — never fabricate

| Situation | `billingCode` | `billingType` | `costCents` |
|---|---|---|---|
| Usage from the provider, priced at a real rate | `provider-rates@v1` | `metered_api` | measured |
| Usage but no known rate | `unpriced@v1` | `unknown` | `0`, usage preserved |
| Usage, no rate, `RUNTIME_SYNTHETIC_PRICING=on` | `synthetic-pricing@v1` | `unknown`, `biller` suffixed `-synthetic` | synthetic, **never real expenditure** |
| No usage reported at all | — | — | no event; logged `cost_usage_unavailable` |

Synthetic cost is kept in its own accumulator so it can never be blended into
actual spend, and the outbox entry records `costKind: "synthetic"`. `billingType`
carries the schema's documented `unknown` rather than an invented enum member
the deployed Paperclip might reject; the versioned marker lives in
`billingCode`, which is a free string.

Built-in list prices (cents per 1M tokens): `deepseek-chat` 27 / 7 cached / 110
out; `deepseek-reasoner` 55 / 14 / 219. Env overrides apply to every model. A
model with neither is **unpriced**, not guessed.

### Reservations

Before the provider is called, a run reserves its estimated cost and the
reservation is checked against the remaining budget. Remaining budget is
Paperclip's `spentMonthlyCents` **plus** undelivered outbox cents, **plus** the
sub-cent accumulator, **plus** every live reservation. The read, the sum and the
new reservation all happen inside one serialized state transaction, so
concurrent runs cannot collectively exceed the budget. The reservation is
released at settlement and replaced by the measured cost; a crashed run's
reservation expires after `RUNTIME_RESERVATION_TTL_MS`.

The estimate is crude on purpose (`ceil(promptChars/4)` input tokens plus
`RUNTIME_ESTIMATED_OUTPUT_TOKENS` output) and is **never recorded as cost**.

### Thresholds

- **80%** → a structured `outcome:"budget_alert"` log plus a clearly-marked
  comment on the issue when one resolves. Fires **once per crossing**, not once
  per run; re-arms on a new month, a changed budget, or a fall back below the
  threshold.
- **100%** → the invocation is rejected with **`402 budget_exhausted` before the
  provider is called**, and the employee is paused via
  `POST /api/agents/{id}/pause` (once per period).

Enforcement applies only when a budget figure is actually known. If the ledger
read fails the runtime uses the last snapshot, logs `budget_read_failed`, and
keeps running — see section 11 for why.

### The outbox and failing closed

Finalized cost events go to a durable outbox keyed by
`(companyId, agentId, runId)`, pending → delivered (or `failed` on a permanent
rejection, which still counts as undelivered spend). Delivery is retried with
bounded exponential backoff, attempted immediately, at the start of every
subsequent invocation, on a background sweep, and **on startup**. A network call
is never made while holding a state transaction; the claiming transaction leases
the entry so a concurrent flush cannot double-deliver.

If undelivered spend exceeds `RUNTIME_MAX_UNDELIVERED_COST_CENTS` (default 50)
or the oldest entry exceeds `RUNTIME_MAX_UNDELIVERED_AGE_MS`, further
invocations are rejected with **`503 cost_delivery_unconfirmed`** rather than
spending more money nobody is counting.

---

## 6. Environment variables

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `RUNTIME_SECRET_INTERNAL` | one of the two | — | Bearer authorising **INTERNAL** templates only. Unset ⇒ every INTERNAL template returns `503` |
| `RUNTIME_SECRET_PUBLIC` | one of the two | — | Bearer authorising **PUBLIC** templates only. Unset ⇒ every PUBLIC template returns `503`. Must differ from the INTERNAL value |
| `MODEL_BASE_URL` | no | `https://api.deepseek.com` | OpenAI-compatible base. A trailing `/v1` is handled without doubling the path |
| `MODEL_API_KEY` | yes, in practice | — | Provider key. Unset ⇒ every run returns `502` |
| `MODEL_NAME` | no | template's `deepseek-chat` | Overrides the registry model for all templates |
| `MODEL_PROVIDER` | no | derived from `MODEL_BASE_URL` (`api.deepseek.com` ⇒ `deepseek`) | Cost-event `provider` / `biller` |
| `RUNTIME_MODEL_TIMEOUT_MS` | no | `60000` | Hard model deadline via `AbortController`. The **tighter** of this and the template's `timeoutMs` wins |
| `PAPERCLIP_BASE_URL` | for callbacks | — | Paperclip base URL. Unset ⇒ no comment, no transition, no cost event |
| `PAPERCLIP_API_KEY` | for callbacks | — | Fallback key when no per-exposure agent key is set. Unset ⇒ `NullRunRecorder` |
| `PAPERCLIP_AGENT_KEY_INTERNAL` | recommended | `PAPERCLIP_API_KEY` | The INTERNAL employee's **own agent API key**. Required for its cost events to be accepted |
| `PAPERCLIP_AGENT_KEY_PUBLIC` | recommended | `PAPERCLIP_API_KEY` | The PUBLIC employee's own agent API key |
| `PAPERCLIP_COMPANY_ID` | for metering | — | Company that owns the cost events. Overridden by `companyId` in the run context. Unset and unsupplied ⇒ no cost event, logged `cost_no_company_context` |
| `PAPERCLIP_RECORD_PATH` | no | `/api/issues/{issueId}/comments` | Comment path template. `{issueId}` / `{agentId}` / `{runId}` are substituted (URL-encoded). A placeholder the run cannot supply is a loud recorder failure, never a half-substituted POST |
| `PAPERCLIP_SUCCESS_STATUS` | no | `in_review` | Issue status on success. An unrecognised value falls back to the default rather than PATCHing something Paperclip would reject |
| `PAPERCLIP_FAILURE_STATUS` | no | `blocked` | Issue status on failure |
| `PAPERCLIP_FAILURE_OWNER` | no | `the EPIC operations on-call engineer` | Named owner in the failure comment |
| `EGRESS_ALLOWLIST` | no | hostnames of `MODEL_BASE_URL` + `PAPERCLIP_BASE_URL` | Comma-separated hostnames. Exact match only — no suffix widening. Setting it **replaces** the derived list |
| `PORT` | no | `3000` | Listen port |
| `RUNTIME_MAX_REQUEST_BYTES` | no | `1048576` | Inbound body cap |
| **State** | | | |
| `RUNTIME_STATE_DIR` | no | `/tmp/isola-runtime-state` | The one writable path. Holds the idempotency records, the outbox and the accumulator |
| `RUNTIME_STATE_BACKEND` | no | `file` | `file` or `memory`. `memory` loses everything on restart |
| **Pricing** | | | |
| `MODEL_PRICE_INPUT_PER_MTOK_CENTS` | no | built-in card (`deepseek-chat` ⇒ `27`) | Cents per 1M fresh input tokens. Applies to every model |
| `MODEL_PRICE_CACHED_INPUT_PER_MTOK_CENTS` | no | built-in card (`deepseek-chat` ⇒ `7`) | Cents per 1M cached input tokens |
| `MODEL_PRICE_OUTPUT_PER_MTOK_CENTS` | no | built-in card (`deepseek-chat` ⇒ `110`) | Cents per 1M output tokens |
| `RUNTIME_SYNTHETIC_PRICING` | no | `false` | Apply `synthetic-pricing@v1` to models with no real rate. **Test aid only** — the events are marked synthetic and are not real expenditure |
| **Budget** | | | |
| `RUNTIME_BUDGET_ENFORCEMENT` | no | `true` | Off ⇒ no alert and no hard stop. Usage is still metered |
| `RUNTIME_BUDGET_ALERT_THRESHOLD_PCT` | no | `80` | Alert threshold |
| `RUNTIME_BUDGET_REFRESH_MS` | no | `15000` | How long a ledger snapshot is reused. `0` ⇒ read on every run |
| `RUNTIME_PAUSE_ON_EXHAUSTED` | no | `true` | Call `POST /api/agents/{id}/pause` at 100% |
| `RUNTIME_ESTIMATED_OUTPUT_TOKENS` | no | `1000` | Output tokens assumed by the reservation estimate |
| `RUNTIME_RESERVATION_TTL_MS` | no | `300000` | A crashed run's reservation expires after this |
| **Fail closed** | | | |
| `RUNTIME_MAX_UNDELIVERED_COST_CENTS` | no | `50` | Over this, reject with `503 cost_delivery_unconfirmed` |
| `RUNTIME_MAX_UNDELIVERED_AGE_MS` | no | `3600000` | Same, on the age of the oldest undelivered entry |
| **Idempotency and outbox** | | | |
| `RUNTIME_IDEMPOTENCY_TTL_MS` | no | `86400000` | After this a run id may legitimately run again |
| `RUNTIME_OUTBOX_MAX_ATTEMPTS` | no | `8` | Then the entry is `failed` — still counted as undelivered spend |
| `RUNTIME_OUTBOX_BASE_BACKOFF_MS` | no | `250` | Exponential base |
| `RUNTIME_OUTBOX_MAX_BACKOFF_MS` | no | `30000` | Backoff ceiling |
| `RUNTIME_OUTBOX_RETENTION_MS` | no | `86400000` | Delivered entries are pruned after this |
| `RUNTIME_OUTBOX_FLUSH_LIMIT` | no | `10` | Entries per flush |
| `RUNTIME_OUTBOX_SWEEP_MS` | no | `60000` | Background sweep interval. `0` disables the timer |

Boot logs a one-line JSON warning for every fail-closed condition (missing
secret, identical secrets, missing model key, empty allowlist, missing company
id, missing agent key, enforcement off, synthetic pricing on, memory backend).
**No secret is ever logged** — a redaction pass strips credential-shaped keys
and bearer-shaped values as a second line of defence.

---

## 7. The two templates

| id | exposure | Job |
|---|---|---|
| `epic-staff-operations-coordinator@v1` | `INTERNAL` | Given an overdue-invoice fixture in the run context, produces an **Overdue Receivables Action List** as a markdown table with exactly seven columns (account/customer reference, balance, days overdue, priority, recommended next action, escalation reason, requires human approval). Must state that it contacted no one and changed no record. If the fixture is missing or unparseable it says so instead of inventing rows |
| `isola-ai-sales-front-desk-agent@v1` | `PUBLIC` | Business front-desk/sales agent. Answers only from the supplied business information, explains products/services, does basic lead qualification, collects name/contact/request, recommends a next step, escalates to a human on request or when it cannot answer, stays silent during human takeover and resumes only after explicit handback. Never claims to have performed an action in an external system |

Both carry `timeoutMs: 60000`, `maxContextBytes: 24576` and an all-false
`toolPolicy`.

The run context is serialized, hard-capped at 24 KB **by bytes** (never
splitting a multi-byte character), and placed in a **user**-role message inside a
clearly-labelled untrusted-data envelope. It can never reach the system role. If
it is cut, an explicit in-band marker tells the model the data is incomplete and
must not be inferred.

---

## 8. Paperclip `adapterConfig` — paste these

Paperclip's `http` adapter sends:

```
POST <config.url>
headers: { "content-type": "application/json", ...config.headers }
body:    JSON.stringify({ ...config.payloadTemplate, agentId, runId, context })
```

It aborts at `config.timeoutMs` (**not** `timeoutSec` — the Paperclip docs are
wrong), **discards the response body entirely**, treats any 2xx as success, any
non-2xx as a failed run, and an AbortError as `timed_out`. That is why this
service writes the real result back through the Paperclip REST API.

Set `timeoutMs` **above** this service's model deadline (60 s) so Paperclip does
not abort a run that is still legitimately working. 90 s gives headroom for the
model call plus the write-back.

### Employee 1 — EPIC Staff Operations Coordinator (INTERNAL)

```json
{
  "url": "https://isola-runtime.internal.example/v1/invoke",
  "method": "POST",
  "timeoutMs": 90000,
  "headers": {
    "Authorization": "Bearer ${RUNTIME_SECRET_INTERNAL}"
  },
  "payloadTemplate": {
    "templateId": "epic-staff-operations-coordinator@v1",
    "exposure": "INTERNAL"
  }
}
```

### Employee 2 — Isola AI Sales Front Desk Agent (PUBLIC)

```json
{
  "url": "https://isola-runtime.internal.example/v1/invoke",
  "method": "POST",
  "timeoutMs": 90000,
  "headers": {
    "Authorization": "Bearer ${RUNTIME_SECRET_PUBLIC}"
  },
  "payloadTemplate": {
    "templateId": "isola-ai-sales-front-desk-agent@v1",
    "exposure": "PUBLIC"
  }
}
```

Replace `${RUNTIME_SECRET_INTERNAL}` / `${RUNTIME_SECRET_PUBLIC}` with the two
literal values you set in this service's environment, and replace the `url` host
with the deployed hostname.

> **The two bearers must never be the same value.** Each employee gets only its
> own bearer. That is the whole boundary: even though an employee can read and
> PATCH its own `adapterConfig`, the bearer it finds there only unlocks its own
> exposure class. Rotating one does not require rotating the other.

---

## 9. Build and deploy

Build context is **`services/isola-runtime/`** — nothing outside this directory
is referenced, and no monorepo workspace package is used.

```bash
docker build -t isola-runtime:1.0.0 services/isola-runtime
docker run --rm -p 3000:3000 \
  -e RUNTIME_SECRET_INTERNAL=... \
  -e RUNTIME_SECRET_PUBLIC=... \
  -e MODEL_API_KEY=... \
  -e PAPERCLIP_BASE_URL=... \
  -e PAPERCLIP_API_KEY=... \
  isola-runtime:1.0.0
```

In EasyPanel set the build path / context to `services/isola-runtime` and the
Dockerfile to `./Dockerfile`. Multi-stage, `node:22-alpine`, non-root `node`
user, zero runtime dependencies (no `node_modules` in the final image at all),
`/app` read-only, `EXPOSE 3000`, honours `PORT`.

**Mount nothing.** The service needs no volume, and giving it one would remove a
guarantee this design depends on.

### Local

```bash
cd services/isola-runtime
npm install
npx vitest run     # 207 tests
npm run typecheck
npm run build && npm start
```

### Acceptance probes

```bash
curl -si localhost:3000/healthz

# INTERNAL employee, correct pairing -> 200
curl -si -X POST localhost:3000/v1/invoke \
  -H "authorization: Bearer $RUNTIME_SECRET_INTERNAL" \
  -H 'content-type: application/json' \
  -d '{"templateId":"epic-staff-operations-coordinator@v1","exposure":"INTERNAL",
       "agentId":"a1","runId":"r1","context":{"issueId":"ISSUE-1","invoices":[]}}'

# INTERNAL bearer reaching for the PUBLIC template -> 403 exposure_mismatch
curl -si -X POST localhost:3000/v1/invoke \
  -H "authorization: Bearer $RUNTIME_SECRET_INTERNAL" \
  -H 'content-type: application/json' \
  -d '{"templateId":"isola-ai-sales-front-desk-agent@v1","exposure":"PUBLIC",
       "agentId":"a1","runId":"r1","context":{}}'
```

Read `X-Isola-Correlation-Id` from the response headers and use it to find the
matching structured log line.

---

## 10. Persistence — and the honest limits of `/tmp`

The runtime has to survive a restart with three things intact:

1. the **idempotency records**, so a duplicate webhook or an adapter retry does
   not produce a second comment, a second transition or a second charge;
2. the **cost-event outbox**, so measured spend that has not reached Paperclip
   is re-delivered rather than silently lost;
3. the **sub-cent accumulator**, so fractional cost is carried forward rather
   than reset to zero on every deploy.

The container has **no volume and a read-only app directory, and that has not
been changed** — the absence of a mount is part of the security argument. So the
state goes to `RUNTIME_STATE_DIR` (default `/tmp/isola-runtime-state`), the one
writable path a read-only image still has. Writes are whole-file and atomic
(temporary sibling, then rename), the file is mode `0600`, and every path is a
fixed basename joined onto the configured directory — `resolveStateFile` refuses
anything that would resolve outside it, and no path is ever derived from a
request.

> ### `/tmp` does not survive a container replacement
>
> A **restart of the same container** keeps the state, and the startup
> reconciler re-reads what is there and re-delivers anything still pending.
>
> A **redeploy, a reschedule or an OOM kill** starts with an empty store. The
> consequences, stated plainly:
>
> - idempotency records are gone, so a webhook replayed across the replacement
>   could produce a second comment and a second transition (the transition is
>   idempotent in effect — the issue is already `in_review` — but the comment is
>   not);
> - any cost event still pending is lost. It was measured, it was never
>   delivered, and Paperclip will never learn about it. The fail-closed
>   threshold bounds that loss at `RUNTIME_MAX_UNDELIVERED_COST_CENTS`
>   (default 50 cents) rather than eliminating it;
> - the sub-cent carry is lost — at most one cent per accumulator.
>
> This is a deliberate, documented trade against the alternative of mounting a
> volume. See section 11 for what a better durable option would cost.

The store is an interface (`src/state.ts`) with a file-backed and an in-memory
implementation, and the tests drive both through the same suite.
`RUNTIME_STATE_BACKEND=memory` selects the in-memory one; the file backend
degrades to in-memory behaviour, loudly, if the path turns out to be unwritable.

---

## 11. Judgement calls

Places where the spec left room, and what was chosen:

- **A better durable store.** Given no volume, the materially better option is
  Paperclip itself: it already holds the cost ledger, and a delivered cost event
  is durable proof that a run was charged. A store that reconstructed the outbox
  by *reading back* `/api/companies/{id}/cost-events` on startup would survive a
  container replacement, which `/tmp` does not. It was not built here because it
  needs a Paperclip read contract (list/filter cost events by agent and period)
  that is not in the verified set, and guessing an endpoint shape would be worse
  than the documented `/tmp` limitation. **Recommended as the follow-up.** A
  Postgres or Redis side-store would also work and would remove the limitation
  entirely, at the cost of a dependency this service currently does not have.
- **All non-success outcomes go to `blocked`,** not just "unrecoverable" ones.
  This runtime has no retry loop; leaving an issue actionable so Paperclip can
  retry is what produced the 53 runs. A human decides whether to retry.
  `PAPERCLIP_FAILURE_STATUS` overrides it.
- **`billingType` for synthetic and unpriced events is `unknown`,** the schema's
  documented default, rather than an invented enum member. The verified contract
  lists `metered_api`, `subscription_included`, `subscription_overage` and "…" —
  guessing at the elided values risks a 400. The versioned marker therefore
  lives in `billingCode`, which is a free string, and the provenance is
  additionally carried in `biller` and in the outbox entry's `costKind`.
- **An unknown budget does not block a run.** The 100% hard stop fires only when
  a budget figure is actually known. Failing closed on an unreadable ledger
  would mean a Paperclip outage stops every employee, which is a worse failure
  than running briefly against a stale figure — and undelivered *spend* still
  fails closed, which is the case where money is genuinely at risk. Enforcement
  can be turned off entirely with `RUNTIME_BUDGET_ENFORCEMENT=off`.
- **A duplicate of a run still in flight returns `200`,** not `409`. Paperclip
  treats any 2xx as success, and the goal is to stop it re-scheduling. The
  original run owns all the write-backs.
- **An aggregated cost event's `heartbeatRunId` is the run that tipped it over
  one cent,** and its token counts are the aggregate since the last emission.
  There is no per-run event for sub-cent runs, because there is no honest
  integer to put in one.
- **Reservations are atomic within one process only.** The serialized state
  transaction is what prevents concurrent overspend; a second replica would need
  a shared store. This service is deployed as a single instance.
- **`inputTokens` is billed net of `cachedInputTokens`.** Providers report
  `prompt_tokens` as the total including cached tokens, and Paperclip's schema
  has separate fields, so the split is `input = prompt - cached`.

---

## 12. Logging

One JSON object per line on stdout, always carrying `ts`, `level`, `service`,
`version`, `event`, `correlationId`, `runId`, `agentId`, `templateId`, `outcome`
and `durationMs`. Failure logs carry a `failureCategory` — a category string
built by this service, never a secret and never a raw provider payload.

Outcomes worth alerting on:

| `outcome` | Meaning |
|---|---|
| `budget_alert` | 80% of the monthly budget is committed. Once per crossing |
| `budget_exhausted` | 100%. The provider was not called; `agentPaused` says whether the pause landed |
| `agent_paused` / `agent_pause_failed` | The pause call |
| `cost_delivery_unconfirmed` | Fail-closed rejection; `pendingCostCents` says how much is unaccounted for |
| `cost_delivery_failed` | An event will never be delivered. This is lost spend — investigate |
| `cost_delivery_deferred` | A transient delivery failure; it will retry |
| `cost_event_enqueued` / `cost_event_delivered` | Normal metering |
| `cost_event_accrued_subcent` | Under one cent, carried forward. Expected and frequent |
| `cost_usage_unavailable` / `cost_no_company_context` | A run produced no cost event, and why |
| `no_issue_context` | Nothing was transitioned because no issue id resolved |
| `duplicate_run_suppressed` | A replay or a duplicate. A burst of these is the run-loop symptom |
| `issue_transitioned` / `issue_transition_failed` | The loop fix landing, or not |
| `budget_read_failed` | The ledger could not be read; a stale snapshot may be in use |
| `reconcile_complete` | Startup reconciliation finished |
| `state_store_degraded` | The state file is not writable; durability is lost |
