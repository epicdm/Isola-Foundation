# Branch notes: the DIRECT Hermes path (Step A)

Branch `feat/direct-hermes-adapter-2026-10-03`, cut from `c577eed` (the reviewed pivot branch head). The pivot branch
`feat/pivot-gateway-thin-connector-2026-10-02` is untouched. **Status: built and tested against a fake Hermes. NOT deployed,
NOT reviewed by Codex, NOT approved, no PR.** Owner-approved priority change (2026-10-03): customer conversations run
DIRECTLY through the long-lived `isola_hermes-public` service; Paperclip is not in the reply path.

## What it is

An `AgentRuntime` (`src/hermes-runtime.ts`) that creates a Hermes run with `POST /v1/runs`, reads the run's event stream to
the end, polls the status as the fallback, and turns the final output into a result through a one-line JSON envelope. The
ledger, the ownership gate, the post-run recheck, the write fences and the escalation-only recovery are the reviewed modules,
unchanged. It is selected per employee (`GATEWAY_HERMES_AGENT_IDS`), default OFF, and one employee has one execution owner.

| Commit | What |
|---|---|
| `5697b72` | the per-turn idempotency key moves from the Paperclip module to `idempotency.ts` (byte-identical) |
| `f05810e` | pure pieces `src/hermes-input.ts`: session label, `conversation_history`, input lines, envelope |
| `9cb2826` | `src/hermes-runtime.ts` + the fake Hermes and its tests |
| `6a12144` | config, boot refusals, routing in `app.ts`, failure explanations, route-level tests |

## Configuration (names only, never values)

`GATEWAY_HERMES_AGENT_IDS` (the binding's registered employee ids; empty = OFF) - `GATEWAY_HERMES_BASE_URL` (the public
service only, e.g. `http://isola_hermes-public:8642`) - `GATEWAY_HERMES_BEARER` (the service API key, from a Swarm secret
attached by name through `GATEWAY_HERMES_BEARER_FILE`) - `GATEWAY_HERMES_RUN_DEADLINE_MS` (default 75000, max 85000) -
`GATEWAY_HERMES_POLL_INTERVAL_MS` (1000, min 100) - `GATEWAY_HERMES_REQUEST_TIMEOUT_MS` (20000; a value under 15000 is a boot
warning) - `GATEWAY_HERMES_MAX_INFLIGHT` (8, max 10) - `GATEWAY_HERMES_RATE_LIMIT_BACKOFF_MS` (1000) -
`GATEWAY_HERMES_HISTORY_MAX_TURNS` (20, max 20) - `GATEWAY_HERMES_HISTORY_MAX_CHARS` (8000, max 8000).

`GATEWAY_PAPERCLIP_AGENT_IDS` stays unset; `PaperclipAgentRuntime` is kept and unreferenced. Boot REFUSES (bootErrors): a
missing/unsendable base URL (userinfo, query, fragment, non-http), a host not on the egress allowlist, the owner-privileged
operator gateway or its bridge (port 8645, `hermes-tunnel`, `isolahb_bridge`), a missing credential, a missing ledger (the
transcript lives in it), a non-PUBLIC binding, an employee enabled for both Hermes and Paperclip, a deadline above 85 s or
not inside the runtime timeout / turn budget, a deadline plus one request timeout not inside the ledger lease, more than 10 in
flight, a history window larger than the store keeps.

## The Hermes contract this is built to

SOURCE: lane 59's `HERMES-PUBLIC-RUNS-API-CONTRACT-FOR-AGENT-2026-10-03.md`, read from the service's code and **VERIFIED by
Step B on 2026-10-03 06:10-06:12Z** (9 model-bound requests). The fake follows it; the fake is not evidence of installed behaviour.

| Fact | Status |
|---|---|
| `POST /v1/runs` -> `202 {"run_id","status":"started"}`; body `input`, `instructions`, `conversation_history`, `session_id` | VERIFIED |
| status `running` then `completed` with `output` and `usage`; `failed` with `error`; `cancelled` | VERIFIED (completed); failed/cancelled from code |
| SSE `message.delta`, `reasoning.available`, `run.completed{output,usage}`, then the stream closes itself with `: stream closed` | VERIFIED |
| `Idempotency-Key` IGNORED on `/v1/runs` (two keys = two runs, two provider calls) | VERIFIED |
| `/stop` stops MODEL EXECUTION (200 in 0.11 s, no further output); a second `/stop` on a finished run is 404 | VERIFIED (1 in-flight run) |
| Paperclip's own cancel did NOT call `/stop` and the model still completed | VERIFIED (EPI-328) |
| `session_id` is a label that loads nothing; history comes only from `conversation_history`; a different customer's transcript cannot see another's | VERIFIED |
| warm 2.9-3.3 s end to end; first run after ~65 min idle 10.2 s; the API server answers nothing for ~1 s warm / ~6 s post-idle while a run starts | VERIFIED, small n |
| consuming `/events` to the end releases the run's slot; 7 such runs never hit 429 | VERIFIED for consumed streams |
| poll-only 429 behaviour; run-state loss on a Hermes restart (a 404) | **UNVERIFIED** |
| the exact layout of the `Conversation id:` / `Isola assertion:` lines the deployed charter expects; whether the ephemeral `instructions` conflict with the charter | **UNVERIFIED** (isolated in `renderHermesInput` / `HERMES_ENVELOPE_INSTRUCTIONS`) |
| `X-Hermes-Session-Key` maximum length; Hermes' maximum `session_id` length (<=256 is documented) | the label is 69 characters |

**Differences from what the first brief (docs-based) assumed, all replaced:** `/v1/runs` does NOT honour `Idempotency-Key`
(so no `Idempotency-Replayed` handling exists and the header is not sent); `X-Hermes-Session-Key` gives NO memory on `/v1/runs`
(so it is not sent); the `session_id` label does not load history (so continuity is `conversation_history`); the cap of 10 is
released only when the stream is read to the end (so every run's stream is consumed).

## Rules the adapter enforces (each has tests and a sabotage)

1. **Never POST `/v1/runs` twice for one ledger key.** The service cannot dedupe; the ledger refuses a redelivery before this
   is reached, and the adapter refuses a second invoke of the same key, even after a failed first attempt.
2. **Every run's event stream is read to the end** under the same deadline and a 1 MiB cap; a stream that breaks falls back to
   polling; a stream that never closes after the run finished is abandoned after a grace and logged.
3. **Takeover, spent turn or deadline: `POST /stop`, and the run id is remembered as cancelled**; output of a cancelled run, or
   of a run this turn did not create (a status or event carrying another run id), is never used. A 404 on `/stop` means "maybe
   finished": the output is still discarded. The adapter looks at ownership again right before text leaves it.
4. **One absolute deadline** over create, polls, stream and every body; redirects are refused by the egress guard; 4xx is a
   config defect with no retry; a 5xx or a dropped connection on the create is an uncertain create, never re-created; a 429
   gets ONE identical retry that fits inside the deadline, then escalates.
5. **Fail closed, no model text:** failed / cancelled / 404 / a stream closed without a terminal event / no or bad envelope /
   no history / a missing identity = one outcome and an escalation through the existing path.
6. **One run per conversation at a time; a global cap below Hermes' 10.** A wait that outlasts the deadline is `hermes_busy`
   and nothing is sent.
7. **Continuity** is the gateway's own transcript for the SAME conversation: customer -> `user`, every business turn -> `assistant`
   (the store collapses the AI and staff into one voice; no marker is injected), the current message is located as the LAST
   matching customer turn, removed and sent only as `input`, newer turns dropped, newest 20 turns / 8000 characters, oldest
   dropped first. No transcript, or one that does not contain the current message = no request and an escalation.
8. **The envelope:** the model's output must END with one JSON line `{"disposition":"answer"|"request_human","text","reason"}`.
   Only that `text` is ever sent (<= 2000 UTF-16 units, refused above, never truncated); a `reason` is kept only if it is in the
   closed set. `hermes_envelope_parse_failure` (stable event name) and `stats()` expose the parse-failure rate.

## Deviations and choices that need a reviewer

- **A best-effort `/stop` is sent AFTER the turn signal fires.** `AgentRuntimeRequest.signal` says a runtime must start no request
  once it fires; this adapter starts no create/poll/stream after it but does send ONE stop (a cancellation removes work; it is
  not a dispatch). Reviewed rule vs a runaway model call: decide.
- `instructions` (the envelope contract) is sent on every run; whether it appends to or competes with the charter is UNVERIFIED.
- The customer's current message is cut to 4000 UTF-16 units in `input`.
- The `request_human` envelope's `text` IS sent to the customer, then the conversation is escalated (the existing behaviour).
- The Hermes request carries NO ids from the Chatwoot context: only the label, the rendered input and the history.

## KNOWN GAP found while building the route tests (not fixed here)

A signed HUMAN-AGENT reply takes the `human_reply` decision in `app.ts`, which records the takeover in the ownership ledger and
returns BEFORE the transcript-recording block (that block handles only the accept and suppressed decisions). So what staff
wrote is NOT in the transcript, although `turns.ts` says human replies are recorded: after a handback the model does not see
what the person told the customer. The bot's own echoed replies and the customer's messages ARE recorded. A route test pins
the current behaviour as "KNOWN GAP (pinned, to be flipped when fixed)".

## Open risks

- **F2 (late-worker overlap) and F3 (late-send duplicate) from Codex rounds 3-6 apply unchanged** to this path: exclusivity is
  not provided by timing, a fenced-lease design exists as a proposal and is not authorised.
- Customer scope is fixture-only; there is no production resolver. `contact_inbox` on Chatwoot 4.18 is unverified. No alert
  reaches a person out-of-band (log event + private note only).
- **Hermes restart loses in-flight runs**: a 404 on the run escalates once and is never re-driven (recovery is escalation-only).
- Cold start 10 s after idle against the 15 s first-answer goal; Hermes' cap of 10 runs is shared with any other client of the service.
- The business tools are not real yet (service OFF, source gate, dead address, no minter): the assertion provider returns
  nothing by default, so the line says `none` and the tools refuse.
- Staff turns are indistinguishable from the AI's in the history.
- The envelope's parse-failure rate is unknown until a real run; a high rate means moving to a native tool.
- In-memory state only (started keys, cancelled ids): a gateway restart forgets them; recovery then escalates, it never re-POSTs.
- Session continuity across a Hermes restart is unverified; it does not depend on Hermes memory (the history is re-sent every turn).

## Not built

The assertion minter (a provider seam exists, empty by default); the production customer-scope resolver; any provisioning
(the demo sales action is a staff handoff); Paperclip async work reporting; any schema or lease/fence work; a Hermes profile.

## Interim operating rule

UAT sandbox only, monitored, test conversations only. No production use, no 0001, no Meta change, no ads, no customer contact.
Paperclip routing stays OFF. Nothing here is deployed or applied.

## Tests

From `services/isola-gateway`: `OWNERSHIP_PG_TESTS=skip npx vitest run` and `npx tsc --noEmit`. Base 1255 passed / 30 skipped;
final 1451 passed / 30 skipped / 0 failed, `tsc` 0 (the 30 skipped are the real-Postgres tests). All new tests are socket-free:
the gateway handler is driven in-process (`test/hermes-inproc.ts`) and Hermes is an injected `SafeFetch` (`test/hermes-fake.ts`).

## Disclosures

- Commit 3 (the adapter) was NOT tests-first: the implementation was written before its first red run; the red run was
  re-created afterwards against a throwing skeleton (69 of 70 red, the one pass being the fake's own sanity test). Its value
  rests on 17 sabotages (each caught, restored hash-identical). Commits 1, 2 and 4 were tests-first (6, 56 and 52 red).
- One final-ownership-look sabotage was first NOT caught; a test was added that reaches it, and then it was caught.
- Two commit-message numbers are wrong and were not amended (already pushed): `9cb2826` says "76 tests; 69 red" (the red run was
  of the 70-test version; the file now has 76), and `6a12144` says "14 sabotages" (the count is 11: lease sum, privileged host,
  one owner, PUBLIC-only, in-flight cap, egress derivation, ledger requirement, credential requirement, advisory warning, routing,
  failure explanations).
- The route test for a recovered interrupted turn drives `processDelivery` plus the real sweeper (not a gateway built by
  `createGateway`) because the sweeper is created by the server, not by the gateway factory.
- A temporary debug test file was created and removed during the work; it is not in any commit.

## PORT-READY paragraph

Direct Hermes path (Step A), branch `feat/direct-hermes-adapter-2026-10-03`: a `HermesDirectRuntime` in `services/isola-gateway`
runs a customer turn through `isola_hermes-public` with POST `/v1/runs`, no Paperclip in the loop, selected per employee and
OFF by default. Built to lane 59's Step-B-verified contract: `/v1/runs` ignores Idempotency-Key, so the adapter never POSTs twice
per ledger key; every run's stream is read to the end; on takeover, a spent turn or the deadline the run is stopped and its output
discarded; continuity is `conversation_history` from the gateway's own transcript; the model's output must end with a one-line
JSON envelope and anything else is no text plus one escalation. 1451 tests pass against a fake Hermes (no socket); not deployed,
not reviewed. Open: late-worker/late-send exclusivity (F2/F3), fixture-only customer scope, no out-of-band alert, tools not real,
Hermes restart loses runs (escalate, never re-drive), parse-failure rate unknown, and a found gap: staff replies are not in the
transcript. Sandbox only.
