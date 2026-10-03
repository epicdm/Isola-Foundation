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
| `6d038a8` | these notes (Step A) |
| `fcf8b22` | **Step A+ 1:** staff replies reach the history (labelled, idempotent, fail closed); the pinned known-gap test is flipped |
| `7e9ffc9` | **Step A+ 2:** webhook retry semantics over the direct route (13 tests, regression guards) |
| `d810455` | **Step A+ 3:** the post-signal `/stop` is a cancellation, not a dispatch (comment + 4 tests) |

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
   (the store collapses the AI and staff into one voice; the only marker is the `[A teammate replied]: ` label stored with a
   dashboard user's public reply, see Step A+), the current message is located as the LAST
   matching customer turn, removed and sent only as `input`, newer turns dropped, newest 20 turns / 8000 characters, oldest
   dropped first. No transcript, or one that does not contain the current message = no request and an escalation.
8. **The envelope:** the model's output must END with one JSON line `{"disposition":"answer"|"request_human","text","reason"}`.
   Only that `text` is ever sent (<= 2000 UTF-16 units, refused above, never truncated); a `reason` is kept only if it is in the
   closed set. `hermes_envelope_parse_failure` (stable event name) and `stats()` expose the parse-failure rate.

## Deviations and choices that need a reviewer

- **A best-effort `/stop` is sent AFTER the turn signal fires. ACCEPTED by Lane A as a CANCELLATION, NOT a DISPATCH.**
  `AgentRuntimeRequest.signal` says a runtime must start no request once it fires; this adapter starts no create, poll or stream
  after it but does send exactly ONE `POST /v1/runs/{id}/stop` for the run this turn created (a cancellation removes work; Step B
  measured that `/stop` halts model execution). It is sent once, never retried, and its failure (HTTP 500, 404 "maybe finished",
  a transport error) changes nothing: the run id stays remembered as cancelled and its output is never used. The exception is
  written into the `signal` doc comment in `src/runtime.ts` and pinned by `test/direct-hermes-post-signal.test.ts`: after the
  signal the request log gains exactly that one stop and nothing else; an already-aborted signal sends nothing, not even a stop.
  The route-level proof that no customer write follows a takeover is in `test/direct-hermes-route.test.ts`. Those tests pass on
  the code as built (regression guards): a second stop (3 red), no stop (3 red) and a signal ignored by every guard (4 red) are
  caught; removing one single explicit guard, or even the three obvious ones together, is NOT caught, because the signal also
  aborts requests in flight and `spent()` is checked at several layers. The tests pin the observable property, not one guard.
- `instructions` (the envelope contract) is sent on every run; whether it appends to or competes with the charter is UNVERIFIED.
- The customer's current message is cut to 4000 UTF-16 units in `input`.
- The `request_human` envelope's `text` IS sent to the customer, then the conversation is escalated (the existing behaviour).
- The Hermes request carries NO ids from the Chatwoot context: only the label, the rendered input and the history.

## STAFF REPLIES REACH THE HISTORY (Step A+, commit `fcf8b22`; was a known gap)

A signed HUMAN-AGENT reply takes the `human_reply` decision in `app.ts`, which used to record the takeover in the ownership
ledger and return BEFORE the transcript-recording block, so after a handback the model did not see what the person told the
customer. Fixed, minimal and separately reviewable (`src/app.ts`, `src/turns.ts`, `src/pipeline.ts`):

- **Recorded before the ownership branch** (so the "ownership executor not configured" early return cannot skip it), for a real
  dashboard user's PUBLIC reply only. A private note is never recorded (`classifyTurn` drops anything not explicitly
  `private=false`); activity lines and other conversations are never in this conversation's history.
- **Label:** the stored content is `[A teammate replied]: <text>`. SOURCE: the form lane 59's Step B isolation script used
  (`.checkpoint-out/public-hermes/step_b.sh`); Step B (d) showed the model used such a line correctly. The role in
  `conversation_history` stays `assistant` (the store has one business voice); the label lives inside the content, once. The AI's
  own echoed reply and another bot's outgoing message are NOT labelled as a teammate.
- **Idempotent:** `recordTurn` is keyed on (account, Chatwoot message id) with `ON CONFLICT ... DO NOTHING`; a redelivered staff
  webhook is a no-op. The route tests pin the PRODUCTION statement text, not just the in-memory model of it.
- **Fail closed if the write fails:** the takeover acknowledgement is unaffected (still `human_reply`), an ALERT is logged
  (`human_reply_turn_not_recorded`), and the conversation is marked in memory as having a hole; the pipeline then treats its
  history as absent, which the direct path turns into "answer nothing, escalate once". **Limits, stated:** the mark is in
  memory (a durable one needs schema, not authorised), so it is lost on a gateway restart, after which the hole is invisible
  again and the alert is the only record; it is per conversation, so one failed write silences the AI in ONE conversation only,
  until the process restarts; a staff message with no text (attachment only) is not representable and is not recorded.
- The turn-store write happens BEFORE the 200 acknowledgement, as it already did for customer turns.
- Tests: `test/direct-hermes-staff-history.test.ts` (9, route-level; the handback scenario: customer, AI reply, staff reply,
  explicit handback, next customer message: the model request carries all three in order from the SAME conversation only) and the
  flipped test in `test/direct-hermes-route.test.ts`.

## Webhook retry semantics (Step A+, commit `7e9ffc9`)

Chatwoot retries an agent-bot webhook ONLY on HTTP 429 and 500 (v4.16.1). Statuses the webhook route can return today (read from
`src/app.ts`): 200 (accepted, `duplicate_suppressed`, suppressed, `human_reply`, ...), 400, 401, 405, 413, 422, 409
(`ledger_conflict`) and 500. **429 is never returned by this route** (the only 429 in `app.ts` is the separate voice route). **500
is returned in two places:** `ledger_unavailable` (the ONE intended retry case: the delivery could not be durably recorded; the
retry then runs exactly once) and the outer catch around `handleWebhook` (an unexpected exception; not reachable for a duplicate,
which takes `reserve()` -> `duplicate` -> 200 with only pure steps before it). Tests (13, route-level, direct Hermes wired):

- a redelivery of an accepted delivery (same signed body) is 200 `duplicate_suppressed`, with NO second Hermes run, NO second reply
  and no new ledger row: after completion, while still running, and after a terminal failure;
- the same delivery id with a different signed body is 409 and runs nothing;
- an unsigned, wrong, foreign-secret or stale-timestamp request is 401 with no ledger row and no Hermes call (positive control:
  the correctly signed one is accepted in the same rig);
- ledger down is 500 with no run and no row; the retry is accepted and runs once; a status table shows no 429 and 500 only there.

**Edge, found by testing and reported honestly:** a redelivery that arrives AFTER the lease expired on a delivery that never
finished is NOT a plain duplicate: `reserve()` reports `resumed`, the route answers 200 `accepted` and processes it again. It
still starts NO second Hermes run: the adapter refuses a second `POST /v1/runs` for the same ledger key
(`hermes_duplicate_invoke`), the conversation is escalated once, and the first run's late answer is discarded (ownership
changed). Net effect for the customer: no automatic answer and a human follow-up. Chatwoot itself does not retry a 200, so this
path needs a duplicate that did not come from Chatwoot's retry rule.

These tests describe behaviour that already existed, so they pass on the code as built (regression guards, not red-first); eight
sabotages of the status codes and guards (duplicate -> 500 or 429, duplicate processed, conflict -> 200 or processed,
unauthorized -> 403, ledger-down -> 503, the adapter's second-POST guard) each turn them red, and a log-only change stays green.

## Open risks and KNOWN LIMITS (the UAT demo report must show EACH of these)

1. **F2 (late-worker overlap) and F3 (late-send duplicate) from Codex rounds 3-6 apply unchanged** to this path: exclusivity is
   not provided by timing; a fenced-lease design exists as a proposal and is not authorised.
2. **Customer scope is fixture-only; there is no production resolver.** `contact_inbox` on Chatwoot 4.18 is unverified.
3. **No person is reached out-of-band.** An escalation is a private note and a log event (`recovery_escalation`); nothing pages or
   messages anyone outside Chatwoot.
4. **Hermes restart loses in-flight runs**: a 404 on the run escalates once and is never re-driven (recovery is escalation-only).
5. **The envelope's parse-failure rate is unknown** until a real run (`hermes_envelope_parse_failure` / `stats()` expose it); a
   high rate means moving to a native tool instead of envelope parsing.
6. **COLD START IS NOT TESTED BY THIS BRANCH.** Every test here runs against a socket-free fake Hermes, so no latency is measured
   at all. Lane 59 owns the cold / warm / post-idle measurement (Step B, small n: warm 2.9-3.3 s, first run after ~65 min idle
   10.2 s, the API server unresponsive for ~1 s warm / ~6 s post-idle while a run starts) against the 15 s first-answer goal.
7. **UNVERIFIED: whether the UAT gateway (`isolagwuat_gateway`) can resolve and reach `isola_hermes-public:8642`.** Known: the UAT
   gateway's egress allowlist REPLACES the derived list wholesale, so the Hermes host has to be added to it, and the UAT runtime
   (`isolagwuat_rt`) allowlist observed earlier does not contain it. Not known: whether the UAT gateway shares an overlay network
   with `isola_hermes-public` and whether the service name resolves from inside the container. Lane 59 is checking by DNS only;
   this stays UNVERIFIED until they report. Nothing in this branch proves reachability.
8. The staff-history mark for a failed write is in memory only (see above).
9. Hermes' cap of 10 runs is shared with any other client of the service.
10. The business tools are not real yet (service OFF, source gate, dead address, no minter): the assertion provider returns
    nothing by default, so the line says `none` and the tools refuse.
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
Step A 1451; after Step A+ 1477 passed / 30 skipped / 0 failed, `tsc` 0 (1460 after `fcf8b22`, 1473 after `7e9ffc9`, 1477 after
`d810455`; the 30 skipped are the real-Postgres tests). All new tests are socket-free:
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
- **Step A+:** `fcf8b22` was tests-first (the 8 behaviour tests were red against the pre-change code; the 9th pins the production
  dedupe statement and was added with the fix; sabotage: no recording 8 red, no label 3, mark never set 1, pipeline ignores the
  hole 1, private notes treated as public 1, dedupe statement changed 1; a comment-only change stays green). `7e9ffc9` and
  `d810455` are NOT red-first: they pin behaviour that already existed (see their sections). The first draft of the retry tests
  used a credential-looking literal flagged by the repository's post-edit hook and a fake that expects a specific bearer; both
  were fixed (the value is now built, and the fake is told which bearer to expect).

## PORT-READY paragraph

Direct Hermes path (Step A), branch `feat/direct-hermes-adapter-2026-10-03`: a `HermesDirectRuntime` in `services/isola-gateway`
runs a customer turn through `isola_hermes-public` with POST `/v1/runs`, no Paperclip in the loop, selected per employee and
OFF by default. Built to lane 59's Step-B-verified contract: `/v1/runs` ignores Idempotency-Key, so the adapter never POSTs twice
per ledger key; every run's stream is read to the end; on takeover, a spent turn or the deadline the run is stopped and its output
discarded; continuity is `conversation_history` from the gateway's own transcript; the model's output must end with a one-line
JSON envelope and anything else is no text plus one escalation. Step A+ added: staff replies now reach the history, labelled
`[A teammate replied]:` and idempotent (a failed write marks the conversation and the next AI turn escalates instead of answering
with a hole); the one `/stop` after the turn signal is documented and tested as a cancellation, not a dispatch; and 13 route
tests pin the webhook retry semantics (a redelivery of an accepted delivery is a 200 with no second run or reply; 409 for a
changed body; 401 with no ledger row; 500 only when the ledger is down, never 429). 1477 tests pass against a fake Hermes (no
socket); not deployed, not reviewed. Known limits for the UAT demo report: late-worker/late-send exclusivity (F2/F3), fixture-only
customer scope, no person reached out-of-band, Hermes restart loses runs (escalate, never re-drive), parse-failure rate unknown;
cold start is NOT measured by this branch (lane 59), and reachability of `isola_hermes-public:8642` from the UAT gateway is
UNVERIFIED. Sandbox only.
