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
| A handoff is never claimed unless it happened | the customer message is sent only after `toggle_status` and the assignment succeed | `test/handoff.test.ts` |
| An attachment is never opened, fetched or described | only `file_type` is parsed, mapped onto a closed vocabulary; `data_url` is never read | `test/handoff.test.ts` — real clients over a recording egress, attachment host absent |
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

So the request path does only pure work plus **one** I/O call:

1. read the raw bytes,
2. verify the HMAC,
3. resolve the binding,
4. evaluate the suppression predicate,
5. **durably reserve the delivery** in the private ledger (§8),
6. **ACK 200**,

and everything else — the runtime call, the reply, the escalation, the labels —
happens after the response has been written. `test/webhook-http.test.ts` injects
a runtime that takes 2 seconds and asserts the ACK still returns in under 1
second, with no message sent at ACK time.

Step 5 is a single `INSERT ... ON CONFLICT` against a Postgres on the container
network — single-digit milliseconds. It is on the request path deliberately: an
acknowledgement that is not durably recorded is an acknowledgement that a
restart can forget, and Chatwoot never re-offers a delivery it saw ACKed.

Note that binding resolution now precedes de-duplication, which is the reverse
of the original order. The ledger's atomic key is scoped by tenant and binding,
so you cannot claim a key until you know whose key it is. The only observable
difference is that a duplicate addressed to a retired binding reports
`binding_retired` rather than `duplicate_suppressed`; both are 200 with nothing
done.

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
| Verified, bound, not suppressed | `200 accepted` | processed asynchronously — the AI answer, or the §4.1 handoff when there is no usable text |
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

`evaluateSuppression` is a pure function over a verified payload and returns one
of three actions: **reply**, **handoff** (§4.1) or **suppress**.

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
`status_not_pending` · `human_assigned`

One of those goes beyond the five conditions, and it is fail-closed:

- **`private_flag_absent`** — a payload with no boolean `private` is treated as
  private. Guessing "public" on a malformed payload risks answering a private
  note in the customer's channel.

`conversation.id` in the payload is the **`display_id`** — the value the
conversation API path expects, **not** the database primary key. Using the pk
would 404 on every reply.

### 4.1 No usable text ⇒ hand over to a human, and say so

A message that passes **every** check above but carries no text the model can
read is **not** suppressed. It used to be (`empty_content`), and that was the
documented gap: the gateway acknowledged, sent nothing, and — because it
answered 200 — Chatwoot's native auto-open did not fire either, so the customer
waited for a human nobody had summoned.

Two cases, one shared handoff. **The model is not invoked on either.**

| Case | Trigger | Customer message, verbatim |
|---|---|---|
| **A** — attachment / unsupported content | one or more `attachments`, or a `content_type` other than `text`, and no usable text | `Thanks — I received your attachment and passed this conversation to a team member for review.` |
| **B** — truly empty | no attachments, no unsupported content type, no usable text | `I couldn't read that message, so I passed the conversation to a team member.` |

The handoff runs in this exact order, all of it **after** the ACK:

1. `toggle_status` → `open`
2. `assignments` with `team_id`, when the binding configures `escalationTeamId`
3. the AI is now suppressed for that conversation **by the predicate above** —
   an `open` conversation with an assignee is refused by `status_not_pending`
   and `human_assigned`, which are evaluated *before* the no-text branch. There
   is deliberately **no second suppression mechanism**; `test/handoff.test.ts`
   asserts the first one holds rather than assuming it.
4. exactly **one** private note, carrying the reason plus the attachment **type
   and count only**
5. and only then, exactly **one** customer-visible message

**The attachment is never opened, downloaded, inspected, inferred from or
described.** The parser reads `file_type` and nothing else — never `data_url`,
never `thumb_url`, never `file_name` — so no URL and no filename exists anywhere
downstream to be logged or fetched. Every `file_type` is mapped onto a closed
vocabulary (`image`, `audio`, `video`, `file`, `location`, `fallback`, `share`,
`story_mention`, `contact`, `ig_reel`, else `other`), so what reaches a note or
a log line can never be caller-controlled text. `test/handoff.test.ts` drives a
delivery through the **real** Chatwoot and runtime clients over a recording
egress primitive and asserts the complete set of hosts contacted is Chatwoot
alone — the attachment host and the runtime are both absent.

#### If the handoff fails, the customer is told nothing

**`toggle_status` or the assignment failing means no customer message.** Telling
a customer their conversation is with a team member when it is not is a lie they
cannot check. On that path the gateway:

- records the outcome **`handoff_blocked`** and logs it at **error** level with
  `failedStep`, `customerMessageSent: false` and `needsRetry: true`, for
  operator alerting;
- leaves the conversation **open** where that step did succeed — no rollback,
  because hiding the half-done state helps nobody;
- posts the one private note, saying plainly that no message was sent to the
  customer and the conversation needs picking up by hand;
- writes `isola_last_outcome: handoff_blocked` and the escalated label, so it is
  findable in Chatwoot.

A failed **note** does not block the acknowledgement: the conversation genuinely
is open and assigned, so the sentence is still true. It is logged at error level
as `handoff_note_failed`. A failed **acknowledgement** is never re-sent (§11.7)
and is logged as `handoff_ack_failed` with `needsRetry: true`.

#### Every write is idempotent by the delivery id

A duplicate delivery produces no second note, no second assignment and no second
customer message. Two lines of defence, both on the **same** store:

1. `X-Chatwoot-Delivery` gates the whole pipeline — a repeat is
   `duplicate_suppressed` at the ACK and never reaches the asynchronous half;
2. each individual write is additionally claimed under
   `` `<deliveryKey>#<write>` `` — `handoff_toggle_status`,
   `handoff_assignment`, `handoff_note`, `handoff_customer_message`, `reply`,
   `failure_note`, `escalate_toggle_status`, `escalate_assignment`, `labels`,
   `custom_attributes`.

Because entries evict oldest-first and the delivery key is always claimed before
its own write keys, the delivery key is evicted first — so a retry landing in
that gap re-enters the pipeline and then finds every write already claimed.

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
| `GATEWAY_LEDGER_URL` | *(unset)* | Connection string for the private durable delivery ledger. **Unset ⇒ the service refuses to boot** (§8). |
| `GATEWAY_LEDGER_LEASE_MS` | `300000` | How long a delivery's lease is held before the recovery sweeper may take it over. Must exceed `GATEWAY_RUNTIME_TIMEOUT_MS` or a slow-but-healthy run gets processed twice; a boot warning fires if it does not. |
| `GATEWAY_LEDGER_RECOVERY_INTERVAL_MS` | `60000` | How often the sweeper looks for expired leases. |
| `GATEWAY_LEDGER_RECOVERY_BATCH` | `20` | Maximum deliveries recovered per sweep. |
| `GATEWAY_LEDGER_REQUIRED` | `true` | Set false only for a deliberate, temporary run without durability. |
| `GATEWAY_IDEMPOTENCY_TTL_MS` | `86400000` | Retained for compatibility; the ledger has no TTL. |
| `GATEWAY_IDEMPOTENCY_MAX_ENTRIES` | `50000` | Retained for compatibility; the ledger has no entry cap. |
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

The runtime is **not called at all** on the no-usable-text path (§4.1), which is
recorded as `runtimeOutcome: not_invoked`:

| Handoff result | Customer message | Private note | `toggle_status: open` | Assign |
|---|---|---|---|---|
| `handed_off` | the verbatim string for the case | yes | yes | if `escalationTeamId` |
| `handoff_blocked` | **none** | yes | attempted | attempted |

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

## 8. Persistence — the durable delivery ledger

This service still has **no local state**: `node:fs` is imported nowhere in
`src/`, there is no volume, and `/app` is read-only. What it has instead is a
dependency on `isola-ledger-db` — a dedicated Postgres in the same EasyPanel
project, with **no domain and no exposed port**, reachable only on the container
network. The gateway container remains disposable; the ledger does not.

**Why it exists.** De-duplication used to live in a `Map`. A container
replacement lost it, so a duplicate delivery arriving across a restart produced
a second customer reply. That was recorded honestly as a known limitation and
has now been closed.

**The atomic key** is the table's primary key, so uniqueness is enforced by
Postgres rather than argued for in prose:

```
(tenant_id, binding_id, chatwoot_account_id, chatwoot_inbox_id, event_id, action_type)
```

`action_type` is `delivery` for the reservation taken before the ACK, and one
row per individual write beneath it (`reply`, `failure_note`, `handoff_ack`, …).

**What is stored:** identifiers, action type, payload digest, correlation id,
delivery state, lease owner and expiry, attempt count, the returned Chatwoot
message id, timestamps and a failure code.

**What is never stored:** message bodies, AI answers, attachment filenames or
URLs, credentials — anything a customer wrote or the model produced.
`test/ledger-no-content.test.ts` asserts the column list by scanning the DDL, so
a content-bearing column added later fails the build.

**Restart recovery.** A reservation whose lease expires is picked up by the
sweeper (`src/recovery.ts`), which re-reads the conversation **from Chatwoot** —
the system that owns the message — rather than from a copy in the ledger. That
also means the suppression predicate is re-evaluated against current state, so a
conversation a human took over during the outage is closed out instead of being
answered late.

**Digest conflict.** The same event id re-presented with a different signed body
is refused with `409 ledger_conflict` and alerted on. It is a collision or a
tampering attempt, not a retry.

**Ledger unavailable.** The webhook answers `500 ledger_unavailable` rather than
a false `200`. 500 is deliberate: Chatwoot v4.16.1 retries an agent-bot webhook
on `429` and `500` **only** (`Webhooks::Trigger::RETRYABLE_AGENT_BOT_STATUSES`),
so any other status would drop the delivery silently. After the three retries
are spent, Chatwoot's own failure handling opens the conversation and posts
`agent_bot.error_moved_to_open`, so the customer reaches a human.

**The remaining honest limit.** If the ledger is down for longer than Chatwoot's
three retries (≈9 seconds), that delivery is not answered by the AI at all. It
is not lost silently — the conversation is opened to a human by Chatwoot itself,
and `alertCode: ledger_unavailable_on_ack` fires. Failing closed to a human is
the intended behaviour, not a gap.

An **ACKed delivery is never retried by Chatwoot**, so `SIGTERM` drains the
in-flight deliveries before exiting.

---

## 9. Logging

One JSON line per event, on stdout. Every line carries:

```
ts · level · service · version · correlationId · deliveryId ·
accountId · inboxId · conversationId · tenantId · outcome · durationMs
```

**Never logged:** any secret, any message content — neither the customer's
message nor the AI's answer — and no attachment filename or URL. The success
line reports `answerChars`, a length, not the text. The handoff line reports
`attachmentCount` and the closed-vocabulary `attachmentTypes`, never a name. `redact()` additionally strips any credential-shaped key and any
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

4. **`private` absent ⇒ treated as private** (`private_flag_absent`) — a
   fail-closed addition to the five stated conditions. **No usable text ⇒ not
   answered but not dropped either**: it is the §4.1 handoff, which was
   previously the `empty_content` suppression branch and the documented gap.

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

9. **De-duplication is durable, in a private Postgres.** See §8. This reverses
   the original judgement, which was that giving the only publicly-exposed
   component a database was the worse trade. It was the worse trade only while
   the alternative was a *filesystem*; a domain-less, port-less store on the
   container network costs far less than a duplicate reply to a customer.

10. **`/healthz` omits the base URLs.** They are not secrets, but the endpoint is
    unauthenticated and the runtime hostname is internal. They are on
    `/v1/bindings` instead.

11. **Case A covers attachments *and* an unsupported `content_type`.** The owner
    specified them as one case with one wording, and from the customer's side
    they are the same event — something arrived that could not be read. A
    `content_type` of `location`, `sticker`, `voice` and so on therefore gets
    the attachment sentence even with zero attachments.

12. **A failed private note does not block the acknowledgement.** The stated
    blocking rule names `toggle_status` and the assignment. If both of those
    succeeded, the conversation genuinely is open and with a human, so the
    sentence the customer reads is true whether or not the internal note
    landed. The note failure is logged at error level as `handoff_note_failed`.

13. **The blocked path still posts its one private note.** It is the only way an
    operator sees the failure inside Chatwoot rather than only in a log, and a
    private note is not a customer message, so it cannot make the gateway
    dishonest to the customer.

14. **`needsRetry` is a flag, and the ledger is now the retry surface.** An
    error-level log line plus `isola_last_outcome: handoff_blocked` on the
    conversation are still emitted, but the unfinished work is also a ledger row
    in `reserved` / `in_progress` with an expired lease, which the recovery
    sweeper picks up. A write left genuinely ambiguous is deliberately NOT
    completed, so it stays visible and re-reconcilable rather than being
    silently written off.

15. **An unsupported `content_type` is mapped to `other`, not carried.** Same
    reasoning as `file_type`: anything that can reach a private note or a log
    line has to come from a closed vocabulary, or the payload author chooses
    what operators read.
