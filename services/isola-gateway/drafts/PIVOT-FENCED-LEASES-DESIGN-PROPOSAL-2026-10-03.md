# Fenced leases for services/isola-gateway: design proposal (DRAFT, not applied)

Stamp: 2026-10-03T01:03:57Z. Author: design fork (read-only). Packet ISOLA-PIVOT-20261002-01, answering Codex round 3 (head 1eb7ba3) findings F2 and F3 and Lane A's "stop stacking timing patches".
Labels: CODE-ONLY = read in the worktree at 1eb7ba3 (services/isola-gateway); SOURCE = named origin; UNVERIFIED = not observed. Nothing here was run, applied or deployed. No database, Chatwoot, Paperclip or host was contacted.

## 0. Answer first (question 4)

**F3 (late commit of a pending upstream send) is NOT fully fixable without an upstream idempotency key or proof that the earlier request is dead.** Chatwoot's application API offers no client-supplied idempotency key on message create (SOURCE: Chatwoot swagger, Context7 `/openapi/raw_githubusercontent_chatwoot_chatwoot_develop_swagger_tag_groups_application_swagger_json`: request body has content, message_type, private, content_type, content_attributes, campaign_id, template_params; no echo_id/source_id/idempotency field). `source_id` is indexed but not unique (CODE-ONLY: writes.ts header, citing deployed v4.16.1 `db/schema.rb`; installed 4.18 not re-checked: UNVERIFIED). What CAN be done: (a) a database fence so a stale worker can never durably mutate or complete (fully fixable, F2); (b) a durable send-intent plus a wait bound plus an **at-most-once-after-ambiguity** policy, which turns F3 from "two customer messages" into "zero automatic resend; a person is asked". Residual duplicate window under (b) with strict at-most-once: **none from our code** (we never resend after an aborted/fenced send); the cost is some replies become human escalations. If the owner wants automatic resend instead (at-least-once), the residual window is the longest time an upstream request can stay pending after we abort it: unknown (a reverse proxy default of 60 s is typical but UNVERIFIED for this deployment), and not bounded by anything this service controls.

## 1. Invariant

At any instant, at most one worker may durably mutate a delivery's ledger state; a stale worker's durable write, action claim, completion or failure is **rejected by the database**, not by a timer. Timers (the turn budget) stay as containment, but no safety claim rests on them.

Out of scope for the database: an HTTP request already on the wire to Chatwoot/Paperclip (section 4 explains the honest limit).

## 2. The fence (F2, F4)

### 2.1 Token
Use what already exists: `delivery_ledger.attempts` on the `action_type = 'delivery'` row. CODE-ONLY: `reserve()` does `attempts = delivery_ledger.attempts + 1` on every takeover (ledger.ts ~449) and nothing else increments it on that row. It is already a monotonic per-delivery counter. The fence is the value returned to the worker by `reserve()` (`{kind:'reserved'|'resumed', attempts}`), carried in the turn context.

Rationale: no new column is needed for the token itself, so the fence is additive-free for the delivery row and cannot disagree with `lease_owner` (an instance id string: two workers in one process share it, which is why the owner string is not the fence).

CORRECTION (Codex round 4): `attempts` is a viable generation token only for the lifetime of a RETAINED row. If a delivery row is ever deleted and reinserted, `attempts` restarts at 1 and a stale worker holding "1" would pass the predicate. The design therefore needs an explicit invariant that delivery rows are never deleted and reinserted under the same key (retention rule), or a separate incarnation identifier. Every other path that touches the row (reopen, heartbeat, any administrative mutation) must preserve the generation semantics.

### 2.2 Predicate on every durable write
Define `FENCE_OK(identity, fence)` = the delivery row for the same (tenant, binding, account, inbox, event_id, `'delivery'`) still has `attempts = $fence` and `delivery_state IN ('reserved','in_progress')`.

- `complete(delivery)` / `fail(delivery)` / `heartbeat(delivery)`: single-row update `WHERE KEY_PREDICATE AND attempts = $fence AND delivery_state IN ('reserved','in_progress')`. PostgreSQL re-evaluates a single-row predicate after a lock wait under READ COMMITTED, so this is race-free (UNVERIFIED on the real server; test in 7.2).
- `claimAction`, action `complete`/`fail`/new `release`: the action rows are *different* rows from the delivery row, so a subselect `EXISTS(...)` is **not** race-free under READ COMMITTED (the subquery is not re-evaluated after a concurrent takeover commits). Therefore run them in `SqlExecutor.transaction()` (already present) as: `SELECT 1 FROM delivery_ledger WHERE <delivery key> AND attempts = $fence AND delivery_state IN (...) FOR SHARE`; zero rows => abort with no side effect; else perform the action-row statement; COMMIT. `FOR SHARE` conflicts with the `UPDATE` in a takeover, so B's `reserve()` takeover waits for A's short transaction, and every A write after B's commit fails the predicate. CODE-ONLY design; the lock-mode argument is standard PostgreSQL behaviour but UNVERIFIED here until the real-Postgres test passes.
- Zero rows (stale): the worker records `fenced_out` in the log (no content), performs no further write of any kind (no `fail()`: B owns the row), and returns. This is a normal outcome, not an error page.

CORRECTIONS (Codex round 4):
- `FOR SHARE` is sufficient ONLY inside ONE SQL transaction: the validation SELECT and the dependent mutation must run in the same transaction and the lock must be retained through COMMIT. It protects nothing after the commit: in particular it gives no protection to an HTTP send that follows (see section 4).
- The predicate above checks the generation (`attempts`) and state, NOT the lease expiry. That fences a worker AFTER a takeover; it does not stop a worker whose lease has already expired from mutating BEFORE any takeover. If the intended invariant is "no durable write after the lease expired", the predicate must ALSO require `lease_expires_at > now()`. The invariant must be stated explicitly and the predicate must match it.

### 2.3 F4 (fence "release" is terminal): what the fence needs
`ledger.fail(..., 'fenced')` is terminal and `claimAction()` reports a failed row as completed (ledger.ts ~559), so a fenced-but-unsent reply is silently skipped. Add `release(identity, action, fence)`: on the action row set `lease_expires_at = now()`, keep `delivery_state = 'in_progress'`, record `failure_code = 'released'`. The next claimant then gets `ambiguous` and takes the existing reconciliation path (prove absence by delivery reference, then send), never "completed". This is the smallest change that makes an unsent claim retryable without inventing a new state. (The code-fix fork is fixing F4 now as a code defect; this section only fixes the contract the fence must keep.)

### 2.4 Other durable writers
- Ownership table: transitions are already compare-and-set on `expectedEpisode` (CODE-ONLY: ownership-store.ts). F5 (pass and enforce the expected episode in `requestHuman`) is the matching fix; no DDL. The delivery fence does not replace the episode CAS; they compose. CORRECTION (Codex round 4): the reverse is also true: an ownership-episode check CANNOT stand in for the delivery fence, because two delivery generations (A and its successor B) can share one ownership episode, so an episode CAS lets a stale A through. Ownership transitions and the handover-acknowledgement claim therefore need the delivery fence too. (Round 4 also found the episode precondition was checked AFTER the replay lookup, G4-2; fixed on the branch: it is now checked first.)
- Recovery (recovery.ts ~356 closes after its deadline): the sweeper must hold the fence returned by its own `reserve()`; its `complete()` is fenced like any other.
- Paperclip create: its own `idempotencyKey` replay (schema text only, UNVERIFIED by behaviour) is the analogue of the reference mechanism; the fence stops a stale worker recording an issue id on a row it no longer owns.

## 3. Chatwoot idempotency/reconciliation key (what exists, what does not)

CODE-ONLY: the gateway already stamps a deterministic opaque `delivery_ref` into `content_attributes` and reconciles by reading `conversations#show` (AgentBot tokens cannot list messages; chatwoot.ts ~483-509). That detects an already-visible message. It cannot detect a request still pending upstream. No Chatwoot-side mechanism closes that (section 0). Not recommended: patching/forking Chatwoot to add a unique constraint (a fork of an upstream engine; out of scope and against the estate's reuse rule).

Durable send-intent (new, small): when an action row is claimed, `updated_at` already records "claimed at" (CODE-ONLY: default `now()` on insert). Treat `claimed_at + T_wait` as the earliest instant a successor may conclude "absent". Add `claimed_fence` (section 5) so the successor knows which fence started the send.

`T_wait` = our Chatwoot request timeout + the longest time an upstream request can remain pending after we abort. The second term is UNVERIFIED (reverse proxy `proxy_read_timeout`, Rails/Puma timeouts, queue depth); measure it before any number is committed. A placeholder of request timeout + 60 s is a starting assumption, not a finding.

## 4. Policy for an ambiguous or fenced send

1. Worker A claims the reply action (fenced), records intent, sends. If A is fenced out or its deadline passes mid-send, A abandons without `fail()`.
2. Successor B resumes the delivery, claims the action, sees `ambiguous`.
3. B waits until `claimed_at + T_wait` has elapsed (it can park the delivery with a short lease and let the sweeper pick it up again; no busy waiting).
4. B reads `conversations#show`:
   - ref visible => adopt that message id, mark complete (no send).
   - ref absent => **strict at-most-once (recommended): do NOT resend; escalate to a person** through the existing escalation path, ledger outcome `send_unconfirmed`. A human sees the thread and answers once.
   - alternative at-least-once (owner option): resend. Residual duplicate window = A's request still pending after `T_wait` (unbounded in principle).
5. Customer-facing preference: a duplicated sentence is mildly annoying; silence is worse; a human takeover on an unconfirmed send is the fail-closed answer (Law 12) and costs little at current volume. Recommend strict at-most-once for any binding with the Paperclip seam on, and the owner decides for others.

Honest limit if the owner does not authorise the schema change: there is NO operational setting that removes the second worker. DELETED CLAIM (Codex round 4): an earlier version of this paragraph said running one gateway replica and one sweeper removes B except across a restart. That is false for this implementation. One gateway plus one sweeper still permits a live handler and a recovery handler to overlap after the lease expires: the sweeper's local `running` flag serialises sweeps, not webhook processing. The only protection that holds is to keep the Paperclip seam OFF and to run no production traffic through this branch.

CORRECTIONS to the send-intent design (Codex round 4): (a) a bare wait interval proves nothing without a DURABLE, EXCLUSIVE send-intent that every worker and every restart sees; (b) `updated_at` is mutable (heartbeats, releases, claims all touch it) and cannot serve as an immutable "send started" instant: separate claimed / possibly-sent / definitely-unsent semantics are needed; (c) `claimed_fence IS NULL` (a legacy row) must NOT be read as permission to send uncertain work; (d) a human escalation can still overlap a late automated reply, so at-most-once is per automated action, not per conversation.

## 5. DRAFT DDL (not applied; reviewed migration only; UAT first)

Same convention as the existing drafts: LEDGER_SCHEMA_SQL runs at boot (CODE-ONLY), additive and idempotent. Any new `ALTER` must come **after** the `CREATE TABLE IF NOT EXISTS delivery_ledger` statement in that constant. `ADD COLUMN IF NOT EXISTS` does **not** verify an existing column's type: if a column of that name pre-exists with another type the statement is a silent no-op, so the migration must be paired with a boot-time column-type assertion (information_schema check) that refuses to start on mismatch.

```sql
-- DRAFT FOR REVIEW - NOT APPLIED - UAT ONLY - needs its own authorisation
-- Fence token is delivery_ledger.attempts (existing). New columns are optional audit/predicate helpers.
ALTER TABLE delivery_ledger
  ADD COLUMN IF NOT EXISTS claimed_fence integer NULL,   -- attempts value of the delivery row when this ACTION row was claimed
  ADD COLUMN IF NOT EXISTS fenced_out_at timestamptz NULL; -- audit: set when a stale write was refused for this key (optional)
-- Already drafted separately (drafts/0002_delivery_ledger_paperclip_ids.DRAFT.sql), on the 'delivery' row, no interaction:
--   paperclip_issue_id text NULL, paperclip_run_id text NULL
-- Rollback (NOT executed): ALTER TABLE delivery_ledger DROP COLUMN IF EXISTS claimed_fence, DROP COLUMN IF EXISTS fenced_out_at;
```
Backfill: none. `claimed_fence IS NULL` means a legacy row: predicates treat `(claimed_fence IS NULL OR claimed_fence = $fence)` as allowed, so in-flight work at upgrade time is not stranded. No index needed (writes are by primary key).

## 6. What changes in the deployed gateway

CODE-ONLY / cannot know: the live image is `overlay-5317cec` and is **not** in this checkout's history (the checkout is based on 8b5feb3). I cannot say what its `delivery_ledger` columns, `reserve()` or sweeper look like. Before any rollout someone must read the live schema and code at 5317cec by an authorised read-only route; assume nothing.

If separately authorised (this is a schema + code change to a service already deployed: owner authorisation and the Promotion Process; Law 22 stop-and-ask applies; this proposal authorises nothing):
1. Order: schema first (additive columns, nothing reads them), then code behind a flag `GATEWAY_LEASE_FENCE` (default off), then enable on UAT, then decide live.
2. Rollback: flag off (code ignores the fence); `DROP COLUMN` of the two new columns is safe once no running version reads them; with the flag off nothing breaks. The `attempts` semantics are unchanged.
3. Mixed-version failure mode: an **old** instance does not send/check a fence, so it can still stale-complete a row that a **new** instance resumed. The fence protects only new-vs-new. Therefore: do not rely on the fence until every replica runs the new code (rolling deploy with one replica, or drain first). The old instance's unfenced `complete()` also updates by key only; this cannot be made safe from the new side.
4. Interaction with the turn budget (GATEWAY_TURN_BUDGET_MS): keep it as containment; the fence makes it non-load-bearing for exclusivity.

## 7. Minimal test plan

7.1 Socket-free (injected fetch, fake ledger **that enforces the same predicate semantics** as 2.2, including the FOR SHARE ordering modelled as a lock):
- A late-complete vs B: A in `finish()` awaiting `complete()`, lease expires, B reserves (attempts 2), A's `complete()` returns zero rows and writes nothing; B's reply is sent exactly once. Control: a live A completes normally; a reclaimed delivery completes via B.
- Stale `claimAction`/`complete`/`fail`/`heartbeat` each rejected; control for each when fence matches.
- `release` makes a fenced-but-unsent reply retryable: ZERO customer messages is impossible (this is the F4 regression test; it must fail on the current code).
- A late-send vs B reconcile with a fake Chatwoot whose first POST commits late: B does not conclude "absent" before `claimed_at + T_wait`; after `T_wait` with ref absent B escalates (strict policy) and sends nothing; with A's late commit landing before B's check, B adopts the message and sends nothing. Positive control: no late commit and policy at-least-once => exactly one message.
- Stale worker's `requestHuman` with an old expected episode is refused (F5).
- Sabotage: remove the predicate => the two-worker tests go red; remove the wait => the reconcile test goes red.

7.2 Real PostgreSQL (the fake cannot prove SQL behaviour: lock modes, READ COMMITTED re-evaluation, statement timeouts): two connections, a real `reserve()` takeover racing a stale `claimAction`/`complete`; assert the stale statement returns zero rows in both interleavings; assert `FOR SHARE` blocks the takeover until the short transaction ends. Needs an authorised scratch Postgres on UAT (earlier scratch-container attempts on deepseek were guard-blocked and Lane A ruled on them; use only the route Lane A/owner names). Existing `OWNERSHIP_PG_TESTS` flag shows the pattern (currently skipped, no DB available to Codex or the fork).

## 8. Options considered and rejected

- More timing machinery (tighter budgets, bigger margins): F1-F4 show a margin cannot establish exclusivity (clock jumps, event-loop stalls, an uncancellable pending request).
- Heartbeat renewal alone: lets a turn outlive its lease and still needs a token-checked write to be safe; with the token, the renewal is optional. Not needed for exclusivity.
- Advisory locks held for the whole turn: tie a pooled connection to each in-flight delivery for up to the full budget (pool size is 4, CODE-ONLY), do not stop an HTTP request already sent, and add a failure mode on connection loss. Rejected.
- `SELECT ... FOR UPDATE SKIP LOCKED` held across the turn: same long open transaction problem plus idle-in-transaction timeouts. Rejected. (The short `FOR SHARE` in 2.2 is the minimal use of a lock.)
- Patching/forking Chatwoot for unique source ids: rejected (section 3).

## 9. Recommended minimal path and interim rule

1. Land the code-defect fixes (F1, F4-F7) that need no schema: propagate one deadline/AbortSignal into `invoke()` and the Paperclip calls, fix the `fail('fenced')` terminal bug, pass the expected episode.
2. Authorise (owner) the additive schema (section 5) and the fenced-lease code behind `GATEWAY_LEASE_FENCE`, **UAT only first**; real-Postgres test (7.2) is the gate.
3. Adopt strict at-most-once-after-ambiguity for any binding where the Paperclip seam is on.
4. **Interim operating rule until then (corrected after Codex round 4):** the Paperclip seam stays default OFF and there is NO production use of this branch. "One gateway replica and one sweeper" is NOT enforced by code and does NOT remove the second worker (see section 4); it is not a mitigation. The in-memory issue store also means no real runs across restarts.

## 10. Status after Codex round 4 (103c353) and the follow-up code commits

Codex found three further CODE defects, not part of F2/F3, now fixed on the branch with tests (see BRANCH-NOTES): G4-1 recovery completed a delivery while its released escalation was unpublished; G4-2 a replay adopted another delivery's ownership hold; G4-3 an unreadable Chatwoot response was treated as proof a message was absent and caused a second send. The ledger also gained a holder-fenced `release(identity, action, attempts)` and an insert-or-acquire `claimAction` (no schema change). None of that is exclusivity: F2 and F3 remain open, pending the owner's decision on this proposal.

Open questions for the owner/Lane A: (a) strict at-most-once (escalate on unconfirmed send) versus at-least-once (resend); (b) the measured upstream pending-time bound for `T_wait` (who reads the proxy/Rails timeouts?); (c) authorisation for a UAT scratch Postgres and the schema change; (d) whether the live gateway (5317cec) is ever to receive this, and who may read its live schema first; (e) whether Chatwoot 4.18 changed `source_id` uniqueness (UNVERIFIED; a one-line check against the installed build).
