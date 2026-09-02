# EPIC receivables action list — runbook

Deployed on **host03 (66.118.37.110)**. Publishes one issue per weekday to Paperclip
company `3ed3869b-463c-4876-8e16-ddc058f06cd9`, agent
`2b4cf82a-00d5-496b-877e-b5bc9201d52c` ("EPIC Staff Operations Coordinator").

| | |
|---|---|
| timer | `isola-ar-run.timer` — `Mon..Fri *-*-* 11:00 UTC` (= 07:00 America/Dominica; host03 is `Etc/UTC`) |
| service | `isola-ar-run.service` → `/usr/local/bin/isola-ar-run.sh` |
| runner | `/paperclip/bin/ar-run.js` inside the `isola_ai` container (durable volume `isola_ai_data`) |
| logs | `journalctl -u isola-ar-run.service` |
| ledger | `epic-communications-inc.odoo.com`, db `epic-communications-inc` — **and nothing else** |

---

## ⚠ ROLLBACK — restoring Odoo user 12

On **2026-08-14** user 12 (`ai-operations@epic.dm`, "AI Ops Manager", INTERNAL) was
stripped to read-only so the agent could not write to the ledger. It went from five
groups to two.

**To restore it exactly as it was, one operation:**

```
res.users.write  ids=[12]  vals={"group_ids": [[6, 0, [1, 24, 36, 52, 82]]]}
```

Those five ids, so nobody has to guess in six weeks:

| id | group | privilege |
|---|---|---|
| 1 | Role / User | base internal user |
| 24 | Read-only | Accounting |
| 36 | User: All Documents | Sales |
| 52 | User | Project |
| 82 | User | Helpdesk |

Current state is `[1, 24]`. **You never need permission to roll back.** Requires an admin
credential (`ODOO_API_KEY` in `/opt/bff-v2/.env` on deepseek, which is Eric's uid 2).

Odoo 19 naming, because older recipes break: `res.users.groups_id` → **`group_ids`**
(`all_group_ids` for implied), `res.groups.category_id` → **`privilege_id`**.

### What is enforced, and what is not

Established from `ir.model.access` intersected with effective groups — **not** inferred
from error codes:

- **ENFORCED (denied):** `account.move` write / unlink / create, `res.partner` create.
- **NOT denied:** `message_post`. `mail.message` is `[RWCU]` to `Role / User`, so **any
  internal user who can read an invoice can post a note on it.** Do not claim otherwise
  in any artefact. The agent still cannot write: its tool grant excludes posting,
  publication is the checked script, and its allowlist reaches one host.

Do not probe permissions by writing to `account.move` — automations #10/#11/#12 fire
`on_write` and post the false "paid" notes.

---

## Design in one paragraph

**The script is the agent; the model is optional polish.** The deterministic run reads the
ledger and computes the whole report — position per currency, ranked list, the one that
matters, spot-checks, the false-note flag, exclusions — in ~13s with no model involved. A
local model may add two or three sentences of framing; if it is slow, busy, deadlined or
absent, **the report publishes anyway** and says the note was skipped. Publication belongs
to the script, never the model: the model's sentences are an *input*, checked by
`numeric-traceability.js` and discarded if any figure is not traceable to what the model
was handed.

Ollama (`66.118.37.12:11434`) is **shared with live production**. We yield: a 5s probe,
and if it does not answer we skip the prose rather than queue behind it. Measured: a
two-character codex reply took **3m30s** cold on that box.

## Operations

```bash
# run now (respects the kill switch and one-output-per-day)
sudo systemctl start isola-ar-run.service

# stop it for good, from the owner's side: pause the agent in Paperclip.
# The runner checks agent status and refuses; it fails CLOSED if Paperclip
# is unreachable.

# see what it did
journalctl -u isola-ar-run.service -n 50

# dry run, publishes nothing
CID=$(sudo docker ps -q --filter name=isola_ai | head -1)
sudo docker exec -u node -e AR_DRY_RUN=1 \
  -e AGENT_INSTRUCTIONS_DIR=/paperclip/instances/default/companies/3ed3869b-463c-4876-8e16-ddc058f06cd9/agents/2b4cf82a-00d5-496b-877e-b5bc9201d52c/instructions \
  "$CID" node /paperclip/bin/ar-run.js
```

## Exit codes — what a red unit means

| exit | meaning | did the owner get his list? |
|---|---|---|
| 0 | ran, or correctly declined (weekend / already published today / agent paused) | yes, or nothing was due |
| **3** | **the traceability gate fired** — the model produced an untraceable figure | **yes.** The figures are computed, not generated; the prose was discarded |
| 1 | the run failed (Odoo unreachable, etc.) | no — see the log for the named next action |

Exit 3 is deliberate: publication is never blocked on the model, but a run where the
guard fired must not look clean to monitoring. If it recurs, the model is too small for
the rendering task — report it rather than lowering the check.

## Tuning it

Edit **`AGENTS.md`** in Paperclip (the agent's instructions bundle). The ```` ```epic-config ````
block is parsed on the next run — `actionListLength`, `spotCheckCount`, `proseDeadlineMs`,
`ollamaProbeMs`, `ollamaModel`, `skipProseWhenBusy`. Unknown keys are ignored, never
guessed at, and prose is never read as configuration. Verified 2026-08-14: changing
`actionListLength` 10 → 3 produced a three-row list on the next run.

## Known traps

- **A ufw rule on deepseek can vanish on reboot** — `ufw status` still lists it while
  `iptables -S` does not, and the symptom is indistinguishable from "Ollama is busy".
  Check `sudo iptables -S | grep 66.118.37.110`; re-apply by rule spec, never by line
  number. The design tolerates this: no Ollama means no prose, not a failed run.
- **`isola_ai` restart policy is `on-failure`**, not Gate C's `any`. A *clean* exit will
  not be restarted. A reboot restarts it (unclean kill), which is why 2026-08-14's reboot
  recovered on its own.
- `secrets/` on the volume is `0700 node`, key files `0400`. Only the *path* to a
  credential ever appears in Paperclip config — never a value.
