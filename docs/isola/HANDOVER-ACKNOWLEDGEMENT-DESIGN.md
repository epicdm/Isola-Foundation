# Escalation reality + handover acknowledgement — design

**Status:** DESIGN FOR REVIEW. Creates no code. Not implementation authority.
**Supersedes** the gateway-side revision of this file (H4 bound to the gateway's
`status === "pending"` predicate). That binding was wrong: live WhatsApp is Foundation-side,
deepseek inbox 46, account 5.
**Covers:** owner ruling on OWNER DECISION 5 ("make escalation real") and the
silence-after-handover defect, drafted together because they are one mechanism.

> **The AI stopping is correct and is not in scope to change.** This adds one system
> acknowledgement, not an AI reply, and must not become a second route by which a model
> reaches a customer.

---

## 0. Two corrections before anything is built

**(a) Do not bind to `Conversation.human_handling`.** The ruling named it, but the schema
retired it. Verbatim from `schema.prisma`:

> `// COMPATIBILITY PROJECTION, NO LONGER AUTHORITATIVE (Commit 2). Derived from`
> `// ownership_state by lib/ownership/state.ts projectHumanHandling(); written only by the`
> `// ownership engine (lib/ownership/transitions.ts).`

Binding new customer-facing behaviour to a field that is explicitly a projection, and is
retained only so legacy dashboards keep working, would break the day it is dropped — and it
cannot express what this design needs anyway. **Bind to `ownership_state`.**

**(b) Owner Decision 5 is already substantially implemented on this side.** The frozen spec's
"a model-initiated escalation produces no state change at all" is true of the **gateway**, not
of Foundation. Foundation already has:

| Mechanism | Where |
|---|---|
| `AI_OWNED · HUMAN_REQUESTED · HUMAN_OWNED · HANDING_BACK · AI_RESUMED` | `lib/clawith/contract.ts` `OWNERSHIP_STATES` |
| AI may reply **only** in `AI_OWNED` / `AI_RESUMED` | `AI_REPLY_OWNERSHIP_STATES` |
| Escalation → `HUMAN_REQUESTED`, claimed **exactly once** on the ref's correlation id | `lib/ownership/transitions.ts` `requestHumanOwnership` |
| Chatwoot assignment + one private note, then → `HUMAN_OWNED` | `lib/chatwoot-handoff.ts` `surfaceHandoff`, `confirmHumanOwnership` |
| Customer intent detection | `lib/escalation-intent.ts` `detectEscalationIntent` |
| **Backstop making the claim true** — if the model *says* it escalated, handoff is forced | `lib/escalation-claim.ts` `detectEscalationClaim` → `needsHandoff: true` |
| Seven reason codes incl. `explicit_human_request` | `ESCALATION_REASON_CODES` |
| Per-episode audit trail | `ConversationOwnershipTransition` |

So "I've flagged it for a colleague must be TRUE when said" is **already the intended
behaviour here**, enforced by a backstop that fires on the reply text.

**What the ruling therefore still needs is verification, not construction:** prove on the live
path that a model-initiated escalation reaches `HUMAN_OWNED` with an assignment, and identify
which of the seven reason codes are actually reachable. That is a test-matrix job
(§6), not a build. **Do not rebuild an ownership engine that already exists.**

---

## 1. The remaining gap

After handover the customer's next message receives nothing. Correctly — `ownership_state` is
`HUMAN_REQUESTED`/`HUMAN_OWNED`, so `AI_REPLY_OWNERSHIP_STATES` excludes it and Clawith is
never invoked. The refusal is total and silent, and the customer cannot tell "a person has
this" from "this channel is dead".

## 2. What is added — one sentence

**On the first inbound customer message after ownership passes to a human, and only the
first, send one fixed system sentence confirming the message reached a person. Then silence
again for the rest of that episode.**

## 3. Trigger predicate

| # | Condition | Why |
|---|---|---|
| H1 | Inbound customer message on a Chatwoot-backed conversation | — |
| H2 | `ownership_state ∈ { HUMAN_REQUESTED, HUMAN_OWNED }` | The exact complement of `AI_REPLY_OWNERSHIP_STATES`, minus H3 |
| H3 | **Not** `HANDING_BACK` | Reconciliation in progress — nobody speaks, by design |
| H4 | `ownership_state = HUMAN_OWNED` | **Rekeyed.** See below |
| H5 | `ownership_episode > handover_ack_episode` | §4 |

**H4 rekey — why `HUMAN_OWNED` is now trustworthy.** The earlier draft could not key on
`HUMAN_OWNED`, because it was written unconditionally: `surfaceHandoff` returned `void` and
swallowed its own failures, so Foundation recorded `HUMAN_OWNED` with reason
`chatwoot_assignment_and_context_published` even when nothing reached Chatwoot. Keying an
acknowledgement on that would have told customers a person had their conversation on the
strength of an assertion nothing checked.

That is now fixed at the source rather than worked around here. `surfaceHandoff` returns
`HandoffSurfaceResult`, and `confirmHumanOwnership` is called **only when the handoff actually
surfaced**; otherwise ownership stays at `HUMAN_REQUESTED` (the AI is silent either way) and
`escalate_to_human.surface_failed` records which parts failed. The reason constant is now
`chatwoot_context_published` — it no longer claims an assignment Foundation does not perform.

So `HUMAN_OWNED` has become exactly the signal H4 needs: *a handoff that actually reached
Chatwoot*. H4 keys on the state, and the state now means what it says.
| H6 | `conversation.chatwoot_binding_id` non-null and consistent | Same fail-closed rule `/api/customer/escalate` already applies |

## 4. Exactly-once — already solved, do not reinvent

The schema states it outright: *"Increments once per span of human involvement. **Identity for
exactly-once is tenant + conversation + episode.**"*

`ownership_episode` is precisely the episode key the earlier draft proposed to synthesise from
a Chatwoot custom attribute. Use it. Hand back and escalate again → new episode → the customer
is entitled to a second acknowledgement, which is correct: it is a new period of waiting.

Storage: one nullable column, `handover_ack_episode Int?`, written in the same transaction as
the send. Fire only when `ownership_episode > (handover_ack_episode ?? -1)`. That is a
monotonic comparison, not a read-then-write race — two simultaneous inbound messages cannot
both win, because the second sees the updated value or loses the row lock.

**No Chatwoot custom attribute. No new store. No new idempotency mechanism.**

### 4.1 Observed operating characteristic — bounded in practice, not just in theory

Measured on prod `neondb`, 2026-08-13: **7 transitions to `HUMAN_REQUESTED`, 7 to
`HUMAN_OWNED`, only 3 to `AI_OWNED` — the most recent of those on 2026-08-05.**

Escalations confirm reliably; conversations rarely return to the AI. Episodes therefore stay
open rather than cycling, so in practice the per-episode key fires **roughly once per
conversation**, not repeatedly. That is the difference between a design that is theoretically
bounded (one ack per episode, however many episodes there are) and one that is bounded in
observed operation (episodes are approximately conversations). It also means K3 — the
handback-then-re-escalate case — exercises a path that is real but **rare**, so it must be
tested deliberately rather than expected to appear in live traffic.

## 5. The string, and the constraint nobody would guess

Constraints: one sentence; no greeting or sign-off; **must not imply a response time** (no
"shortly", "soon", no duration, no business-hours reference — note EMA's `soul.md` line 27 was
just amended precisely to stop hours leading a reply); must not claim an action not taken;
must read as receipt, not as an AI answer.

Recommended:

> `Thanks — your message has been added to the conversation and a member of our team has it.`

**Governance — it must pass TWO detectors, not one.**

1. `guardReply(text, tenantId)` must return `blocked === false`. The claim-guard is an output
   filter for *generated* text; this string is pinned, so the correct application is a
   **build-time assertion**, not a runtime filter — same register, no runtime dependency.
2. **`detectEscalationClaim(text)` must return `claims === false`.** This is the sharp one.
   That backstop forces `needsHandoff: true` whenever a reply *claims* a handoff occurred. Our
   acknowledgement says a team member has the conversation — which is exactly the shape it
   looks for. If the ack trips it, every acknowledgement re-triggers a handoff, on a
   conversation already handed over. **A string that passes the claim-guard and fails the
   escalation-claim detector would create a loop.** Both assertions ship with the string.

## 6. Verification the ruling needs (distinct from the build)

Results as at 2026-08-13, read from prod `neondb` (not the repo, not the dev database).

| # | Check | Result |
|---|---|---|
| E1 | Customer asks for a human on the live path | **PASS.** All 7 escalations in production history reached `HUMAN_OWNED`, every one at episode 1, confirmed within ~1.1s, spanning 2026-07-30 → 2026-08-13 |
| E2 | Model claims escalation without the customer asking | **Historical half: OBSERVED.** `escalation_claim.handoff_forced` n=8 (latest 2026-07-30); `claim_guard.blocked` n=6 (latest 2026-08-09). **Forward half DEFERRED** by owner ruling — it needs a deliberate mutation on a live customer-facing path to confirm something already evidenced 8 times. Revisit when a non-production path exists |
| E3 | Assignment fails | **NOT RUN — REQUIRES REWRITE.** See below |
| E4 | Reason codes | **Zero of seven reachable.** See `defect-escalation-reason-codes-declared-but-never-carried-2026-08-13` |

**E3 cannot fail on Foundation's side, so as written it cannot detect its own failure mode.**
The check assumes Foundation performs the assignment and can therefore fail at it. It does
not: Foundation publishes context (private note, `ai-handoff` label, reopen) and issues **no
Chatwoot assignment call at all** — the assignment is performed by Chatwoot automation rule #3
(`defect-handoff-assignment-performed-by-chatwoot-automation-not-foundation-2026-08-13`). If
that rule were disabled tomorrow, Foundation would still write `HUMAN_OWNED` with reason
`chatwoot_assignment_and_context_published`, and E3 would still pass.

A test that passes whether or not the thing it guards is working is worse than no test,
because it reads as coverage. **E3 must be rewritten before it is run** — against the actual
failure mode, which is "the assignment does not happen and Foundation asserts it did".

## 7. Acceptance tests for the acknowledgement

| # | Check | Pass condition |
|---|---|---|
| K1 | Handed over, one inbound | Exactly one acknowledgement |
| K2 | Handed over, five inbound | Still exactly **one** |
| K3 | Handback, re-escalate, one inbound | A second — one per episode. **Deliberate test, NOT a regression guard:** the governed handback door (`POST /api/conversations/[id]/handback`) has **never been used in production** — all 3 returns to `AI_OWNED` were `resolution_observed`, latest 2026-08-05. K3 must not be read as protecting proven behaviour |
| K4 | Two inbound in the same instant | Exactly one |
| K5 | Escalation incomplete (H4 false) | **Zero** |
| K6 | `HANDING_BACK` | Zero |
| K7 | `AI_OWNED` / `AI_RESUMED` | Zero — normal AI path untouched |
| K8 | Private note inbound | Zero |
| K9 | String | Byte-for-byte equal to the pinned constant |
| K10 | `guardReply(string)` | `blocked === false` |
| K11 | `detectEscalationClaim(string)` | `claims === false` |
| K12 | AI silence throughout | Unchanged — zero agent replies, **observed** not inferred |

K12 and K11 are the two that matter: the first proves this did not become a path by which the
model speaks after takeover; the second proves it did not become an escalation loop.

## 8. Owner decisions

1. The string, or a reworded one — pinned byte for byte once chosen.
2. Should the ack also fire when the customer escalated **explicitly** (they asked for a
   human and got the escalation sentence)? That reply already confirms a handoff, so the
   ack on their *next* message is still the first unanswered one — recommend yes, unchanged.
3. Confirm `handover_ack_episode` as a schema addition — it is a nullable Int on an existing
   table, additive, no backfill.
