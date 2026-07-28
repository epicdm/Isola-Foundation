# Bare verbs resolve against work in play, not the whole Odoo backlog

**Found by:** the step-12 shadow run against real Odoo, 2026-07-28.
**Changed:** `resolveInboundStaffMessage` in `lib/staff-ops/service.ts`.

## What the shadow run showed

Running real inbound messages through the Foundation decision path against the
live EPIC Odoo produced this:

| inbound | decision | open work |
|---|---|---|
| bare `ACK` from the owner | `staff_disambiguation` across **25** open items | 25 |
| `BLOCKED waiting on the client` from the manager | `staff_disambiguation` across **25** open items | 25 |
| owner business question | `staff_help` (non_command) | 25 |
| prose containing "done" | `staff_help` (non_command) | 25 |
| `HELP` from staff | `staff_help` (explicit_help) | 13 |
| stranger | `exception` (unknown_sender) | 0 |
| inactive test identity | `exception` (unknown_sender) | 0 |

Every safety property held. The near-miss cases behaved exactly as designed:
prose did not become an action, a stranger was refused, the inactive identity
was refused.

And the loop was still unusable, because Eric genuinely has 25 open tasks in
Odoo and Phillip has 109. A bare `ACK` cannot be answered with a 25-item menu
over WhatsApp.

## Why the parser was not loosened

The obvious "fix" is to let the parser pick something — most recent, highest
priority, first in the list. That is precisely the behaviour the packet exists
to remove: guessing is how a staff acknowledgement lands on the wrong task, and
it reintroduces the failure the strict grammar was written to prevent.

The real error was in the input, not the decision. "Open in Odoo" and "in play
in this conversation" are different sets, and the parser was being handed the
wrong one.

## The change

`resolveInboundStaffMessage` now makes two passes.

1. **First pass over everything the person holds.** An explicit reference —
   `ACK #2478`, `DONE project.task#2292` — still reaches any of their work.
   Nothing is lost.
2. **If and only if that returns `needs_disambiguation`** — which only a bare
   verb can produce — narrow to work that is *in play*: dispatched to this
   person through the outbox, and not yet reported DONE. If that resolves to
   exactly one episode, that is what they meant.

If nothing is in play, or narrowing would not change the answer, the original
disambiguation stands. The system still refuses to guess; it just stops asking
about work nobody mentioned.

## What ends an episode

Only an **applied** `DONE`. `ACK` and `UPDATE` leave the work in play, because
a staff member may legitimately send several updates on one task before
finishing it. A `DONE` that failed to reach Odoo has `applied_at` NULL and does
not end anything — consistent with the rule that a row with `applied_at` NULL
is a request that did not complete.

## Operational consequence

Bare verbs only work for work Foundation actually dispatched. That is the
intended contract and it should be stated to staff in onboarding: reply plainly
to a task message, or name the task explicitly.
