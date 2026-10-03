# Branch notes: the DIRECT Hermes path (Step A)

Branch `feat/direct-hermes-adapter-2026-10-03`, cut from `c577eed` (the reviewed pivot branch head). The pivot branch
`feat/pivot-gateway-thin-connector-2026-10-02` is untouched. **Status: built and tested against a fake Hermes. NOT deployed,
NOT approved, no PR. Codex reviewed `d810455` (REQUEST CHANGES: DH1-DH9); the Codex-DH round below answers it and is itself NOT yet
re-reviewed.** Owner-approved priority change (2026-10-03): customer conversations run
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
| `b512f7d` | **Codex DH3 + DH8:** the current message is found by its Chatwoot message id; the transcript fake evaluates the production WHERE |
| `06d4478` | **Codex DH1:** a durable `model_run` ledger marker is claimed before the POST (survives a restart / a second instance) |
| `b6a910a` | **Codex DH2 + DH5:** the answer is accepted only AFTER the stream is drained; an abnormal end of the stream is never an answer |
| `5bb1afd` | **Codex DH4:** an undrained run keeps its local slot until the service's own sweep |
| `f9ed1af` | **Codex DH6 + DH7:** forged marker lines in customer text are quoted; the envelope text is sanitised |
| `d52f61c` | **Codex DH9:** the staff-transcript write is bounded (2 s), so a blocked store cannot delay the takeover |
| `bd5b8f5` | the runtime header states what each rule does and does not promise (comment-only) |

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

## Rules the adapter enforces (each has tests and a sabotage), and what each does NOT promise

The first version of this section over-claimed in six places (Codex DH round). What is true now:

1. **One `POST /v1/runs` per ledger key, with exactly one exception.** A 429 on the create is retried ONCE with the identical body
   (the service refused the first, so no run exists); that is the only repeat. The service cannot dedupe (`Idempotency-Key` is
   ignored, and not sent), so the guard is ours, in three layers: the ledger's delivery de-duplication (a redelivery of an accepted
   delivery never reaches the adapter); a **durable `model_run` marker** the pipeline claims through the ledger immediately BEFORE
   the POST (an ordinary action row, `action_type` is free text, no schema change; it survives a restart and a second instance:
   `AgentRuntimeRequest.claimDispatch`, Codex DH1); and an in-memory set (this process only, capped at 10,000). A redelivery of a
   delivery whose marker is claimed escalates WITHOUT contacting Hermes (`hermes_duplicate_invoke`); a ledger that cannot record the
   claim sends nothing (`hermes_dispatch_unrecorded`); the production wiring REQUIRES the claim. **Residual:** a crash after the
   marker and before the POST means that turn is escalated and never retried.
2. **Event streams.** A stream is read to the end WHEN IT ENDS NORMALLY. If the connection breaks mid-way, polling may still
   answer, but the service keeps counting that run until its own 300 s sweep, so the adapter keeps its LOCAL slot for what is left
   of `remoteSweepMs` (default 300000, measured from the run''s creation; `inflight()` tells the truth and a turn that cannot get a
   slot is `hermes_busy`, no request sent; Codex DH4). A stream that ended normally (EOF) WITHOUT a terminal event is
   `hermes_stream_closed_early` whatever a poll says; an events route that answers 404 is `hermes_run_lost`, another 4xx a config
   defect (Codex DH5). A 5xx on the events route or a transport break still lets polling answer (unchanged policy). The "remote
   count" is modelled by the fake; the installed service''s behaviour is only as verified in Step B (consumed streams).
3. **Takeover, spent turn or deadline: `POST /stop`, and the run id is remembered as cancelled**; output of a cancelled run, or of
   a run this turn did not create, is never used; a 404 on `/stop` means "maybe finished": the output is still discarded.
   **Ownership** is looked at before each poll and once more in `finalize()`, AFTER the stream has been drained and together with
   the signal and the absolute deadline (Codex DH2: the acceptance decision used to be taken BEFORE the drain). A takeover landing
   after that last look is caught only by the pipeline''s own recheck and write fence: a residual window, not zero.
4. **Deadlines.** The create, every poll, the event stream and the final drain run under the turn''s absolute deadline (the drain
   is bounded by `min(deadline, now + grace)` and is aborted by the turn signal); a response body is capped at 1 MiB; a redirect is
   a config defect; 4xx is a config defect with no retry; a 5xx or a dropped connection on the create is an uncertain create,
   never re-created. **Not** under that deadline: the best-effort `/stop` (its own short timeout: the request timeout, 3 s once
   the signal has fired). There is no single deadline over "everything".
5. **Fail closed, no model text:** failed / cancelled / 404 / a stream closed without a terminal event / no or bad envelope / no
   history / a missing or non-matching current message / no durable dispatch claim = one outcome and an escalation through the
   existing path.
6. **One run per conversation at a time; a global cap below Hermes'' 10.** A wait that outlasts the deadline is `hermes_busy` and
   nothing is sent.
7. **Continuity** is the gateway''s own transcript for the SAME conversation: customer -> `user`, every business turn -> `assistant`
   (the store collapses the AI and staff into one voice; the only marker is the `[A teammate replied]: ` label stored with a
   dashboard user''s public reply, see Step A+). **The current message is found by its Chatwoot MESSAGE ID** (Codex DH3), carried
   through the transcript read beside the turns (`TurnHistory.messageIds` -> `AgentRuntimeRequest.historyMessageIds`; it is NOT
   inside `context.history`, so the isola-runtime payload is unchanged); equal text is not identity, and a missing current row,
   a missing id or ids that do not line up with the turns is a refusal (`hermes_history_unavailable`), no request. Newer turns are
   dropped, newest 20 turns / 8000 characters, oldest dropped first. **"No partial history" is NOT promised:** the transcript
   can have gaps the gateway cannot see (a staff turn whose write failed is marked, but the mark is IN MEMORY: **after a gateway
   restart the first AI turn on a conversation that has a gap in its transcript cannot be proved**, and a gap in an AI or staff
   turn recorded before the restart is invisible). Customer text is quoted wherever a line would start with `Conversation id:`,
   `Isola assertion:` or `[A teammate replied]:` (Codex DH6); the cryptographic assertion check in the service stays the
   authorization boundary.
8. **The envelope:** the model''s output must END with one JSON line `{"disposition":"answer"|"request_human","text","reason"}`.
   Only that `text` is ever sent (<= 2000 UTF-16 units AFTER sanitising, refused above, never truncated); it is sanitised first
   (NUL and other C0 controls except tab/newline, DEL, C1 controls, bidi overrides/isolates/marks, the Arabic letter mark and a BOM
   removed; CR, U+2028, U+2029 become a newline; Codex DH7). A `reason` is kept only if it is in the closed set.
   `hermes_envelope_parse_failure` (stable event name) and `stats()` expose the parse-failure rate.
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
- The staff turn-store write happens BEFORE the 200 acknowledgement and the takeover, but is now BOUNDED (Codex DH9):
  `STAFF_TURN_RECORD_TIMEOUT_MS` = 2 s (under Chatwoot's 5 s delivery timeout). A write that has not finished by then is treated
  as NOT recorded (alert `human_reply_turn_not_recorded` with a "timed out" detail, the hole is marked, the acknowledgement is
  sent and the takeover starts); the abandoned write may still settle later and changes nothing. **Not bounded (outside Codex's
  list, disclosed):** the CUSTOMER-turn write in the accept/suppressed block is still awaited without a bound.
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
8. The staff-history mark for a failed write is in memory only (see above): **after a gateway restart the first AI turn on any
   conversation with a gap in the transcript cannot be proved.**
8a. **Durable dispatch residual (DH1):** a crash between the `model_run` claim and the POST escalates that turn and never retries it.
    The in-memory guard and the cancelled-ids set are forgotten on restart; the marker is not.
8b. **Remote slot accounting (DH4)** is modelled by the fake and by the Step B facts for CONSUMED streams. How the installed
    service counts an abandoned stream is UNVERIFIED; the adapter assumes the documented 300 s sweep.
8c. **Remaining Codex rounds' findings that this slice does not address:** F2 / F3 (above), D8, the unbounded customer-turn write
    (above), the CRLF-delimited SSE blank line (the supplied contract uses LF), attachment-only staff replies (not representable).
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
`d810455`); after the Codex DH round **1549 passed / 30 skipped / 0 failed, `tsc` 0** (1492 after `b512f7d`, 1505 after `06d4478`,
1521 after `b6a910a`, 1526 after `5bb1afd`, 1542 after `f9ed1af`, 1549 after `d52f61c`; the comment-only `bd5b8f5` changes nothing).
The 30 skipped are the real-Postgres tests, NOT run. **These runs are the only full-suite evidence:** Codex's sandbox cannot open
loopback listeners (280 EPERM) and could not run the suite. The new DH test files are all socket-free (injected fetch / the
gateway handler driven in-process): `direct-hermes-dh3-dh8-history`, `-dh1-durable-dispatch`, `-dh2-dh5-drain`,
`-dh4-slot-accounting`, `-dh6-dh7-text`, `-dh9-stalled-staff-record`. All new tests are socket-free:
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
- **Codex DH round (all red first unless stated):** DH3/DH8 15 tests (10 red), DH1 12 (8 red), DH2/DH5 16 (9 red), DH4 5 (3 red),
  DH6/DH7 16 (15 red), DH9 7 (4 red). **DH8 is a test defect, so its "red" is by sabotage reproduction:** with the pre-fix
  self-filtering fake a widened production WHERE leaves 155 tests green (0 red); with the new fake the same widening turns 22 red.
  **Existing tests changed, with reasons:** the older history tests (the unit tests of the history builder and the runtime tests' request helper) were migrated to identify
  the current message by id through a test wrapper / helper that numbers the turns (the old tests asserted text matching; the DH3
  behaviour itself is pinned by `direct-hermes-dh3-dh8-history.test.ts`, which calls the builder directly); the route test that listed the closed ledger rows now expects the
  `model_run` marker too; one concurrency test that asserted an undrained stream releases the adapter's slot at once now asserts the
  slot is held for the sweep window (DH4). **Two checks removed because their sabotage was equivalent** (a duplicate early signal
  /deadline check in `finalize()`, and a redundant `.catch` on the abandoned staff write): the surviving check is the one the
  tests pin. **A test-writing hazard, fixed:** the file-writing tool unescaped `\uXXXX` sequences in one test file (the regex
  literal broke); the file was regenerated with explicit escapes.
- **Step A+:** `fcf8b22` was tests-first (the 8 behaviour tests were red against the pre-change code; the 9th pins the production
  dedupe statement and was added with the fix; sabotage: no recording 8 red, no label 3, mark never set 1, pipeline ignores the
  hole 1, private notes treated as public 1, dedupe statement changed 1; a comment-only change stays green). `7e9ffc9` and
  `d810455` are NOT red-first: they pin behaviour that already existed (see their sections). The first draft of the retry tests
  used a credential-looking literal flagged by the repository's post-edit hook and a fake that expects a specific bearer; both
  were fixed (the value is now built, and the fake is told which bearer to expect).

## PORT-READY paragraph (refreshed for the Codex DH round)

Direct Hermes path, branch `feat/direct-hermes-adapter-2026-10-03`: a `HermesDirectRuntime` in `services/isola-gateway` runs a
customer turn through `isola_hermes-public` with POST `/v1/runs`, no Paperclip in the loop, selected per employee, OFF by default.
Codex reviewed `d810455` (REQUEST CHANGES, nine findings); all nine are addressed on the branch: a durable `model_run` ledger
marker is claimed before the POST so a restart or a second instance cannot start a second run (a crash between claim and POST
escalates that turn); the current message is found by Chatwoot message id, never by text; the answer is accepted only after the
event stream is drained, and an abnormal end of the stream (EOF without a terminal event, events 404) is never an answer; an
undrained run keeps its local slot until the service's own sweep; customer text cannot forge the trusted marker lines and the
envelope text is sanitised; the staff-transcript write is bounded so a blocked store cannot delay a takeover. 1549 tests pass
against a fake Hermes (no socket), `tsc` clean; not deployed, not re-reviewed after this round. Known limits for the UAT report:
late-worker/late-send exclusivity (F2/F3), fixture-only customer scope, no person reached out-of-band, Hermes restart loses runs
(escalate, never re-drive), after a gateway restart a conversation with a transcript gap cannot be proved on its first AI turn,
parse-failure rate unknown, cold start NOT measured by this branch (lane 59), reachability of `isola_hermes-public:8642` from the UAT
gateway UNVERIFIED. Sandbox only.