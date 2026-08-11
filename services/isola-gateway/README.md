# isola-gateway

The **Isola Registry/Gateway**: the signed bridge between Chatwoot and the
Paperclip-backed AI employee.

```
test customer
   -> Chatwoot inbox
   -> signed AgentBot webhook   (HMAC-SHA256 over the RAW body)
   -> THIS SERVICE              (verify, resolve binding, suppress, ACK <5s)
   -> isola-runtime             (POST /v1/invoke, the Paperclip employee)
   -> Chatwoot Message API      (reply as the bot)
   -> customer
```

This is the **only publicly-exposed Isola component**, so it fails closed
everywhere: an unverifiable delivery, an unknown inbox, a duplicate binding, a
retired binding, an `INTERNAL` binding, a human-held conversation and a runtime
failure all result in *nothing being sent to the customer*.

---

> ## ⚠ REQUIRES `responseMode: "inline"` IN isola-runtime — NOT YET IMPLEMENTED
>
> `isola-runtime` posts the employee's output to **Paperclip**; it does not
> return the assistant text to its caller. The Chatwoot path needs that text.
>
> This gateway therefore sends `{..., responseMode: "inline"}` on
> `POST /v1/invoke` and reads the answer from
> `data.text ?? data.content ?? data.message ?? null`.
>
> **Until isola-runtime honours it, every successful invocation comes back with
> `text === null`.** This gateway classifies that as `runtime_no_text` — a
> contract violation — posts **no** customer message, posts a private note, and
> escalates the conversation to a human. It never invents a reply and it never
> re-uses the runtime's error strings as an answer.
>
> The contract lives behind the `AgentRuntime` interface (`src/runtime.ts`), so
> when the runtime implements it nothing else in this service has to change.
> The boot log restates this warning on every start.

---

## 1. Security posture — this is the product, not a side effect

| Property | How it is enforced | Proved by |
|---|---|---|
| No shell, no child processes | `node:child_process` is never imported | `test/no-direct-network.test.ts` source scan |
| **No filesystem access at all** | `node:fs` is imported nowhere in `src/`; the image `chmod`s `/app` read-only and runs as `node`; there is no `VOLUME` | source scan + `Dockerfile` |
| No MCP | no MCP client, no transport, no import | source scan |
| No plugin or custom-tool mechanism | there is no extension point | source scan |
| Outbound network restricted to an allowlist | every call goes through the single `safeFetch` in `src/egress.ts` | `test/egress.test.ts` + a source scan asserting `fetch(` appears only in `egress.ts` |
| Only one module speaks the Chatwoot API | `api_access_token` and `/api/v1/accounts` appear only in `src/chatwoot.ts` | source scan |
| Every inbound delivery is authenticated | HMAC-SHA256 over `` `${timestamp}.${rawBody}` `` with the AgentBot's own secret | `test/signature.test.ts`, `test/webhook-http.test.ts` |
| A failed run is never dressed up as an answer | on any failure the customer message count is zero; a private note plus an escalation is the only output | `test/pipeline.test.ts` |
| No secret and no message content ever reaches a log | call sites pass identifiers, `redact()` strips credential-shaped keys, and a test drives a full delivery and scans every line | `test/no-content-logged.test.ts` |

---

## 2. The 5-second rule — the dominant design constraint

Chatwoot's webhook **open and read timeout is 5 seconds**
(`GlobalConfig WEBHOOK_TIMEOUT`, default 5, confirmed live as 5).

Chatwoot retries on **429 and 500 only** — 3 attempts, 3 seconds apart.
Everything else is single-shot.

On delivery failure, if the conversation is `pending` and the account lacks
`keep_pending_on_bot_failure` (it does lack it here), Chatwoot **auto-opens** the
conversation and posts an `agent_bot.error_moved_to_open` activity. That is the
native escalation. This service does not build a parallel one — it only escalates
explicitly on the paths where it *did* answer the webhook with 200 and then
failed downstream, where the native escalation cannot fire.

So the request path does **only** in-memory work:

1. read the raw bytes,
2. verify the HMAC,
3. de-duplicate,
4. resolve the binding,
5. evaluate the suppression predicate,
6. **ACK 200**,

and everything else — the runtime call, the reply, the escalation, the labels —
happens after the response has been written. `test/webhook-http.test.ts` injects
a runtime that takes 2 seconds and asserts the ACK still returns in under 1
second, with no message sent at ACK time.

---

## 3. Endpoints

### `POST /v1/chatwoot/agent-bot`

The AgentBot `outgoing_url`. Configure it in Chatwoot as:

```
https://<your-gateway-host>/v1/chatwoot/agent-bot
```

Expected headers (sent by `lib/webhooks/trigger.rb`, Chatwoot 4.16.1):

| Header | Meaning |
|---|---|
| `X-Chatwoot-Signature` | `sha256=<hex HMAC-SHA256>` |
| `X-Chatwoot-Timestamp` | unix seconds |
| `X-Chatwoot-Delivery` | uuid |

**The signed string is `` `${timestamp}.${rawBody}` `` — the RAW body, byte for
byte.** Re-serialising parsed JSON will not reproduce it, which is why the
handler reads bytes before anything parses them. `test/signature.test.ts` pins
that difference explicitly.

| Result | Status | What is sent |
|---|---|---|
| Verified, bound, not suppressed | `200 accepted` | processed asynchronously |
| Bad/missing/stale/future signature; unparseable body; inbox with no binding secret | `401 unauthorized` | nothing — and the response never says which half failed |
| Body over `GATEWAY_MAX_REQUEST_BYTES` | `413 payload_too_large` | nothing |
| Duplicate delivery | `200 duplicate_suppressed` | nothing |
| No de-duplication key can be formed | `200 not_deduplicable` | nothing |
| Unknown / duplicate / retired / `INTERNAL` binding | `200 binding_*` | nothing |
| Suppression predicate says no | `200 suppressed` | nothing |

`200` on the refusal branches is deliberate: Chatwoot only retries 429 and 500,
and a refusal is not going to become acceptable on a retry.

### `GET /healthz`

No auth. Reports `status`, `version`, the binding counts (total / active /
retired), the egress allowlist and the in-flight delivery count. It carries no
secret, and deliberately no base URLs.

### `GET /v1/bindings`

`Authorization: Bearer <GATEWAY_ADMIN_TOKEN>`, compared in constant time.
Returns the binding metadata with `agentBotSecret` and `agentBotAccessToken`
replaced by `"[redacted]"` plus `*Configured: true` flags. Returns `503` when no
admin token is configured — an unauthenticated bindings dump is not a fallback.

---

## 4. The suppression predicate — Chatwoot does NOT do this for you

`app/listeners/agent_bot_listener.rb:65-77` checks **neither conversation status
nor assignee** before dispatching `message_created` to the bot, and delivery
provably continues to a conversation a human has taken over. Without the
predicate below, the bot talks over a live agent.

A reply is sent only when **all** of these hold:

```
conversation.status        === "pending"
conversation.meta.assignee === null
message_type               === "incoming"
private                    === false
sender.type                !== "agent_bot"
```

Otherwise: `200`, nothing sent, and the reason is logged as
`suppressionReason`. The reasons are:

`not_message_created` · `no_conversation_id` · `message_type_not_incoming` ·
`private_note` · `private_flag_absent` · `sender_is_agent_bot` ·
`status_not_pending` · `human_assigned` · `empty_content`

Two of those go beyond the five conditions, both fail-closed:

- **`private_flag_absent`** — a payload with no boolean `private` is treated as
  private. Guessing "public" on a malformed payload risks answering a private
  note in the customer's channel.
- **`empty_content`** — there is nothing to answer, so the model is not called.

> **Known gap.** An attachment-only message (`content: null`) lands in
> `empty_content`: the gateway acknowledges, sends nothing, and — because it
> answered 200 — Chatwoot's native auto-open does not fire either. The customer
> is left waiting for a human who has not been summoned. Closing this means
> deciding whether an unanswerable inbound should escalate; that is a product
> decision, not a code one, so it is documented rather than guessed.

`conversation.id` in the payload is the **`display_id`** — the value the
conversation API path expects, **not** the database primary key. Using the pk
would 404 on every reply.

---

## 5. Bindings

A binding maps one Chatwoot inbox to exactly one tenant, one Paperclip company,
one PUBLIC employee and one template.

```jsonc
[
  {
    "tenantId": "tenant-acme",
    "chatwootAccountId": 1,
    "chatwootInboxId": 7,
    "chatwootAgentBotId": 3,
    "agentBotSecret": "<the AgentBot's secret>",
    "agentBotAccessToken": "<the AgentBot's access_token>",
    "paperclipCompanyId": "company-1",
    "paperclipAgentId": "agent-1",
    "templateId": "isola-ai-sales-front-desk-agent@v1",
    "exposure": "PUBLIC",
    "status": "active",
    "escalationTeamId": 5,          // optional
    "labels": ["vip-lane"]          // optional, extra approved labels
  }
]
```

Loaded from `GATEWAY_BINDINGS_JSON` at boot and validated strictly. **The
service refuses to start** (exit 1, each error logged) when any binding has:

- `exposure` that is not exactly `"PUBLIC"` — an INTERNAL employee must never be
  reachable from a public inbox;
- a duplicate `(chatwootAccountId, chatwootInboxId)` pair — two tenants on one
  inbox is an isolation failure, not a routing choice;
- a missing `agentBotSecret` or `agentBotAccessToken`;
- a missing or malformed required field, or an unknown `status`.

Validation errors name the field and the array index, **never a value**, so a
bad secret cannot be echoed into a boot log.

An unset or empty `GATEWAY_BINDINGS_JSON` is *not* an error: the service boots
with zero bindings, `/healthz` answers, and every webhook is rejected as
unverifiable. A boot warning says so.

`BindingStore` (`src/bindings.ts`) is an interface. The env-backed
`StaticBindingStore` can be replaced by a NocoBase-backed store without touching
the handler — which is why `resolveBinding` still refuses duplicates at request
time even though boot validation already rejects them.

---

## 6. Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | Listen port. |
| `GATEWAY_BINDINGS_JSON` | *(empty)* | JSON array of bindings. Invalid content refuses the boot. |
| `GATEWAY_ADMIN_TOKEN` | *(unset)* | Bearer for `GET /v1/bindings`. Unset ⇒ that endpoint is `503`. |
| `CHATWOOT_BASE_URL` | `https://isola-chat.saas00.epic.dm` | Chatwoot origin. |
| `GATEWAY_CHATWOOT_TIMEOUT_MS` | `15000` | Per-call timeout to Chatwoot. |
| `RUNTIME_BASE_URL` | `http://isola_isola-runtime:3000` | isola-runtime on the private container network. |
| `RUNTIME_INVOKE_PATH` | `/v1/invoke` | Invocation path. |
| `RUNTIME_SECRET_PUBLIC` | *(unset)* | Bearer presented to isola-runtime. Unset ⇒ every invocation fails closed and every conversation escalates. |
| `GATEWAY_RUNTIME_TIMEOUT_MS` | `90000` | Runtime call timeout. This is the **async** leg — it is not bounded by Chatwoot's 5s. |
| `EGRESS_ALLOWLIST` | derived from `CHATWOOT_BASE_URL` + `RUNTIME_BASE_URL` | Comma-separated hostnames. Exact match only, no suffix matching. An explicit value replaces the derived list wholesale. |
| `GATEWAY_MAX_REQUEST_BYTES` | `1048576` | Hard ceiling on a webhook body. |
| `GATEWAY_REPLAY_WINDOW_SEC` | `300` | Signature timestamp skew allowed, **past and future**. |
| `GATEWAY_IDEMPOTENCY_TTL_MS` | `86400000` | How long a delivery id is remembered. |
| `GATEWAY_IDEMPOTENCY_MAX_ENTRIES` | `50000` | Cap on the in-memory de-duplication window; oldest evicted first. |
| `GATEWAY_APPLY_LABELS` | `true` | Apply the outcome label (read-modify-write). |
| `GATEWAY_APPLY_CUSTOM_ATTRIBUTES` | `true` | Apply the outcome attributes (read-modify-write). |
| `GATEWAY_LABEL_ANSWERED` | `isola-ai-answered` | Label applied on a successful reply. Set to empty to disable. |
| `GATEWAY_LABEL_ESCALATED` | `isola-ai-escalated` | Label applied on an escalation. Set to empty to disable. |

Nothing else is read from the environment.

---

## 7. What happens after the ACK

```
runtime.invoke({templateId, exposure: "PUBLIC", agentId, runId, context, responseMode: "inline"})
```

`runId` is the Chatwoot delivery id when present (so a Chatwoot retry is
idempotent at the runtime too), otherwise the gateway correlation id.

| Runtime result | Customer message | Private note | `toggle_status: open` | Assign |
|---|---|---|---|---|
| `ok` **with** text | the answer | – | – | – |
| `ok` **without** text (`runtime_no_text`) | **none** | yes | yes | if `escalationTeamId` |
| `budget_exhausted` (402) | **none** | yes | yes | if `escalationTeamId` |
| `provider_error` (502) | **none** | yes | yes | if `escalationTeamId` |
| `model_timeout` (504) | **none** | yes | yes | if `escalationTeamId` |
| `exposure_mismatch` (403) | **none** | yes | yes | if `escalationTeamId` |
| `unauthorized` / unreachable / other | **none** | yes | yes | if `escalationTeamId` |
| the reply POST itself failed (`reply_failed`) | not re-sent | yes | yes | if `escalationTeamId` |

The private note states the failure plainly, names the correlation id and the
tenant, and says explicitly that no message was sent to the customer. It never
contains customer content.

### Labels and custom attributes are read-modify-write

Both Chatwoot endpoints are **full replacements**. Both are therefore read
first, merged, then written — and **if the read fails, the write is skipped**.
Losing our own label is trivial; wiping a human's labels or a tenant's custom
attributes is not.

Only the approved keys are ever written:

```
isola_tenant_id · isola_agent_id · isola_last_outcome ·
isola_last_correlation_id · isola_last_run_at
```

---

## 8. Persistence — and the honest limit

There is **no persistence at all**. The delivery de-duplication window lives in
memory.

A container replacement loses it. The worst case is one duplicate reply for a
delivery that was in flight across the restart — and since Chatwoot only retries
429 and 500, and this service answers 200 on every branch it has already
processed, that window is very narrow. Making it durable would mean giving the
only publicly-exposed component a filesystem or a database, which is a worse
trade. `IdempotencyStore` is an interface if that judgement ever changes.

An **ACKed delivery is never retried by Chatwoot**, so `SIGTERM` drains the
in-flight deliveries before exiting.

---

## 9. Logging

One JSON line per event, on stdout. Every line carries:

```
ts · level · service · version · correlationId · deliveryId ·
accountId · inboxId · conversationId · tenantId · outcome · durationMs
```

**Never logged:** any secret, and any message content — neither the customer's
message nor the AI's answer. The success line reports `answerChars`, a length,
not the text. `redact()` additionally strips any credential-shaped key and any
bearer-shaped value as a backstop, and `test/no-content-logged.test.ts` drives a
full delivery and scans every emitted line.

The 401 branch logs a precise `rejectionReason`
(`signature_mismatch`, `timestamp_too_old`, `no_binding_secret`, …) **server-side
only**. The HTTP response says `unauthorized` and nothing more: telling a caller
which half failed turns the endpoint into an oracle for the replay window and
for which inboxes exist.

---

## 10. Build, test and deploy

```bash
npm ci
npm run typecheck
npm test
npm run build && npm start
```

```bash
docker build -t isola-gateway:1.0.0 services/isola-gateway
```

The build context **must** be `services/isola-gateway/`. This service depends on
no monorepo workspace package and has **zero runtime dependencies** — the
runtime image copies `dist/` and `package.json` and no `node_modules` at all.

In EasyPanel: set the build context / build path to `services/isola-gateway` and
the Dockerfile to `./Dockerfile`. The image is multi-stage, runs as the non-root
`node` user, honours `PORT` (default 3000) and declares no volume.

### Chatwoot setup checklist

1. Create an AgentBot in the Chatwoot account; note its `secret` and its
   `access_token`.
2. Set its `outgoing_url` to `https://<gateway-host>/v1/chatwoot/agent-bot`.
3. Assign the bot to exactly one inbox.
4. Put `(accountId, inboxId, agentBotId, secret, access_token)` into
   `GATEWAY_BINDINGS_JSON` with `"exposure": "PUBLIC"`.
5. `GET /healthz` must report the binding as active.
6. `GET /v1/bindings` with the admin bearer must show it, redacted.

**One authoritative processor per number.** Do not also wire the same inbox to
Clawith or to the BFF. Human takeover is the governed escalation contract in §7,
not a second webhook.

---

## 11. Judgement calls

1. **An inbox with no binding gets 401, not 200.** The spec asks for 401 on an
   unverifiable delivery and 200 on an unresolvable binding — but the secret
   lives *on* the binding, so with no binding there is no secret and the request
   cannot be authenticated at all. Refusing to answer 200 to an unauthenticated
   caller wins. A binding that exists but is retired, duplicated or non-PUBLIC
   *does* verify, and *does* get the 200-and-do-nothing treatment.

2. **Signature verification tries every secret registered for that inbox**,
   including retired ones, so an authentic delivery from a retired bot is
   reported as `binding_retired` rather than as `unauthorized`. Boot validation
   already guarantees at most one binding per pair, so this is normally a single
   HMAC.

3. **The replay window is symmetric.** 300 seconds of tolerance in both
   directions, since clock skew has no preferred sign.

4. **`private` absent ⇒ treated as private** (`private_flag_absent`), and
   **empty content ⇒ not answered** (`empty_content`). Both are fail-closed
   additions to the five stated conditions. See the known gap in §4.

5. **`message_type` is accepted as a string or as the enum ordinal.** Chatwoot
   has shipped both; mis-classifying an outgoing message as "unknown" and then
   treating "unknown" as safe would be a real bug.

6. **`runId` = the Chatwoot delivery id.** It is already a uuid and it is stable
   across Chatwoot's retries, which makes the runtime call idempotent for free.

7. **A failed customer reply is never re-sent.** We cannot know whether it
   landed; a duplicate answer to a customer is worse than a private note saying
   delivery is unconfirmed.

8. **"Approved labels and custom attributes"** was not enumerated in the spec,
   so it is defined here: two configurable outcome labels plus optional
   per-binding extras, and a hardcoded five-key attribute allowlist. Anything
   else the code tries to write is dropped by `filterApproved*`.

9. **The de-duplication window is in memory.** See §8.

10. **`/healthz` omits the base URLs.** They are not secrets, but the endpoint is
    unauthenticated and the runtime hostname is internal. They are on
    `/v1/bindings` instead.
