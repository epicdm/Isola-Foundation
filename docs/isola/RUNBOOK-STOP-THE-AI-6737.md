# RUNBOOK — How to stop the AI answering customers

**For the owner. Under pressure. Read the first box, do the thing, then read the rest.**
Written 2026-08-19 from measured state, not from documentation.

---

## ⛔ THE DOCUMENTED KILL SWITCH DOES NOT WORK

**Pausing the agent in Paperclip does NOT stop it.** Do not reach for it.

Proven today: `a60770e9` was paused at 04:13. At **16:18 it answered a message anyway.**
`fd2867d1`, the customer front desk, has carried `status: error` since 2026-08-18 18:07
and has answered customers repeatedly since — including at 14:56 today.

Paperclip's `status` field does not gate gateway traffic. Neither `paused` nor `error`
stops a reply.

---

## ✅ DO THIS — fastest, one action, reversible

**EasyPanel → project `isolagw` → service `gateway` → Stop.**

- **Time:** seconds.
- **Effect:** the AI stops replying on **6737 and 3742**.
- **Customer messages KEEP ARRIVING in Chatwoot.** Nothing is lost.
- **It fails to a human, not to silence.** When Chatwoot cannot reach the bot it marks
  the conversation open for an agent. Measured on this instance 2026-08-18 22:12:25:
  `"Conversation was marked open by system due to an error with the agent bot."`
- **Staff can still reply from the handset as they do today** — that path does not
  involve the gateway at all.
- **To undo:** Start the service. Seconds.

Do NOT stop `isolart_runtime` or `isola_ai` instead. `isolart_runtime` also serves the
internal 9043 line, and `isola_ai` is Paperclip itself — stopping it takes down the
charter store and the record of every conversation.

---

## If you need to stop 6737 ONLY, leaving 3742 running

**Chatwoot → Settings → Inboxes → "EPIC 295-6737 WhatsApp" → remove the connected bot.**

- **LOG IN AS `info@epic.dm`.** This matters: `eric@epic.dm` is an **agent**, not an
  administrator, on this account and cannot change inbox settings. The only confirmed
  administrator is `info@epic.dm`. (Phillip is an administrator but has never confirmed
  his account, so he cannot log in.)
- **Why per-inbox:** the same bot, "Isola Front Desk Agent" (id 3), is attached to
  **inbox 7 (6737) AND inbox 8 (3742)**. Deleting the *bot* stops both. Detaching it from
  inbox 7 stops only 6737.
- **Time:** a minute, once logged in.
- **To undo:** re-attach the bot to the inbox.

Chatwoot: `https://isola-chat.saas00.epic.dm` (also reachable as `inbox.epic.dm`).

---

## LAST RESORT ONLY — changing the Meta webhook

**Don't, unless the first two are impossible.** Removing or repointing the WhatsApp
webhook stops the AI *and stops customer messages arriving at all*. Customers get
silence, staff see nothing, and nothing records that it happened. It is the one option
that loses messages.

It is also an owner-only action by standing rule, is slower than either option above,
and on the shared WABA it must be changed **per phone number, never per WABA**.

---

## Quick comparison

| Action | Stops AI | Messages still arrive | Who can do it | Reversible | Time |
|---|---|---|---|---|---|
| **Stop `isolagw_gateway` (EasyPanel)** | 6737 + 3742 | **yes** | owner, EasyPanel | yes | seconds |
| **Detach bot from inbox 7 (Chatwoot)** | 6737 only | **yes** | `info@epic.dm` only | yes | ~1 min |
| Pause agent in Paperclip | **NO — does not work** | yes | — | — | — |
| Change Meta webhook | yes | **NO — messages lost** | owner only | yes, slowly | minutes |

---

## After you stop it

1. Customers who message will be waiting for a human. Staff already answer 6737 from
   the handset — that keeps working, so tell whoever is on the phone.
2. There is **no alarm** that the AI has stopped. Nothing will tell you. If you stop it,
   remember you stopped it.
3. Restarting is the reverse of whatever you did. Nothing else needs restoring.

## What this runbook does not cover

Stopping the **internal** 9043 line. That is `isolagwint_gateway`, same EasyPanel action,
and it affects only staff — no customer sees it.
