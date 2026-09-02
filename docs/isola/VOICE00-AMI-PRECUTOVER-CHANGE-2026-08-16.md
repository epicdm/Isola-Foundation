# voice00 AMI — PRE-CUTOVER CHANGE (PREPARED, NOT RUN)

**Owner-authorised production write on a LIVE PBX. A scheduled pre-cutover step with its
own date — NOT cutover night.**

**Purpose:** allow `ami-listener` to run on host03 (66.118.37.110).

---

## WHY THIS IS FOUR STEPS AND NOT TWO EDITS

AMI is guarded by **two independent controls**, both scoped to deepseek `/32` today:

| layer | control | current |
|---|---|---|
| network | `iptables` on voice00, `-P INPUT DROP` | `ACCEPT` 5038 from `127.0.0.1/32` and `66.118.37.12/32` only |
| application | `/etc/asterisk/manager.conf` `[epic-ai-app]` | `deny 0.0.0.0/0` + `permit = 66.118.37.12/32` |

**Changing only one produces a symptom that indicts the change you just made correctly.**
If `manager.conf` were fixed alone, `ami-listener` on host03 would still fail — refused at
the network, before AMI ever sees a login — and the debugger's first suspect is always the
most recent change, sending the investigation *away* from the real gate at full speed.

**So they are opened ONE AT A TIME, and the intermediate state is the point.** It is the
only moment at which the two controls are distinguishable, and it cannot be bought later.

Measured baseline (each vantage carried a known-open control on 22 and a known-closed
control on 5039, so `filtered` is a finding and not a broken probe):

| source | 22 | **5038** | 5039 |
|---|---|---|---|
| workstation 66.118.37.10 | CONNECTED | **filtered** | filtered |
| deepseek 66.118.37.12 | CONNECTED | **CONNECTED** | filtered |
| host03 66.118.37.110 | CONNECTED | **filtered** | filtered |

IPv6: voice00 has **no AAAA record**. The v6 half is **n/a — proven not to apply**, not
skipped.

---

## STEP 0 — POSITIVE CONTROL, BEFORE ANYTHING

```bash
sudo asterisk -rx "core show channels count"
sudo asterisk -rx "manager show connected"     # deepseek's ami-listener should appear
```
**A real call must complete, confirmed with the owner, BEFORE the first change.**
"Calls are broken" found after an edit is indistinguishable from "calls were already
broken" without this. **If a call does not complete now, STOP.**

---

## STEP 1 — NETWORK GATE ONLY. Nothing else in this step.

Different rollback unit (a rule, not a file). No Asterisk reload. No effect on call
handling. Deliberately **not** batched with STEP 3.

```bash
sudo cp -p /etc/sysconfig/iptables /etc/sysconfig/iptables.bak-precutover-2026-08-16

sudo iptables -I INPUT -s 66.118.37.110/32 -p tcp --dport 5038 -j ACCEPT

# PERSIST IT — MANDATORY, NOT OPTIONAL.
# Persistence here is healthy and CURRENTLY MATCHES the running set (verified
# 2026-08-16: saved 29 INPUT rules == running 29, filter policy DROP both). Adding a
# live rule without saving creates the one hazard worse than no persistence at all:
# A MECHANISM THAT EXISTS AND IS STALE, which on the next reboot will CONFIDENTLY
# RESTORE THE OLD FIREWALL and drop host03 months later, with no recent change to blame.
sudo service iptables save

# VERIFY BOTH HALVES AGREE AGAIN
sudo iptables -S INPUT | grep 5038          # expect THREE rules now
sudo grep 5038 /etc/sysconfig/iptables      # expect the SAME THREE
```

---

## STEP 2 — THE DISAMBIGUATING OBSERVATION. This is why the steps are separate.

Run from **host03**:

```bash
timeout 5 bash -c 'exec 3<>/dev/tcp/157.245.83.64/5038' && echo TCP-CONNECTED || echo FILTERED
timeout 5 bash -c 'exec 3<>/dev/tcp/157.245.83.64/5039' && echo OPEN-UNEXPECTED || echo refused   # control
```

**EXPECTED INTERMEDIATE STATE — record it, it exists only between STEP 1 and STEP 3:**

> **5038 moves from `filtered` to TCP-CONNECTED, and AMI then refuses the login.**

That single observation proves **both gates independently**: the network gate is now open,
and the application gate is real and still closed. If 5038 is still `filtered`, the
iptables change did not take — and you know that *before* touching the PBX config.

Also confirm the change was **scoped, not general** — from the workstation, 5038 must
STILL be filtered:
```bash
timeout 5 bash -c 'exec 3<>/dev/tcp/157.245.83.64/5038' && echo LEAKED-STOP || echo still-filtered
```

---

## STEP 3 — APPLICATION GATE. Both file edits batched, one reload.

These *do* batch: one file, one rollback unit, and failure is loud and immediate —
Asterisk reloads and calls complete, or they do not.

```bash
sudo cp -p /etc/asterisk/manager.conf /etc/asterisk/manager.conf.bak-precutover-2026-08-16
```

```
[epic-ai-app]
  deny   = 0.0.0.0/0.0.0.0
  permit = 66.118.37.12/255.255.255.255       ← KEEP until cutover proves
+ permit = 66.118.37.110/255.255.255.255      ← ADD (host03)
```
Plus the separately-scheduled **line-34** edit, in the same pass.

```bash
sudo asterisk -rx "manager reload"
sudo asterisk -rx "core show channels count"    # a call must still complete
```

**F-01 (this account is effectively full-privilege) rides along ONLY IF the required
privilege set is already known.** If right-sizing needs discovering which classes
`ami-listener` actually uses, it does **not** ride along — it goes to the scheduled
right-sizing day. Do not turn a two-line change into an open investigation on a live PBX.

`[magnus]` is loopback-only (`permit=127.0.0.1`) and is not touched.

---

## STEP 4 — THIRD CONFIRMATION: a successful AMI login from host03

No login is attempted before this point, deliberately: **fail2ban is running on voice00**
(jails `freeswitch`, `sshd`), and a failed AMI auth writes to the security log. Risking a
ban on host03 to prove something the network probe already answers is a bad trade.

---

## ROLLBACK

```bash
# application gate
sudo cp -p /etc/asterisk/manager.conf.bak-precutover-2026-08-16 /etc/asterisk/manager.conf
sudo asterisk -rx "manager reload"

# network gate — remove AND re-save, or the reboot resurrects it
sudo iptables -D INPUT -s 66.118.37.110/32 -p tcp --dport 5038 -j ACCEPT
sudo service iptables save

sudo asterisk -rx "core show channels count"    # a call must still complete
```

---

## AFTER CUTOVER PROVES (separate, later)

Remove deepseek from **both** gates — the `permit = 66.118.37.12` line and the iptables
ACCEPT — and `service iptables save` again. **Not before.** Nothing is closed until its
replacement is proven.

---

## NOTE ON NAMING

Agents are referenced **by UUID, never by name**. The host03 Paperclip contains an agent
named `RETIRED - do not use (was: EPIC Front Desk (Production))` whose description is
nearly identical to the live one. The live front desk is **`fd2867d1-ee43-4032-a1cc-52eb3379a581`**.
A name is a label someone edits; a UUID is the thing.
