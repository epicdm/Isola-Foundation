# Branch notes: feat/pivot-gateway-thin-connector-2026-10-02

Packet ISOLA-PIVOT-20261002-01 (Lane A). Base: 8b5feb3 (the commit behind the deployed UAT gateway tag).

## Status - read first
- NOT DEPLOYED. NOT APPROVED. No PR opened. Codex review round 1 (head 92ddc6c) = REQUEST CHANGES; the fix round below is awaiting round 2.
- Branch only. Nothing here has run against a real Paperclip, a real Chatwoot or a real database. The Paperclip tests use a local stub, which proves nothing about the installed build.
- Head tested: 92ddc6c = 881 passed, 23 skipped, 0 failed, `tsc` exit 0 (run 2026-10-02T21:34Z by the coordinator). After the fix round: 937 passed, 23 skipped, 0 failed, `tsc` exit 0 (see the fix-round section for the head and time).
- THE ONLY FULL-SUITE EVIDENCE IS THE BUILDER'S RUNS. Codex's sandbox could not run the suite (245 EPERM loopback-listener failures), so its own runs covered targeted probes and sabotage, not the full suite. The real-PostgreSQL tests are skipped (`OWNERSHIP_PG_TESTS=skip`) in every run so far.

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
- b7c270f - D1 + D2: one absolute deadline for the whole Paperclip turn (create + polls + body reads under one AbortSignal, each request capped to the time left, a late response discarded); a timed-out create body is an UNCERTAIN create; boot refuses when `pollDeadlineMs + requestTimeoutMs` does not fit inside the ledger lease.
- 9631b39 - D4 + D7: every poll 4xx is a config defect (one request, no retry); an injected `X-Paperclip-Run-Id` is refused at the transport (nothing is sent).
- a1d3378 - D3 + D6: CHOSEN: REFUSE, not "the binding wins". Boot refuses when an enabled binding's `paperclipCompanyId` differs from `GATEWAY_PAPERCLIP_COMPANY_ID`, and the runtime refuses a turn whose context company is absent or different (defence in depth). Boot refuses a non-http(s) base URL and a base URL whose host is not in the effective egress allowlist; an egress block is a config defect, not an uncertain create.
- 0eeb4a1 - D5: ownership is re-read right after the customer scope resolves, before any escalation write and before the model is called.
- 1bd7ea1 - the two items Codex marked SUSPECTED: `contact_inbox.contact_id` is cross-checked against `sender.id` and `contact_inbox.inbox_id` against the routed inbox (a MISMATCH fails closed; an ABSENT id cannot be cross-checked and is not treated as a mismatch); the fixture resolver can be bound to one (tenant, account, inbox) and the env wiring requires it.

## Known limits (stated, not hidden)
- D8, INHERITED, NOT FIXED: a `pending` Chatwoot status snapshot is treated as proof of an explicit handback (`src/handback.ts`, the manual branch). During escalation the conversation is `pending` before Chatwoot is opened, so that snapshot can be read as a human's gesture and start a handback even with idle handback off. It predates this branch and needs "evidence of an explicit transition for the relevant episode", not a one-line change. So the "explicit-only handback" claim is limited by this.
- LOST UNCERTAINTY MARKER ON RESTART - A KNOWN, UNPROVEN RECOVERY. The `IssueStore` (issue ids, run ids AND the "uncertain create" marker) is in process memory. After a restart an uncertain create is no longer remembered and is not re-detected; recovery then rests entirely on Paperclip honouring the same `idempotencyKey` (UNVERIFIED), and the stub proves nothing about that. Sequential replay in one process is tested; restart recovery is not.
- "FAIL-CLOSED DEFAULT" FOR CUSTOMER SCOPE DOES NOT MEAN ENABLED BY DEFAULT. `GATEWAY_CUSTOMER_SCOPE_MODE` unset (or `off`) = NO resolver is consulted and behaviour is exactly what it was: there is NO scope gate. `fail_closed` and `fixture` are opt-in. With scope mode off, none of the customer-scope protection exists.
- The delivery heartbeat is not renewed by any production caller. The only protection against a handler outliving its ledger lease is the boot-time budget rule above; there is no lease renewal or fencing.
- The ownership read and the Chatwoot writes are not atomic (a documented residual window, narrowed to one network round trip).
- Truncation of the customer message is by UTF-16 code unit (`.slice(0, 4000)`); an emoji at the boundary can leave a lone surrogate. It serialises fine; code-point truncation is not done.
- The route tests for the Paperclip path inject a constructed router; only the D3 test goes through the real `createGateway` assembly.
- Codex observed that the repository tests mostly assert `bootErrors()` return values rather than launching the process to prove `process.exit(1)`; the exit mechanism itself was confirmed by Codex with isolated launches.

## What the employee receives (do not widen)
Issue title and description carry correlation ids (account, inbox, conversation, message, delivery), the server-resolved customerId and serviceIds, and the current customer message text truncated to 4,000 characters. Nothing else leaves the gateway.
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
- Whether Chatwoot 4.18 sends `contact_inbox` on `message_created`. If it does not, every public sender escalates to a human.

## NOT built
- The assertion minter.
- A production customer-scope resolver. bff-v2 has no phone-keyed internal lookup route, so this needs a new bff-v2 route or pl-concierge-side resolution. That is an owner / Lane A choice and a Law 22 stop-and-ask. A fail-closed default and a fixture resolver ship instead.
- Prior-turn history in the issue text.

## Run the tests
From `services/isola-gateway`:

    OWNERSHIP_PG_TESTS=skip npx vitest run
    npx tsc --noEmit

Without the skip flag, `test/ownership-store.pg.test.ts` refuses to run without a database.
