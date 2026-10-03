# Owner one-page: the "fenced lease" schema proposal (plain words)

Packet ISOLA-PIVOT-20261002-01. Companion to `PIVOT-FENCED-LEASES-DESIGN-PROPOSAL-2026-10-03.md` (technical). Labels: VERIFIED = read in code or docs; UNVERIFIED = not observed. **Nothing has been applied or deployed.**

> **What I am asking you to decide**
> 1. Approve building and testing this ONLY on the branch and on an authorised scratch database (not the live gateway)? Yes / No.
> 2. For a reply we cannot confirm was sent: **never resend, ask a person (recommended)** or **resend automatically**?
> 3. Who may read the live gateway's database layout (read-only) before anyone plans a rollout?
> 4. Applying it to the live gateway is a separate later decision; this page does not ask for it.

## 1. What is missing, and what goes wrong without it
The gateway answers a customer inside a time budget. Its safety today rests on **timing**: a worker that runs too long is supposed to stop before a second worker takes over. Codex (independent review, round 3) proved timing alone is not enough:
- **Duplicate reply:** worker A sends at second 269 and gives up waiting; the server keeps the request. At second 301 worker B checks, sees nothing, and sends. A's request then lands at second 320. The customer gets two messages (Codex F3, reproduced).
- **Wrong finish:** A is slow, its lease expires, B takes over, then A's late "done" closes B's row, because the database does not check who owns it (F2, reproduced).
- **Zero reply:** a reply cancelled at the deadline was marked "failed", which later code reads as "done". The customer got nothing while the record said replied (F4). Code-fixed on the branch (no schema).
- **Wrong handover:** an escalation could adopt a newer human takeover (F5). Code-fixed on the branch.

Already protecting customers: the time budget, a re-check that a human has not taken over before each write, and refusing to answer when identity is unclear. Not protecting: two workers acting at once (F2) and a slow send landing late (F3).

## 2. Why the tools we already run do not cover it
| Facility | What it does | Where it stops | Status |
|---|---|---|---|
| Chatwoot (live 4.18.0) | Signs each webhook and gives it a delivery id; Agent Bot API | Message-create has **no client idempotency key**; `source_id` is indexed but **not unique** | Verified in 4.16.1 code and swagger. **4.18 unchecked.** One-line check: read `db/schema.rb` / the unique indexes on `messages` in the installed 4.18 build |
| Hermes api_server (v0.16.0) | `/v1/runs` honours `Idempotency-Key` (= Paperclip run id); session key; `/v1/runs/{id}/stop` | Concerns the model run, not the Chatwoot send; whether Paperclip cancel reaches `stop` mid-run is untested | Relay of docs/source; **UNVERIFIED by behaviour** |
| Paperclip 0.3.1 | Issue create accepts `idempotencyKey` (<=255, "replays the original") and `externalRef`; run-id rule applies to AGENT callers only (missing = 401, invalid = 500) | No list filter by key; replay never exercised; a board key cannot be narrowed; a `task_bridge` key is the narrow option | Schema text only; **UNVERIFIED by behaviour** |

**None of them can stop a slow earlier Chatwoot send from landing after a later worker has already decided it never happened.**

## 3. The minimum change
- **Can the existing `attempts` counter alone suffice, with no new column? For the "two workers" problem (F2): YES.** `attempts` already goes up by one on every takeover, so it works as the ticket number. Every write and completion adds "only if my ticket number is still current" to its SQL; a stale worker gets zero rows and stops. For F3 (late send): **partly**. Schema alone cannot fix it; it needs a policy (section 6) and a wait time.
- **Two optional columns** (draft, not applied): `claimed_fence` (which ticket started a send, so a successor knows whose send it is and legacy rows are tolerated) and `fenced_out_at` (audit: when a stale write was refused). Useful, not required for the fence itself.
- **Smallest code change:** add the check to the delivery's complete/fail/heartbeat writes. Writes to other rows (reply, status, notes) run in one short transaction that first takes a read lock on the delivery row, then checks the ticket. A "release" step makes an unsent claim retryable.
- **What it does NOT fix (F3 residual):** a request already on the wire to Chatwoot cannot be recalled. Under "never resend" no duplicate comes from our code; under "resend automatically" a rare duplicate remains, and its window (how long Chatwoot can keep an aborted request pending) is **UNMEASURED**.

## 4. Rollback
1. Switch the new flag (`GATEWAY_LEASE_FENCE`) off: the code ignores the ticket and behaves as today. 2. Then drop the two optional columns (`DROP COLUMN IF EXISTS`, safe once no running version reads them). The `attempts` meaning does not change, so nothing else breaks.
**Mixed-version caveat:** an old copy of the gateway does not check the ticket, so it can still close a row the new copy took over. Do not rely on the fence until **every** replica runs the new code.

## 5. Two stages, two sets of approvers
| Stage | What happens | Who must authorise |
|---|---|---|
| A. Isolated build | Branch code + fake ledger tests (no database), then a real-PostgreSQL race test (two connections) on a **scratch Postgres**. No scratch resource is known to me; earlier scratch containers on deepseek were blocked by the safety hook. It needs a named, authorised throwaway database on UAT | Owner (scratch DB) / Lane A names the route |
| B. Live gateway (image `overlay-5317cec`, not in this repo's history) | Read its real tables and code read-only first; add columns (additive) first; then flagged code; all replicas on new code | Owner **and** Overall PM / Promotion Process; Law 22 stop-and-ask; a read-only schema read needs its own approval |

## 6. At-most-once or at-least-once for a reply we cannot confirm
When a send was cut off and the next worker cannot see the message, we either **never resend and hand the thread to a person (at-most-once)** or **resend automatically (at-least-once)**. At-most-once: the customer never gets the same answer twice, but now and then waits for a human to reply (no silence, since a person is asked). At-least-once: nobody is left without an answer, but a rare duplicate message appears, how rare unmeasured. **Recommendation, for your decision, not mine: at-most-once for customer-facing replies**, because a human follow-up is the fail-closed answer and current volume is low.

Interim rule until you decide: the Paperclip path stays OFF; any sandbox test runs ONE gateway copy and ONE sweeper, test conversations only.

**Nothing has been applied or deployed.**
