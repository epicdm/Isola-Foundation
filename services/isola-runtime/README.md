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
| No filesystem writes; no reads outside the app dir | `node:fs` is never imported by `src/`; the image `chmod`s `/app` read-only and runs as `node` | source scan + `Dockerfile` |
| No MCP | no MCP client, no transport, no import | source scan |
| No plugin or custom-tool mechanism | there is no extension point; templates are compiled-in constants | `src/registry.ts`, `test/registry.test.ts` |
| Outbound network restricted to an allowlist | every call goes through the single `safeFetch` in `src/egress.ts`; any other host throws `EgressBlockedError` | `test/egress.test.ts` + a source scan asserting `fetch(` appears only in `egress.ts` |
| No Paperclip volume or master key | the container declares no `VOLUME` and mounts nothing; `src/` never names such a path | source scan |
| No tool is ever offered to the model | the provider request body carries only `model`, `messages`, `stream` | `test/egress.test.ts` |
| A failed run is never dressed up as an answer | on timeout/provider error the content is `null` and the write-back says the run failed | `test/invoke.test.ts`, `test/recorder.test.ts` |

`toolPolicy` on every template is `{shell:false, filesystem:false, web:false,
mcp:false, customTools:false}` and a test asserts every field is false for every
template. The service has no code path that could honour a `true`.

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
| `200` | `ok` | Model answered; the result was written back (see `recorded`) |
| `400` | `bad_request` / `unknown_template` | Malformed body, or a `templateId` not in the registry. Nothing recorded |
| `401` | `unauthorized` | Missing or unrecognised bearer |
| `403` | `exposure_mismatch` | The credential is not authorised for this template's exposure class |
| `413` | `payload_too_large` | Body over `RUNTIME_MAX_REQUEST_BYTES` |
| `500` | `internal_error` | Unexpected runtime fault |
| `502` | `provider_error` | The model provider errored |
| `503` | `no_credential_configured` | No credential configured for that exposure class |
| `504` | `model_timeout` | The model exceeded the hard deadline |

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

## 4. Environment variables

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `RUNTIME_SECRET_INTERNAL` | one of the two | — | Bearer authorising **INTERNAL** templates only. Unset ⇒ every INTERNAL template returns `503` |
| `RUNTIME_SECRET_PUBLIC` | one of the two | — | Bearer authorising **PUBLIC** templates only. Unset ⇒ every PUBLIC template returns `503`. Must differ from the INTERNAL value |
| `MODEL_BASE_URL` | no | `https://api.deepseek.com` | OpenAI-compatible base. A trailing `/v1` is handled without doubling the path |
| `MODEL_API_KEY` | yes, in practice | — | Provider key. Unset ⇒ every run returns `502` |
| `MODEL_NAME` | no | template's `deepseek-chat` | Overrides the registry model for all templates |
| `RUNTIME_MODEL_TIMEOUT_MS` | no | `60000` | Hard model deadline via `AbortController`. The **tighter** of this and the template's `timeoutMs` wins |
| `PAPERCLIP_BASE_URL` | for write-back | — | Paperclip base URL |
| `PAPERCLIP_API_KEY` | for write-back | — | Paperclip board API key (`Authorization: Bearer`). Unset ⇒ `NullRunRecorder`, outcomes are not written back |
| `PAPERCLIP_RECORD_PATH` | no | `/api/issues/{issueId}/comments` | Write-back path template. `{issueId}` / `{agentId}` / `{runId}` are substituted (URL-encoded). A placeholder the run cannot supply is a loud recorder failure, never a half-substituted POST |
| `EGRESS_ALLOWLIST` | no | hostnames of `MODEL_BASE_URL` + `PAPERCLIP_BASE_URL` | Comma-separated hostnames. Exact match only — no suffix widening. Setting it **replaces** the derived list |
| `PORT` | no | `3000` | Listen port |
| `RUNTIME_MAX_REQUEST_BYTES` | no | `1048576` | Inbound body cap |

Boot logs a one-line JSON warning for every fail-closed condition (missing
secret, identical secrets, missing model key, empty allowlist). **No secret is
ever logged** — a redaction pass strips credential-shaped keys and
bearer-shaped values as a second line of defence.

---

## 5. The two templates

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

## 6. Paperclip `adapterConfig` — paste these

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

## 7. Build and deploy

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
npx vitest run     # 102 tests
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

## 8. Logging

One JSON object per line on stdout, always carrying `ts`, `level`, `service`,
`version`, `event`, `correlationId`, `runId`, `agentId`, `templateId`, `outcome`
and `durationMs`. Failure logs carry a `failureCategory` — a category string
built by this service, never a secret and never a raw provider payload.
