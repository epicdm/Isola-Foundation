# Two authorities for one question: who decides whether the AI may speak

**Status:** design proposal. Nothing here is implemented. It is a decision, not a patch.
**Raised by:** the M1 cut, 2026-08-14. Found by observation, not by a test.

---

## The symptom

A conversation that is `open` in Chatwoot, with **no human present**, stays silent
forever. The customer keeps talking; nothing answers; no alarm fires; every health
signal is green.

This was seen live. Conversation 148 on inbox 46 sat `open` from 2026-08-13. Messages
2794 and 2795 ("what is my balance?", twice) received **no reply at all** — and that was
under the OLD Replit path, before any of this work. It is not a regression the cut
introduced. It is a pre-existing hole that the cut made visible.

## The mechanism

There are now two stores that answer two different questions, and the boundary between
them is in the wrong place.

| Question | Authority today | Where it lives |
|---|---|---|
| **Who owns this conversation?** | the ownership store | Postgres, `conversation_ownership` |
| **May the AI speak right now?** | Chatwoot's UI state | `conversations.status == 'pending'` |

`evaluateSuppression` in `src/webhook.ts` refuses to reply unless the conversation is
`pending` and unassigned. That predicate runs *before* the ownership gate and can
therefore veto it. The ownership store — which knows about episodes, handback and
mid-reconciliation silence — never gets consulted, because a `status` check already
said no.

So the durable, tested, episode-aware authority is subordinate to a UI field that
anything can change: an agent resolving a ticket for housekeeping, an automation rule,
a reopen, a bulk action, a stray API call.

## Why `pending` is not a proxy for "the AI may speak"

`pending` means *"Chatwoot has handed this to an agent bot and no human has picked it
up"*. That is a lifecycle state of the Chatwoot UI, not a statement about response
authority. Specifically:

- A conversation becomes `open` the moment **anything** touches it, including the
  gateway's own escalation path (`openConversation`), which is what triggers rule #3.
- Nothing ever moves it back to `pending`. There is no path from `open` to `pending`
  that a customer message can take.
- So `open` is **absorbing**. Once a conversation leaves `pending` it can never be
  answered by the AI again, even after the human who took it over has finished and gone
  home.

That last point is the defect stated plainly: **there is no way back.** The ownership
model has `HANDING_BACK → AI_RESUMED` precisely so authority *can* return to the AI.
The Chatwoot predicate has no equivalent and silently overrides it.

## What is NOT wrong

Worth stating, because it constrains the fix:

- Silence in a conversation a human genuinely owns is **correct**. Conversation 148 was
  labelled `human_takeover` and assigned to escalations. Nothing should answer there.
- The old path behaved the same way, so this is not a parity regression and does not
  block the cut.
- `evaluateSuppression`'s other checks — not `message_created`, not incoming, private
  note, sender is the bot itself — are all sound and must stay.

The defect is narrow: **`status == 'pending'` is being used as an authority signal when
it is only a lifecycle hint.**

## The proposal

Make the ownership store the sole authority for "may the AI speak", and demote the
Chatwoot check to what it is actually good at.

1. **Split the predicate.** `evaluateSuppression` keeps every structural check (event
   type, message direction, privacy, sender). It stops deciding on `status` and
   `assignee`.

2. **The ownership gate decides.** `suppressesAutomatedReply(state)` becomes the only
   thing that can veto a reply on authority grounds. It already handles the cases the
   status check cannot: `HUMAN_REQUESTED`, `HUMAN_OWNED`, mid-`HANDING_BACK` silence,
   and the single legal edge back to `AI_RESUMED`.

3. **Chatwoot state becomes an INPUT, not a veto.** An assignee appearing, or a human
   posting a message, should *drive a transition* — `recordHumanReply`, which already
   exists and is already tested and is currently **not wired to anything**. That is the
   missing link: Chatwoot tells the store what happened; the store decides what it
   means.

4. **Backfill on first sight.** A conversation with no ownership row that Chatwoot says
   is assigned or `human_takeover`-labelled should be recorded as `HUMAN_OWNED` on the
   first delivery, not treated as `AI_OWNED`. Fail closed while migrating.

### What this buys

- A conversation a human finished with can be handed back and answered again.
- Resolving or reopening a ticket stops being an accidental authority change.
- The `open`-with-no-human hole closes, because "no human present" becomes a state the
  store can represent and a transition can leave.

### What it risks, honestly

The status check is currently a **belt-and-braces second layer**. Removing it means the
ownership store becomes the single point of failure for "do not talk over a human". That
is the right design — one authority, not two — but it raises the bar on the store:
it must be correct, and it must fail closed when unreachable. It already does both
(`readState` fails closed to `HUMAN_OWNED`; an unreachable store throws rather than
defaulting), and both are tested against a real Postgres.

It also means a migration window in which conversations have no ownership row. Point 4
covers that, but it is the part most likely to be got wrong, and it should be shipped
inert and observed before it is allowed to suppress anything.

## What I am NOT proposing

- Not touching `evaluateSuppression`'s structural checks.
- Not making Chatwoot's status writable from the ownership store — that would be a
  second write path into someone else's system.
- Not doing any of this before the Paperclip configuration question is resolved. That
  decision may change where the reply path reads from, and this predicate sits directly
  on that path.

## Recommendation

Sequence it **after** the Paperclip persona/knowledge decision, and ship it in two
commits: wire `recordHumanReply` first (additive, changes no routing, produces
observable transitions), then flip the authority once there is a week of ownership rows
to look at.
