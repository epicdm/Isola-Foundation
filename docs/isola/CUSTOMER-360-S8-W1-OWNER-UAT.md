# Customer 360 — S8-W1 owner walkthrough

**Slice:** S8-W1 — send an existing quotation or invoice into the customer's
Chatwoot conversation.
**Commit:** `6cabce3122cd8523d9b2659b13547a8a838a43cf` (image tag `6cabce31`)
**Authorised by:** `dec-chatwoot-is-the-customer-interface-full-two-way-odoo-2026-08-28`
(the S8 owner gate)

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

## Before you start

Staging reads a **separate, non-production Odoo** (`isola_erp` on host03) seeded
with test data. The customer you will see, "Patricia Yvonne Armour", is seeded
test data — **not** the real Odoo customer of the same name. Nothing you do in
steps 1–7 touches EPIC's real books.

Step 8 is different, and is called out on its own.

---

## Steps 1–7 — the safe walkthrough

**1. Open the panel.**
Go to `https://inbox.epic.dm`, sign in, open **account 2**, and open the
conversation the lane has prepared for this walkthrough. Click the
**Customer 360** tab in the right-hand panel.

If you see "Customer 360 is unavailable — Sign in to Isola", sign in once with
your `epic.owner` credentials (a separate login from Chatwoot) and return.

**2. Confirm you are looking at staging data.**
The panel should show **Patricia Yvonne Armour**, `+1 767 295 1770`. Under
**Sales** you should see quotation **S00001** for **USD 273.70**; under
**Billing**, invoice **INV/2026/00001** for **USD 217.35**, unpaid.

If you see EPIC's real customers instead, stop and say so — that would mean
staging is reading production Odoo, which it must not.

**3. Notice what is offered and what is not.**
Each quotation and invoice row has **Send to customer**. Any row without a
verified total or currency shows that button greyed out, with a reason on hover.
That is deliberate: a document we cannot describe truthfully is one we refuse to
send rather than send vaguely.

**4. Open the review.**
Click **Send to customer** on quotation **S00001**. A panel opens showing:
- the document, the amount, and which conversation it will post into
- **the exact message text** that will be sent — read it
- a line stating plainly that this posts a visible reply and cannot be unsent

Read the message. It should name the quotation, the exact amount with its
currency code, and invite a reply. It should contain no link, no attachment
claim, and nothing suggesting the customer has agreed to anything.

**5. Cancel first.**
Click **Cancel**. Nothing is sent. Confirm no new message appeared in the
conversation. This is worth doing before you send anything.

**6. Send it.**
Re-open **Send to customer** and click **Confirm and send to the customer**.

You should get a badge reporting the outcome, and it should say **sent** only
after Isola has read the message back out of Chatwoot. A reference id is shown
so the action can be traced later.

Now look at the conversation itself: exactly **one** new visible message,
matching the text you reviewed, word for word.

**7. Prove it cannot double-send.**
Click **Send to customer** on the same document again and confirm again.
You should NOT get a second message in the conversation — the second attempt is
recognised as the same operation and replays the first result.

Check the conversation once more: still exactly one message.

---

## Step 8 — the real customer send (READ THIS BEFORE CLICKING)

> ⚠️ **This step sends a real WhatsApp message to a real customer.**
> It is not a test. The customer will receive it on their phone, it will come
> from EPIC, and it cannot be unsent. Do this only when you are willing for that
> specific customer to receive that specific message.

This is the actual acceptance test for the slice: everything above proves the
mechanism, this proves the product.

1. Choose a real customer conversation where sending their quotation or invoice
   is something you would genuinely want to do right now.
2. Open Customer 360 → the document → **Send to customer**.
3. **Read the exact message.** You are the last check before a customer reads it.
4. If anything is wrong — wrong amount, wrong currency, wrong tone, wrong
   customer — click **Cancel** and tell the lane. A cancel here is a successful
   test, not a failed one.
5. If it is right, confirm. Then check the customer's conversation and confirm
   they received exactly what you approved.

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
