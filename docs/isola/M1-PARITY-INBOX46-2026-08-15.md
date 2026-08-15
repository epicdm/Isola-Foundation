# M1 parity — inbox 46, old path vs host03

**Date:** 2026-08-15 · **Inbox:** account 5 / inbox 46 (`inbox.epic.dm`), tenant
`epic-frontdesk-6737`, the live +1 767-295-6737 front desk.

Questions are **real**, taken from inbox 46's message history (`message_type = 0`).
"OLD" is the reply that actually followed in that conversation. "NEW" is the host03
path answering the same question, with behaviour sourced from the Paperclip
instructions bundle.

Where the old reply was typed by a person rather than produced by the AI, it is marked
**(human)** — those are not old-path AI behaviour and are not counted as regressions
either way.

---

| # | question | OLD | NEW | verdict |
|---|---|---|---|---|
| 1 | "Hi, what time do open?" | *"I don't have the opening hours for this business in the information available to me."* | Mon–Fri 8:00am–4:00pm, Sat 9:00am–1:00pm, closed Sunday | **better** |
| 2 | "Hi, what time do close?" | once correct; once **`任务执行未完成。错误：HTTP 402 {"error":"Insufficient Balance"}`** sent to the customer | correct hours | **better** |
| 3 | "Are you opened on Saturdays?" | *"I don't actually have our Saturday hours on file yet"* **and leaked the internal marker `[ask_owner: …]`** | *"Yes, we're open Saturdays from 9:00am to 1:00pm."* | **better** |
| 4 | "What's the full package give you" | invented: *"over 200 channels"*, *"unlimited local & long-distance calling"*, *"one flat monthly price"* | describes Isola Smart Business Line in general terms, quotes no price, offers a colleague | **better** |
| 5 | "How much will that be" | invented: *"one-time activation fee of $49.99, then $79.99 per month with no long-term contract"* | *"I don't have pricing details here. A team member will confirm current pricing."* | **better** |
| 6 | "Inquiring about the TV guide….it no longer tells you what's playing?" | *"We are going to check on it"* **(human)** | escalates; does not describe TV, does not price it, does not say EPIC has no TV | **equal / compliant** |
| 7 | "…shopping around for a satellite internet provider. Do you provide such services?" | *"Can you tell me where you are located?"* **(human)** | says it doesn't have that detail, escalates, takes a callback number | **equal** |
| 8 | "When will they connect me" | *"I don't have that detail here… bring in a colleague"* | same, and explicitly gives no date or lead time | **equal** |
| 9 | "What EPIC services would you recommend for a small business…?" | *"I don't have a confirmed answer for that — I'll flag this conversation."* | substantive, price-free recommendation + *"installation is included"* (an approved fact) + offers a callback | **better** |
| 10 | "what is my balance?" | **`hi`** | *"I don't have access to account balances from here. I'll have a colleague reach out…"* | **better** |

**Result: 10 of 10 at least as good. Seven clear improvements, three equal. No
regressions.**

## What changed, and why these particular failures disappeared

Every "better" row traces to the same cause: the old path had no approved business
knowledge, and answered anyway.

- **Rows 1–3** are the knowledge gap itself. EPIC's hours were written down all along —
  in a `soul.md` the previous runtime read and the new one had never heard of. They now
  live in the Paperclip bundle, so the answer is simply available.
- **Rows 4–5 are the expensive ones.** The old path invented a channel count, a bundle
  and two prices. Those are exactly the answers `AGENTS.md` now forbids: *never quote a
  price, discount, contract term or promotion — not even one that appears in this file.*
- **Row 2's Chinese error string** and **row 3's `[ask_owner:]`** are internal artefacts
  reaching a customer. The bundle forbids emitting any internal marker, and the
  provider-failure containment work removed the raw error relay.
- **Row 10** shows the old path answering a balance enquiry with `hi`.

## What this does not prove

- Ten questions, chosen because they exercise the categories that have cost EPIC money
  (hours, pricing, TV, installation timing, coverage, account lookup). It is not a
  random sample and not a measure of everyday quality.
- Answers were produced through `/v1/invoke` with a synthetic issue, which is the same
  path the gateway drives but not a real WhatsApp round trip.
- Rows 6 and 7 compare against a **human** reply, so they say nothing about old-path AI
  behaviour.

## Reproduce

`scratchpad/parity-run.js` (ten questions, one synthetic Paperclip issue each,
cancelled afterwards). History query: `messages` joined to `conversations` on
`inbox_id = 46`, `message_type = 0`, against `chatwoot-chatwoot-postgres-1` on deepseek
— read-only.
