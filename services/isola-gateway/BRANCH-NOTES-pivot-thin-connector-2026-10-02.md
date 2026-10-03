# Branch notes: feat/pivot-gateway-thin-connector-2026-10-02

Packet ISOLA-PIVOT-20261002-01 (Lane A). Base: 8b5feb3 (the commit behind the deployed UAT gateway tag).

## Status - read first
- NOT DEPLOYED. NOT APPROVED. No PR opened. Codex review round 1 (head 92ddc6c) = REQUEST CHANGES; round 2 (head 9799a84) = REQUEST CHANGES (R1-R6); the round-2 fix round below is awaiting round 3.
- Branch only. Nothing here has run against a real Paperclip, a real Chatwoot or a real database. The Paperclip tests use a local stub / an injected fetch, which proves nothing about the installed build.
- Code head tested after the round-2 fix round: 56c5a96 = 1019 passed, 23 skipped, 0 failed, `tsc` exit 0 (run 2026-10-03 by the builder; the docs commit that follows changes no code). Earlier heads: 92ddc6c = 881, 9799a84 = 937.
- THE ONLY FULL-SUITE EVIDENCE IS THE BUILDER'S RUNS. Codex's sandbox could not run the suite (round 1: 245, round 2: 280 EPERM loopback-listener failures), so its own runs covered targeted probes and sabotage, not the full suite. The real-PostgreSQL tests are skipped (`OWNERSHIP_PG_TESTS=skip`) in every run so far.
- SOCKET-FREE TESTS (they need no loopback listener, so a sandbox that cannot bind one can run them): every file added in round 2 - `pivot-codex2-egress-redirect-userinfo`, `pivot-codex2-deadline-bytes-truncation`, `pivot-codex2-ownership-fence`, `pivot-codex2-turn-budget-lease`, `pivot-codex2-contact-inbox-required` - use an injected fetch / the gateway's own fakes. The round-1 files (`pivot-codex-*`) and `paperclip-runtime` / `paperclip-route` still bind a stub server and were not rewritten.

## Commits
- deda939 - failing tests first: in-flight takeover, verified customer scope, explicit-only handback.
- e389317 - recheck ownership after the model runs, before any write. Distinct `suppressed_in_flight` outcome; fails closed if ownership cannot be re-read.
- 504dca9 - server-side customer scope, fail closed when unresolved. Its identity keying is superseded by d48de2d.
- 1e5caa4 - idle handback is OFF by default; handback is explicit-only (`GATEWAY_HANDBACK_IDLE_ENABLED=true` opts in).
  - Live-gateway effect if this code is ever deployed: `deploy/isola-gw-stack.yml` sets no `GATEWAY_HANDBACK_*` variable, so the default flips from idle handback on (10 min) to off, and a human-held conversation stays held until "Mark as pending". This is an owner decision. Config presence only: the live gateway was not read, and deployed 5317cec is not in this history.
- d48de2d - scope is keyed on `conversation.contact_inbox.source_id`, not the editable contact phone. Absent => unresolved => fail closed.
- 92ddc6c - Paperclip-governed execution seam: credential-agnostic, default OFF per binding, one execution owner, stub-tested.

## Codex round 1 fix round (REQUEST CHANGES at 92ddc6c -> fixes D1-D7 + extras)
Each fix was written tests-first (red for the stated reason, with a positive control), then sabotaged (fix reverted, the same tests go red, restore hash-identical).
- b7c270f - D1 + D2: one absolute deadline for the whole Paperclip turn; a timed-out create body is an UNCERTAIN create.
- 9631b39 - D4 + D7: every poll 4xx is a config defect (one request, no retry); an injected `X-Paperclip-Run-Id` is refused at the transport.
- a1d3378 - D3 + D6: CHOSEN: REFUSE, not "the binding wins" (boot refuses a binding whose `paperclipCompanyId` differs from `GATEWAY_PAPERCLIP_COMPANY_ID`; the runtime refuses a turn for another company). Boot refuses a non-http(s) base URL and one whose host is not in the effective egress allowlist.
- 0eeb4a1 - D5: ownership re-read right after the customer scope resolves.
- 1bd7ea1 - `contact_inbox.contact_id` / `inbox_id` cross-checked (mismatch fails closed); the fixture resolver can be bound to one (tenant, account, inbox) and the env wiring requires it.

## Codex round 2 fix round (REQUEST CHANGES at 9799a84 -> R1-R6 + the contact_inbox item)
Same discipline: tests first (red for the stated reason, positive control), sabotage per fix, plain pushes. D3, D4 and D7 were confirmed FIXED by Codex.
- dbec03c - R1 (P1): redirects bypassed the egress allowlist. The guard now owns the redirect mode (`manual`) and refuses ANY 3xx (and an opaque redirect) as an egress block: never followed, the body never re-sent, status only in the message (the `Location` is never printed). R5 (P2): `https://user:pass@host` is refused at boot (never echoing the userinfo), and the runtime classifies it as a config defect with nothing sent, not an uncertain create.
- c4dff35 - R4 (P2): the ownership read and the takeover cancel are under the SAME absolute turn deadline (a cancel gets the remaining budget, not a fresh request timeout, and is skipped when none is left: takeover safety never rests on the cancel); every Paperclip response body is read as a stream under the abort signal with a 1 MiB cap (a declared length over the cap is refused before a byte is read; an oversized create is an UNCERTAIN create, an oversized poll page a config defect after one request). R6 (P3): the customer message is cut at 4000 UTF-16 units but never between the halves of a surrogate pair.
- 601fbfc - R3 (P2, blocking): ownership is re-read immediately BEFORE the runtime call and immediately before EACH write (after the ledger claim and any reconciliation, right before the wire): reply, private note, status change, assignment, labels, attributes, acknowledgement. While the AI has the conversation the question is "still AI-authorised, same episode"; once this delivery has recorded its own human hold it is "still our unanswered hold" (same episode, still HUMAN_REQUESTED), so a person who replied or took the conversation stops the remaining writes and an assignment cannot overwrite them. A hold that finds a person already there writes nothing. The fence latches (after one denial the delivery writes nothing more). The no-text handoff path is fenced too.
- 7671042 - R2 (P1, blocking): one hard TURN BUDGET per delivery (design below).
- 56c5a96 - the `contact_inbox` item: with customer scope on, an ABSENT comparison id is unresolved (fail closed), not a pass. DECISION: require the ids (preferred over documenting the limit). If Chatwoot does not send these nodes, every sender escalates to a person: loud, not wrong. This is still controlled-fixture evidence, not production identity: HMAC proves a payload's origin and integrity, not the upstream provenance of each field.

### R2 design: the turn budget (option ii; why not heartbeat renewal)
- `GATEWAY_TURN_BUDGET_MS` (default: the ledger lease minus `TURN_LEASE_MARGIN_MS` = 30 s). Boot REFUSES unless `budget + margin <= lease` and the runtime timeout, the Chatwoot timeout and (when enabled) Paperclip's deadline and request timeout are each inside the budget. Codex's accepted configuration (lease 90000, runtime 80000, Chatwoot 600000) now fails to boot.
- Enforcement, measured from when the turn started: every Chatwoot request, body read included, is aborted at the turn deadline and is never sent once the budget is spent; the runtime call and the ownership read are raced against it; the write fence (asked before every wire write) refuses at/after it; the hold is not recorded after it; and the delivery row is NOT completed after it (a late completion is rejected, the row stays open).
- Why it is safe: the recovery sweeper takes a delivery only AFTER its lease has expired, and the lease outlives the budget by the margin (which covers the database-stamped lease, whole-second rounding, the reserve round trip and clock skew), so worker A performs no write and no completion at any time worker B may be active.
- Why not heartbeat renewal + completion fencing on a lease token: it would let a turn outlive its lease, which needs a lease-token column and a fenced `complete()` (a schema change); the budget needs neither and makes the property checkable at boot. The cost is that a turn which needs longer than the budget fails closed to a retry.
- Remaining limits: the guarantee is only as good as the clock margin (a write that was already on the wire when the deadline passed can still commit; it is reconciled by delivery reference when B resumes); the delivery heartbeat is still not renewed by any production caller (by design, see above); the real-Postgres lease behaviour is NOT exercised (the FakeLedger models it).

## Known limits (stated, not hidden)
- D8, INHERITED, NOT FIXED: a `pending` Chatwoot status snapshot is treated as proof of an explicit handback (`src/handback.ts`, the manual branch). During escalation the conversation is `pending` before Chatwoot is opened, so that snapshot can be read as a human's gesture and start a handback even with idle handback off. It predates this branch and needs "evidence of an explicit transition for the relevant episode", not a one-line change. So the "explicit-only handback" claim is limited by this.
- LOST UNCERTAINTY MARKER ON RESTART - A KNOWN, UNPROVEN RECOVERY. The `IssueStore` (issue ids, run ids AND the "uncertain create" marker) is in process memory. After a restart an uncertain create is no longer remembered and is not re-detected; recovery then rests entirely on Paperclip honouring the same `idempotencyKey` (UNVERIFIED), and the stub proves nothing about that. Sequential replay in one process is tested; restart recovery is not.
- "FAIL-CLOSED DEFAULT" FOR CUSTOMER SCOPE DOES NOT MEAN ENABLED BY DEFAULT. `GATEWAY_CUSTOMER_SCOPE_MODE` unset (or `off`) = NO resolver is consulted and behaviour is exactly what it was: there is NO scope gate. `fail_closed` and `fixture` are opt-in. With scope mode off, none of the customer-scope protection exists.
- OWNERSHIP IS NOT ATOMIC WITH THE WRITES, AND THE WINDOW IS NOT "ONE ROUND TRIP" (this corrects the earlier note). A reply plus its annotations is up to five HTTP operations and an escalation up to seven; a single ownership read goes stale across them, and this branch used to rely on one. After the R3 fix the fence is asked immediately before each write, so a takeover is caught at the next write boundary. What no re-read can remove is the final read-to-send interval of the ONE write already in flight (a reply that was already being posted when a person took the conversation still lands). The ownership read and the Chatwoot write are separate operations, not a compare-and-set.
- The ledger-claim row of a write the fence denies is released with `ledger.fail(.., "fenced")` on a best-effort basis; if that release fails the claim stays and the delivery is closed or left open as described above.
- The route tests for the Paperclip path inject a constructed router; only the D3 test goes through the real `createGateway` assembly.
- Codex observed that the repository tests mostly assert `bootErrors()` return values rather than launching the process to prove `process.exit(1)`; the exit mechanism itself was confirmed by Codex with isolated launches.
- Redirects are refused for EVERY outbound call through the egress guard, including Chatwoot and the runtime. A deployment that depended on a redirect (an http->https upgrade, a moved host) will now fail closed with an egress block. None was found in this repository.
- The egress allowlist is hostnames only, not ports.

## What the employee receives (do not widen)
Issue title and description carry correlation ids (account, inbox, conversation, message, delivery), the server-resolved customerId and serviceIds, and the current customer message text truncated to 4,000 UTF-16 units (never inside a surrogate pair). Nothing else leaves the gateway.
- Storing customer message text in a Paperclip issue is a data-store and retention decision for the owner / Senior PM before ANY real customer traffic. Sandbox / test conversations only until then.

## Warnings
- The `IssueStore` is in memory. A restart forgets issue ids. The sandbox slice must NOT be used with real runs across restarts until the draft migration (`drafts/0002_delivery_ledger_paperclip_ids.DRAFT.sql`) is reviewed and separately authorised. The draft is not applied anywhere and nothing reads it.
- No `prisma db push`, no `_prisma_migrations` edits.

## UNVERIFIED
- Installed Paperclip route prefix and the create / comments response shapes.
- `authorAgentId` on comments.
- Replay by the same `idempotencyKey` returning the original issue.
- Whether the run id is discoverable from the issue.
- Whether cancel reaches Hermes mid-run.
- Whether Chatwoot 4.18 sends `contact_inbox` (with `contact_id` and `inbox_id`) on `message_created`. If it does not, every public sender escalates to a human.
- Real PostgreSQL behaviour of the lease and the ownership store under the new fences (the in-memory doubles model it).

## NOT built
- The assertion minter.
- A production customer-scope resolver. bff-v2 has no phone-keyed internal lookup route, so this needs a new bff-v2 route or pl-concierge-side resolution. That is an owner / Lane A choice and a Law 22 stop-and-ask. A fail-closed default and a fixture resolver ship instead.
- Prior-turn history in the issue text.

## Run the tests
From `services/isola-gateway`:

    OWNERSHIP_PG_TESTS=skip npx vitest run
    npx tsc --noEmit

Without the skip flag, `test/ownership-store.pg.test.ts` refuses to run without a database.
