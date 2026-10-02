# Branch notes: feat/pivot-gateway-thin-connector-2026-10-02

Packet ISOLA-PIVOT-20261002-01 (Lane A). Base: 8b5feb3 (the commit behind the deployed UAT gateway tag).

## Status - read first
- NOT DEPLOYED. NOT APPROVED. No PR opened. Codex review pending at head 92ddc6c.
- Branch only. Nothing here has run against a real Paperclip, a real Chatwoot or a real database. The Paperclip tests use a local stub, which proves nothing about the installed build.
- Head tested: 92ddc6c = 881 passed, 23 skipped, 0 failed, `tsc` exit 0 (run 2026-10-02T21:34Z by the coordinator).

## Commits
- deda939 - failing tests first: in-flight takeover, verified customer scope, explicit-only handback.
- e389317 - recheck ownership after the model runs, before any write. Distinct `suppressed_in_flight` outcome; fails closed if ownership cannot be re-read.
- 504dca9 - server-side customer scope, fail closed when unresolved. Its identity keying is superseded by d48de2d.
- 1e5caa4 - idle handback is OFF by default; handback is explicit-only (`GATEWAY_HANDBACK_IDLE_ENABLED=true` opts in).
  - Live-gateway effect if this code is ever deployed: `deploy/isola-gw-stack.yml` sets no `GATEWAY_HANDBACK_*` variable, so the default flips from idle handback on (10 min) to off, and a human-held conversation stays held until "Mark as pending". This is an owner decision. Config presence only: the live gateway was not read, and deployed 5317cec is not in this history.
- d48de2d - scope is keyed on `conversation.contact_inbox.source_id`, not the editable contact phone. Absent => unresolved => fail closed.
- 92ddc6c - Paperclip-governed execution seam: credential-agnostic, default OFF per binding, one execution owner, stub-tested.

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
