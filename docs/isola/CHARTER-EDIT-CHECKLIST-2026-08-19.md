# Charter edit sitting — ordered checklist

**Five edits. Two agents. Do them in this order.**
Everything below is measured, and the BEFORE text is quoted byte-exact so you can
find it in the file. Prepared 2026-08-19 by ESTATE. You make the edits; this lane
cannot — the write requires board authentication.

---

## Before you start — the rollback copies

Paperclip's revision history versions the agent **record** (name, budget, capabilities),
**not the instructions-bundle text**. So edits 3–5 are **irreversible** unless you have
these. Both are byte-verified against the live files:

| agent | snapshot file | bytes | sha256 |
|---|---|---|---|
| `fd2867d1` — 6737, customer | `artifacts/isola/charters/SNAPSHOT-2026-08-19-fd2867d1-6737-front-desk-AGENTS.md` | 7185 | `db75e1c0f3ae82f1adb316c43fa50a63c19682b39555c35d988550ef85714ff0` |
| `a60770e9` — 9043, internal | `artifacts/isola/charters/SNAPSHOT-2026-08-19-a60770e9-9043-internal-manager-AGENTS.md` | 1474 | `432b3d573a04be477a2a361010bfd9cf57dba7863b8805420dc970fb16d6b2c3` |

Edits **1 and 2** are on the agent record, so those two **are** revertible through
`config-revisions`. That is why they come first.

---

## EDIT 1 — `a60770e9` › capabilities field

### Do this one first. It is the security-audit hazard.

This field currently tells anyone reviewing access that the internal agent runs on
**your own full-toolset profile**. It does not — it runs on a read-only permission class.
A capability record that *overstates* privilege is exactly what an access review trusts.

**BEFORE** (verbatim):

> Internal-only manager for the owner. Thinks on Hermes (epic-operator). Answers questions about the business, drafts and structures work, and keeps track of what the owner has asked for. No customer contact. No Odoo tools at v1.

**AFTER:**

> Internal-only manager for the owner. Thinks on Hermes, profile `epic-internal-readonly-odoo` — a read-only permission class, not the owner's `epic-operator` profile. Answers questions about the business, drafts and structures work, and keeps track of what the owner has asked for. No customer contact. Has READ-ONLY Odoo access: open leads, recent sales, unpaid invoices, customer balance, business brief. Cannot write to Odoo; `query_odoo` and `get_odoo_record` are excluded.

**Two things are wrong in the old text, in opposite directions:** it names the wrong
profile (overstates privilege), and it says "No Odoo tools at v1" when nine are
registered and have executed (understates capability).

---

## EDIT 2 — `fd2867d1` › capabilities field

**BEFORE** (verbatim):

> Answers customer questions from approved business information, qualifies leads, captures name/contact/request, escalates to a human and resumes only after explicit handback.

**AFTER:**

> Answers customer questions from approved business information, qualifies leads, and captures name/contact/request. Has no tools and no escalation mechanism: it tells the customer that someone from EPIC will reply, and stops. There is no handback signal in the system, so it cannot detect or defer to a human takeover.

**Why:** "resumes only after explicit handback" is the same false promise as §6 below,
restated in the field a future audit would read as evidence. Fixing the charter and
leaving this leaves the claim standing.

---

## EDIT 3 — `fd2867d1` › charter §1, lines 19–20

### Irreversible from here on. The snapshot is named at the top.

**BEFORE** (verbatim — two lines, in the middle of §1):

```
**Never say or imply that you have booked, sent, logged, raised, registered, arranged or
updated anything.** Say what a colleague will do next.
```

**AFTER:**

```
**Never say or imply that you have booked, sent, logged, raised, registered, arranged,
updated, passed, handed, forwarded, escalated, notified or assigned anything.** You have
no way to do any of those. Say what will happen next, never what you have done.
```

**Why:** the old list has seven verbs and **"passed" is not one of them**. That is the
exact gap the agent walked through when it told a real customer *"I received your
attachment and passed this conversation to a team member for review."*

---

## EDIT 4 — `fd2867d1` › charter §6, lines 92–94

### This is the one that caused the customer harm.

**BEFORE** (verbatim — the final paragraph of §6):

```
**Once a person is handling the conversation, stay silent.** If the run context says a
human has taken over, reply with a single line saying a colleague is handling it — no
greeting, no summary, no helpful extra. Resume only when the context records a handback.
```

**AFTER** — ESTATE draft. **If the PM has given you replacement text, use theirs instead:**

```
You cannot tell whether a person has joined this conversation. Nothing in your context
reports that, so never say or imply that someone has taken it over, is handling it, or
has been passed anything. When you escalate, say only what is true: that someone from
EPIC will see this conversation and reply here. Then stop trying to resolve it yourself.
```

**Why:** `If the run context says a human has taken over` **is a condition that does not
exist**. There is no such field, and no handback signal. The model had to guess when the
branch applied, and produced its prescribed sentence — *"A colleague is handling this for
you now"* — to a customer nobody was handling.

**The replacement is true today:** staff genuinely do see these messages and reply from
the handset. "Someone from EPIC will reply here" needs no queue and no new mechanism.

---

## EDIT 5 — `a60770e9` › charter lines 10–13

**BEFORE** (verbatim):

```
**You have NO tools.** You cannot provision a tenant, grant minutes, set a flag,
create a lead, open or close a work order, send a message, touch Odoo, or change
anything in any system. There is no approval card, no confirm gate, no Telegram
action you are waiting on. Those do not exist for you.
```

**AFTER:**

```
**You have READ-ONLY Odoo access, and nothing else.** You can look up: open leads,
recent sales, unpaid invoices, a customer balance, and a short business brief.
You cannot provision a tenant, grant minutes, set a flag, create a lead, open or
close a work order, send a message, or CHANGE anything in any system — every Odoo
call available to you is a read. There is no approval card, no confirm gate, no
Telegram action you are waiting on. Those do not exist for you.
```

**Why:** on 2026-08-19 at 16:18 a staff member asked *"how are sales today?"* and got
*"I can't check sales data. I have no access to Odoo or any sales systems."* Nine Odoo
tools were registered and working at that moment. **The agent was obeying this line.**

---

## The edit I recommend you DO NOT make

You may have been told there were four charter edits. I make it three, and here is the
fourth candidate with the reasoning against it.

`a60770e9` charter lines 36–37 currently read:

```
Capability is added deliberately, after this charter is updated to describe it. Until
this file says you can do a thing, you cannot.
```

**Leave it exactly as it is.** That rule is not the defect — it is the safety property
that *worked*. Stripped of tools it believed it lacked, the agent did not invent a sales
figure; it said plainly that it had no access. The failure was that nobody updated the
charter when the capability was added, which is what Edit 5 fixes. Once Edit 5 lands,
this line becomes true again and keeps doing its job.

---

## After the sitting

1. **Nothing to restart.** Charter changes take effect on the next message — the runtime
   re-reads the bundle every 60 seconds.
2. **Verify by behaviour, not by the success banner.** Send one WhatsApp to 9043 asking
   about sales — it should now answer from Odoo. Send one to 6737 asking something it
   can't answer — it should say someone from EPIC will reply here, and should *not* claim
   to have passed anything to anyone.
3. **If an edit goes wrong**, paste back the snapshot named at the top of this file. It
   restores the exact previous behaviour, byte for byte.
