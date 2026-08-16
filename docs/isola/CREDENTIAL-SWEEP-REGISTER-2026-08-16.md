# Credential sweep register — opened 2026-08-16

**Status: OPEN. Nothing in this file has been rotated.**

Owner ruling, 2026-08-16, recorded not argued: **all compromised secrets rotate in
one sweep, as the last thing before go-live.** Not piecemeal, not mid-build.
Rotating during the build makes every subsequent failure ambiguous — was it the
change, or the rotation? One sweep is one verification pass instead of a dozen.

**This register is the control that makes that deferral safe.** A deferred risk is
only managed if something is watching it, and only executable if the sweep knows
every location and what breaks. Memory is not a plan.

Two things follow from the deferral and are recorded here so nobody decides them
under pressure:

> **THE ONE-WAY DOOR.** If a detection fires — evidence that any credential in this
> register has been **used** — the deferral ends automatically for that credential.
> A credential that has been used is not a compromised secret awaiting a sweep; it
> is an **active incident**, rotated immediately, mid-build, whatever is in flight.

> **PLACEMENT, NOT JUST REISSUE.** Every row carries a placement decision. Minting a
> new value into the same bad location leaves the class intact and we repeat this in
> three months. The placement column is the part that must survive.

---

## Register

### C-01 — GitHub PAT embedded in a runtime host's git remote

| field | value |
|---|---|
| **What it is** | A GitHub Personal Access Token, `github_pat_…`, for `epicdm/isolav2` |
| **What it grants** | **Write** (push) to the repository. Scope beyond push not enumerated — see open question below. |
| **Where it lives** | `/opt/lk-voice-agent/.git/config` on deepseek (66.118.37.12), cleartext, inside the `origin` remote URL |
| **Exposed** | 2026-08-16, by me, running `git remote -v` during the voice inventory. The value was printed into a session transcript. |
| **Why the guard missed it** | `isola-guard` inspected command *text*; `git remote -v` does not look like a secret read. **Closed 2026-08-16** — see "Detection already in place". |
| **Depends on it** | Nothing at runtime. `lk-voice-agent` is a **deployed checkout that only ever needs to pull**. Verified: blast radius is one — of `/opt/bff-v2`, `/opt/isola-runtime`, `/opt/lk-voice-agent`, `/opt/hermes-eric`, `/home/epicdm/hermes-workspace`, only this one embeds a credential in its remote. |
| **PLACEMENT DECISION** | **Do not mint a replacement PAT into `.git/config`.** Replace with a **read-only deploy key** scoped to `epicdm/isolav2`, held as an SSH key with the remote rewritten to the `git@github.com:` form. **A running host never needs push access.** If any lane genuinely needs to push from that host, it does so from a worktree with the operator's own credential, not from the live checkout. |
| **Was it used?** | **No evidence of use.** Last `PushEvent` to `epicdm/isolav2` = **2026-07-28**, actor `epicdm`. Every event in the visible window is `epicdm` or `chatgpt-codex-connector[bot]`. Zero pushes after the 2026-08-16 exposure. *Caveat, stated honestly:* the `/events` API is a partial view (retention-limited, not a complete audit). The authoritative sources are the org audit log and the token's own "last used" timestamp in GitHub settings — **neither has been checked; that is an access gap, not a clean bill.** |

### C-02 — SIP peer secret, `livekittestagen_9666`

| field | value |
|---|---|
| **What it is** | Plaintext Asterisk SIP peer password |
| **What it grants** | SIP registration as that peer on voice00 → ability to place calls billed to account `org_epiccommun_w65xx` (**toll-fraud exposure**) |
| **Where it lives** | `/etc/asterisk/sip_magnus_user.conf` on voice00 (157.245.83.64), plaintext `secret=` line. Peer maps to billing user id 1290. |
| **Exposed** | 2026-08-16, by me, via a `sed` line-range read of the config during the LiveKit trunk trace |
| **Why the guard missed it** | `SECRET_DUMP_RE` knew `cat/head/tail/less` but **not `sed`/`awk`/`grep`**, and the file is not `.env`-shaped. **Closed 2026-08-16.** |
| **Depends on it** | The LiveKit SIP trunk peering for the demo DID `17678189666`. Rotating it affects only that peer. Nothing customer-facing — see the traffic evidence below. |
| **PLACEMENT DECISION** | Rotate the value **and** re-evaluate whether this peer should exist at all. It is one of five demo DIDs with no traffic since 2026-05-26. **A credential for a demo rig is best retired, not reissued.** Decide retire-vs-rotate at sweep time; default is retire. |
| **Was it used?** | **No. Zero calls, ever.** `pkg_cdr` for user 1290 = 0 rows, `last_call` NULL. **Positive control in the same query**: `Reboot_Office` returned 22,724 calls, last 2026-08-15 15:43 — so the instrument was working and the zero is real, not an empty join. Daily estate volume 2026-08-09→16 stayed in its normal 693–1,344 band with no spike. |

### C-03 — SIP peer secret, `siptestagent_9999`

| field | value |
|---|---|
| **What it is** | Plaintext Asterisk SIP peer password |
| **What it grants** | SIP registration as that peer → billable call origination (toll-fraud exposure) |
| **Where it lives** | `/etc/asterisk/sip_magnus_user.conf` on voice00, plaintext. Billing user id 1292. |
| **Exposed** | 2026-08-16, same read as C-02 |
| **Depends on it** | Nothing identified. Named as a test agent. |
| **PLACEMENT DECISION** | **Retire the peer.** A test credential on a production PBX with call-origination rights is the wrong object to own. If a test peer is genuinely needed, it belongs on a non-billing account with an outbound route restricted to a test destination. |
| **Was it used?** | **No. Zero calls, ever** (0 rows, NULL), against the same working positive control as C-02. |

### C-04 — Paperclip runtime bearer (`rtp_…`), front-desk agent — **IDENTIFIED**

| field | value |
|---|---|
| **What it is** | The front-desk agent's **Paperclip runtime bearer token**. Appears as `adapter.config.headers.Authorization: "Bearer rtp_…"`. |
| **What it grants** | Authenticates adapter invocation for that agent, **bound to the PUBLIC exposure class**. Per the template's own comment the PUBLIC bearer cannot invoke the INTERNAL template and vice versa, so it is exposure-class-scoped rather than estate-wide. Described by the exposing lane as the secret "for the old runtime" — **whether it is still live is unconfirmed and must be checked at sweep time, not assumed dead.** |
| **Where it lives** | The **provisioned (live)** `.paperclip.yaml` for the front-desk agent. **NOT in git** — verified 2026-08-16: both committed templates (`isola-ai-sales-front-desk-agent/v1`, `epic-staff-operations-coordinator/v1`) contain only the comment *"url and headers.Authorization injected at provision time"*. The repo is clean. |
| **Exposed** | By the **estate lane**, earlier in the same session, and **disclosed immediately by that lane**. Their first export script redacted secret-ish keys; the follow-up dumped `.paperclip.yaml` **raw**. Carried in that lane's own notes as "exposed and unrotated — rotate tomorrow, on its own". |
| **Why the repo search found nothing** | It was never in the repo. My initial search was scoped to this checkout and could not have found it — recorded here because "searched and found nothing" and "searched the wrong place" produce identical output. |
| **PLACEMENT DECISION** | **No placement change. The placement is already correct** — injected at provision time from the approved secret store, never committed. This is the one row where the failure was **not** where the secret lived but **how the live file was read**. Rotate the value; change nothing structural. |
| **Control added** | The read discipline is now enforced rather than remembered: `CREDENTIAL_SURFACE_RE` covers `.ya?ml` with the full reader set, so a raw read of a provisioned `.paperclip.yaml` is rewritten through the redactor. Verified — `Authorization: "Bearer rtp_…"` → `Authorization: "Bearer [REDACTED:bearer]"`. Nothing else would have caught it: a provisioned yaml is not `SECRET_FILE`-shaped and the committed template is clean. |
| **Was it used?** | **Not checked.** Unlike C-01/C-02/C-03 I have run no usage probe for this token. Doing so needs the Paperclip request log or equivalent. **Recorded as an open question, not as a negative.** |

### Carried forward — already-known items that belong in the same sweep

These are recorded in Port and must not be re-derived at sweep time. **I have not
re-verified their current state in this session** — each is marked with its source.

| id | item | state per Port | placement decision needed |
|---|---|---|---|
| C-05 | Estate-shared `webhook_verify_token` | Deliberately **not** rotated in the 2026-08-05 Meta incident. ~30 locations / 9 WABAs, and equal to a literal already committed in bff-v2 source. | Rotating for one inbox closes nothing and risks unsubscribing inbound on a live number via a failed Meta re-verification. **Must be a single coordinated estate-wide change, and it is the highest-coupling item in this register.** |
| C-06 | Two dead legacy values still in `/opt/bff-v2/.env` (`META_SYSTEM_TOKEN`, `WHATSAPP_TOKEN`) | Now invalid (Graph code 190). Three bff-v2 routes read `META_SYSTEM_TOKEN` *before* `META_WA_TOKEN` and will fail on next invocation. | **Remove the dead keys** rather than replace them. This is latent breakage, not exposure — but it is cheapest to fix in the same sweep. |
| C-07 | Traefik `acme.json` production TLS private keys | Two production keys were read into a transcript (recorded in memory as a standing never-grep rule). | TLS key rotation = certificate reissue. Needs its own sequencing; **do not bundle blindly into a single-shot sweep** without confirming reissue does not interrupt live TLS. |
| C-08 | `bff-v2-staging` / `bff-v2-native-test` `CLAWITH_INTERNAL_SECRET` | `.env` rotated 2026-07-22; the pm2 processes were never relaunched, so the **old values may still be live in memory**. Blocked on a sanctioned restart mechanism. | Resolve the restart path as part of the sweep — a rotated file with a stale process is a rotation that did not happen. |

---

## Detection already in place — what replaced rotation tonight

**Guard fix — shipped 2026-08-16, not deferred.** Fixing `isola-guard` is not a
rotation, so it did not fall under the ruling.

The owner's instruction was to move the guard from inspecting commands to filtering
output. **That exact mechanism does not exist**, and I verified it against the Claude
Code hooks reference rather than assuming: `PostToolUse` fires after the tool has run
and has no field that rewrites, replaces or suppresses the result (`suppressOutput`
is accepted and ignored); no hook event anywhere filters tool output. Building an
output filter on top of that would have been a control that does nothing.

What *is* possible is `PreToolUse` → `updatedInput`. So the guard now **rewrites**
commands that touch credential-bearing surfaces to pipe their own output through
`.claude/hooks/lib/secret-redact.js`. Reads are still allowed — denying them pushes
the same read into an unguarded shape — but the credential cannot reach the
transcript.

Proven, not asserted:
- 19/19 unit tests, including the two real exposure shapes with fake values
- **Live before/after on the real credentials**: `git remote -v` on deepseek now
  returns `https://epicdm:[REDACTED:url-password]@github.com/epicdm/isolav2.git`,
  and the SIP block returns `secret=[REDACTED:secret]` with every diagnostic field
  (`accountcode`, `host`, `context`, codecs) still readable
- Guard selftest **63/63** (was 59; +4 including two negative controls proving
  ordinary commands and PowerShell are *not* rewritten)

**Coverage boundary, stated plainly:** Bash only. `Read`/`Grep`/`Glob` results, MCP
tool responses, and PowerShell are **not** covered. The wrapper is bash syntax and
emitting it for PowerShell would produce a broken command. Anything outside that
boundary can still leak. This narrows the hole; it does not close it. The structural
fix is C-01's placement decision — a runtime host that holds no write credential
cannot leak one.

## Detection still to build — the two watches

Both are additions to `services/isola-sentinel` (already deployed, alerts by SMTP2GO
to `SENTINEL_ALERT_TO`, check-per-key with transition/renotify/RECOVERED handling).
**Neither is built yet.**

| watch | signal | gate before building |
|---|---|---|
| `cdr_anomaly` | Outbound calls to destinations outside the normal set, volume spikes, and calls at hours EPIC does not normally place them. Toll fraud is automated and fast; the CDR is where it shows. | The sentinel runs on **host03**; the CDR lives in `mbilling` on **voice00**. Reachability and a read-only DB credential are unproven. |
| `unexpected_push` | Any push to `epicdm/isolav2` not attributable to a known author or lane. The PAT has write access; this is the only signal that would show it being used. | Needs a GitHub credential the sentinel can hold — **which must not be another write-capable PAT**, or the watch becomes the next C-01. |

Both gates exist because of the sentinel's own rule, which applies to its author too:

> **"A check that can never pass is worse than no check"** — it trains the reader to
> ignore the mail, and then a real alert arrives into a habit of ignoring.

So each watch gets its reachability proven and is **fired on purpose once** before it
is believed — the same discipline that caught the SMTP2GO API-key format problem by
sending a real alert and reading the 403.

---

## Sweep execution — the order, when it runs

1. Complete **C-04** (owner identifies the token) and re-verify C-05…C-08 current state.
2. Take the estate baseline: which process holds which value, so "did it break" is answerable.
3. Rotate **by placement decision, not by reissue** — C-01 becomes a deploy key, C-02/C-03 are retired by default.
4. **Restart every process that reads a rotated value.** C-08 is the standing proof that a rotated file with a stale process is not a rotation.
5. Verify each: new value accepted, **old value refused** (the control that makes the rotation real), neighbouring state unchanged.
6. Record the result in Port and close the register.

**Nothing in step 3 happens before go-live. Nothing in "Detection" waits for it.**
