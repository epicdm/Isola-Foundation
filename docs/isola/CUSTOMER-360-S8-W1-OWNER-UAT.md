# Customer 360 — S8-W1 owner walkthrough

**Slice:** S8-W1 — send an existing quotation or invoice into the customer's
Chatwoot conversation.
**Commit:** `8802d19` — this script describes THAT build and no earlier one.
**Authorised by:** `dec-chatwoot-is-the-customer-interface-full-two-way-odoo-2026-08-28`
(the S8 owner gate)

> ⚠️ **Check the build before you start.** This script previously pinned
> `7a9e2999`, a build that says **"Sent"** where this script now says
> **"Posted"**, and which has none of the safety wording added since. Running
> this script against that image produces a walkthrough where every expected
> string is wrong — and the step-7 warning about a send still in flight cannot
> appear at all, because that build has no such state. If what you see does not
> match what is written here, **stop and tell the lane** rather than working
> around it: a mismatch means the script and the build have drifted apart, which
> has already happened three times on this document, and the acceptance record it
> produces would be worthless.

---

## What this slice does, in one sentence

You pick an existing quotation or invoice in the Customer 360 panel, review the
exact message that will go to the customer, click confirm, and Isola posts it
into that customer's Chatwoot conversation — then reads it back from Chatwoot
before telling you it was sent.

## What it deliberately does NOT do

- It does not change anything in Odoo. No record is created, edited or posted.
- It does not let you write the message. Every word comes from the verified Odoo
  document. There is no free-text box, on purpose — a hand-typed price is the
  one thing that can be confidently wrong.
- It does not attach a PDF. This slice sends text. Nothing in the wording implies
  an attachment.
- It never sends silently. Nothing leaves without your explicit confirm click.

---

## Before you start — read this, it decides whether a customer gets a message

There are two different places you can do this, and they are not equally safe.

**Steps 1–7 use conversation #28**, in the inbox named
`ZZ ACCEPTANCE ONLY - epic-front-desk-prod (no WhatsApp, no Meta)`. That inbox is
an API channel with no WhatsApp and no Meta connection, so a message posted there
**cannot reach anyone's phone by any route**. The contact is EPIC's own
acceptance canary. This is the safe half.

**Step 8 is a real customer**, and is called out separately with its own warning.

Staging also reads a **separate, non-production Odoo** (`isola_erp` on host03)
seeded with test data. The account you will see in steps 1–7, "S8-W1 Verification
Account", is fabricated for this test. Nothing in steps 1–7 touches EPIC's real
books or any real person.

---

## Steps 1–7 — the safe walkthrough

**1. Open the panel.**
Go to `https://inbox.epic.dm`, sign in, and open **account 2 → conversation #28**
("EPIC Acceptance Canary (Packet 5D-RR)"). Check the header says
`ZZ ACCEPTANCE ONLY … (no WhatsApp, no Meta)` before continuing — that line is
what makes these steps safe. Then click the **Customer 360 (STAGING)** tab.

If you see "Customer 360 is unavailable — Sign in to Isola", sign in once with
your `epic.owner` credentials (a separate login from Chatwoot) and return.

**2. Confirm you are looking at staging data.**
The panel should show **S8-W1 Verification Account**, `+1 500 555 0006`. Under
**Sales**: quotation **S00004** for **US$48.30**. Under **Billing**: invoice
**INV/2026/00002** for **US$56.35**, unpaid.

If you see a real EPIC customer instead, **stop and say so** — that would mean
staging is reading production Odoo, which it must not.

**3. Notice what is offered and what is not.**
Each quotation and invoice row has **Send to customer**. Any row without a
verified total or currency shows that button greyed out, with a reason on hover.
That is deliberate: a document we cannot describe truthfully is one we refuse to
send rather than send vaguely.

You will also see **Open in Odoo** greyed out here. That is correct on staging —
the staging Odoo is reachable only over an internal address, and rather than
show you a link that would not open, the panel offers none.

**4. Open the review.**
Click **Send to customer** on quotation **S00004**. A panel opens showing:
- the document, the amount, and which conversation it will post into
- **the exact message text** that will be sent — read it
- a line stating plainly that this posts a visible reply and cannot be unsent
- **"This also moves the conversation to you. The AI assistant stops replying
  in conversation #28 once you send, so the customer’s next message is yours to
  answer."**

That last line is new, and it is there because the effect was real before it was
ever stated. Sending a document has always handed the conversation to a human and
stopped the AI on it — the panel simply never said so. That is the correct
behaviour: if a customer replies "what is this charge?", a person should be
answering, not a scripted bot. What was wrong was that it happened silently.

Also note what is **not** yet fixed: the handover is recorded against the
Chatwoot account the send used, not against you personally, so the history says
a Chatwoot user took over rather than naming which member of staff. That fix
lives in another service and is tracked separately. Nothing here claims it is
done.

Read the message. It should name the quotation, the exact amount with its
currency code, and invite a reply. It should contain no link, no attachment
claim, and nothing suggesting the customer has agreed to anything.

**5. Cancel first.**
Click **Cancel**. Nothing is sent. Switch to the **Messages** tab and confirm no
new message appeared. This is worth doing before you send anything.

**6. Send it.**
Re-open **Send to customer** and click **Confirm and send to the customer**.

The row should read **"Posted into the conversation — read back from the system
of record"**, plus a reference id so the action can be traced later.

That wording is deliberate and it is worth reading twice. It says **posted**, not
**sent**. Isola has read the message back out of Chatwoot and proved it is there,
word for word and visible to the customer — that is real proof, and it is more
than most systems give you. What it does **not** prove is that WhatsApp has
delivered it to the handset, because Chatwoot hands off to Meta afterwards and
tells us nothing about what happens next. Outside the 24-hour reply window Meta
can refuse a message Chatwoot has already stored. So the panel claims exactly
what it measured and no more. Delivery status is a real improvement and it is on
the list; it is not in this slice.

Now open **Messages**: exactly **one** new visible message, matching the text you
reviewed, word for word.

**7. Prove it cannot double-send.**
Click **Send to customer** on the same document again and confirm again.

The row should now read **"Already posted — not posted again"**. Check Messages
once more: still exactly one message. The second attempt was recognised as the
same operation and refused to write again.

If instead you see **"Still sending — not confirmed yet. Do not send it again
until this settles"**, the first attempt is still running. Wait for it to settle
and look at Messages; do not send again and do not post the document by hand.

**Optional:** repeat steps 4–6 with invoice **INV/2026/00002** to see how an
invoice reads — it should also state the unpaid status in plain words, not as an
Odoo status code.

---

## Step 8 — WITHDRAWN 2026-08-28. Do not run it.

> 🛑 **This step has been pulled. Do not send into a real customer conversation
> from this panel until it returns, rewritten.**

Step 8 previously asked you to send a quotation or invoice into a real WhatsApp
conversation — the example given was `EPIC 295-6737 WhatsApp`, which is EPIC's
front desk and a protected number.

**Why it was pulled.** An independent review of the code found that sending a
document from this panel also hands that conversation over to human handling and
switches the AI off for it — because the send is posted with an agent credential,
which Chatwoot and our own webhook cannot tell apart from a human agent typing a
reply. At the time, nothing said so: not the panel, not the action catalogue.

That made step 8 an **undeclared** ownership change on a live customer-facing
surface, which is not something a walkthrough may ask an owner to perform.

**What has changed since, and what has not.** The panel now states the handover
before you click, and the action catalogue lists it (you will see that line in
step 4). What is still outstanding is the **attribution**: the transition is
recorded against the Chatwoot account the send used rather than against you, and
that write lives in another service. Until it names the person who acted, this
step stays withdrawn — a live handover on the front desk should be traceable to
a named member of staff, not to a shared credential.

**What is still safe.** Steps 1–7 are unaffected and remain the walkthrough.
They run in `ZZ ACCEPTANCE ONLY - epic-front-desk-prod (no WhatsApp, no Meta)`,
against seeded data in a non-production Odoo.

**When it comes back.** After the fix ships, this step returns rewritten: the
send will either not change conversation ownership, or it will say plainly on
screen that it is about to and require that to be confirmed. It will also name
one specific pre-agreed conversation rather than letting the reader choose a
live one.

---

## What to tell us afterwards

In your own words, the same as S1–S3:

- Did the review panel give you enough to decide, or were you guessing?
- Was the message something you would actually send a customer as written?
- Did anything feel risky, unclear, or slower than doing it by hand?
- What would you want next — create a quote, create an invoice, take a payment,
  send a PDF?

Your unedited reaction is the acceptance record. If the answer is "useful but
not there yet", that is a useful answer and it will be recorded as written.
