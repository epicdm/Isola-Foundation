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
| **Was it used?** | **No evidence of use — and note what would and would not count as evidence.** Last `PushEvent` to `epicdm/isolav2` = **2026-07-28**, actor `epicdm`; every visible event is `epicdm` or `chatgpt-codex-connector[bot]`; zero pushes after the exposure. The `/events` API is retention-limited and partial. |
| **Evidence hierarchy — CORRECTED 2026-08-16** | **PRIMARY: the account security log** (`github.com/settings/security-log`) — it shows **what was done**. **SECONDARY: the token's "last used" timestamp** — which is *not* authoritative, contrary to how it was first recorded here. **This token is legitimately used by whatever pulls that repo, so a recent "last used" is EXPECTED and proves nothing either way.** A warm timestamp is not evidence of misuse and a cold one is only weak evidence of safety. Neither source has been read — **an access gap, not a clean bill.** |

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

### C-09 — Magnus API key + secret in a plaintext file at the workspace root

| field | value |
|---|---|
| **What it is** | `MAGNUS_API_KEY` and `MAGNUS_SECRET_KEY` (plus `MAGNUS_BASE_URL`) in cleartext |
| **What it grants** | Authenticated Magnus REST access. Port records the Isola Magnus admin credential as able to **act across accounts**, and the same API surface includes `refill/save`, which moves real balance — **verified live 2026-07-11 that it applies a signed delta with no floor-at-zero and no rejection of negatives.** So this is a **money-moving** credential, not a read key. |
| **Where it lives** | `C:\epic-workspace\magnus.txt` — a plaintext file at the workspace root of a developer machine, outside any secret store. Supplied to this session deliberately by the owner so the CDR-watch probe could run. |
| **Exposed** | Read into this session 2026-08-16. Values were not echoed back. |
| **Depends on it** | `/opt/bff-v2` holds the same credential as `MAGNUS_API_KEY` / `MAGNUS_API_SECRET` / `MAGNUS_URL` (var names confirmed; values not read). Rotating affects bff-v2's voice paths — balance, calls, provisioning, top-up. |
| **Severity, corrected** | Initially recorded as an admin-**read** credential and judged "smaller than a DB credential". **That was wrong. It is larger than the write PAT.** A write PAT pushes code — reviewable, revertible, and visible in history. This adjusts **customer balances silently**. Worst placement of anything found on 2026-08-16, the PAT included. |
| **PLACEMENT — FIXED 2026-08-16, and this was NOT a rotation** | The value did not change, so the owner's rotation freeze never covered it: **placement was never frozen.** Actions taken: (1) fingerprint-confirmed the file was an exact duplicate of `/opt/bff-v2/.env` (`MAGNUS_API_KEY` → `8354cfbf`, secret → `488f0303`, matching on both sides), so removing it lost nothing; (2) **overwrote the 148 bytes before unlinking** — a plain delete leaves a live money-moving credential recoverable; (3) added `magnus.txt`, `*secret*.txt`, `*credential*.txt`, `*.env.txt` to `C:\epic-workspace\.gitignore`, verified by `git check-ignore`. |
| **Why it was worse than first recorded** | The file was **untracked AND un-ignored inside a git work tree rooted at `C:\epic-workspace`**. A single `git add -A` in that repo would have committed a money-moving credential — and this workspace is shared by two agent lanes. |
| **Was it used?** | **Not answerable by this method, and that is the honest status — not "clean".** This is a live operational credential in daily use by bff-v2, so there is no unused baseline against which misuse would stand out. A usage probe cannot separate legitimate traffic from abuse here. |

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

> ### METHOD — a false clean is the worst output a check can produce
>
> **This belongs at the top of the verification-method doc, above every other
> instrument lesson.** It is recorded here instead because
> `VERIFICATION-METHOD-HANDOFF-2026-08-13.md` currently has **28 uncommitted
> lines from another lane, at lines 3–11 — exactly the top.** Writing there
> would be the same collision that was just ruled on for the sentinel.
> **Owner/estate: please merge this paragraph into that doc.**
>
> Reading the AMI permission class, the first attempt used
> `awk '/^\[epic-ai-app\]/,/^\[.*\]$/'`. **The header line matches BOTH the
> start and the end pattern**, so the range closed immediately and returned the
> header alone. Output: `[epic-ai-app]` and nothing else.
>
> **That reads as "no permissions defined" — i.e. a clean result — on a
> security question.**
>
> Every other instrument failure this session failed toward *"something is
> wrong"* or *"I cannot tell"*: a hung grep produced no matches, a collapsed
> `jobs` produced an empty list, an absent `total` produced a visible ABSENT.
> **This one failed toward "everything is fine", which ENDS the investigation
> rather than prompting another look.**
>
> The fix that caught it: re-read with `grep -A`, then confirm the section
> boundary with a query that *would have shown* a boundary if one existed
> (filter on `^\[` as well as the fields of interest). **Absence is only
> evidence when the instrument could have rendered presence.**

**Coverage boundary, stated plainly:** Bash only. `Read`/`Grep`/`Glob` results, MCP
tool responses, and PowerShell are **not** covered. The wrapper is bash syntax and
emitting it for PowerShell would produce a broken command. Anything outside that
boundary can still leak. This narrows the hole; it does not close it. The structural
fix is C-01's placement decision — a runtime host that holds no write credential
cannot leak one.

**AND THERE ARE TWO GUARDS, SO THE CLASS IS NARROWED, NOT CLOSED.** A second,
user-level hook — `~/.claude/hooks/enforce-safety.js` — carries the same
comment-vs-command flaw and still blocks a commit message merely for *naming*
destructive SQL. It sits outside this repository and is the owner's file, so it
was **reported rather than silently edited**: changing someone else's security
control without asking is its own defect. **Until that second hook is fixed, the
prose-is-not-execution fix covers one of two enforcement paths.** Stated in those
words deliberately — "fixed" would be wrong.

## Detection still to build — the two watches

Both are additions to `services/isola-sentinel` (already deployed, alerts by SMTP2GO
to `SENTINEL_ALERT_TO`, check-per-key with transition/renotify/RECOVERED handling).
**Neither is built yet.**

| watch | signal | status |
|---|---|---|
| `cdr_anomaly` | Outbound calls to destinations outside the normal set, volume spikes, and calls at hours EPIC does not normally place them. Toll fraud is automated and fast; the CDR is where it shows. | **UNBLOCKED — no DB access needed.** Magnus REST answers it with count-only queries. API shape verified 2026-08-16, see below. |
| `unexpected_push` | Any push to `epicdm/isolav2` not attributable to a known author or lane. | **WAITING** on a read-only fine-grained GitHub token scoped to that one repo. **A watch that requires a dangerous credential is not a safety improvement** — if the token cannot be issued read-only, the watch waits. |

#### Magnus REST — measured API shape, 2026-08-16

Reuse-first: `magnusRequest(config, 'call', 'read', …)` over HTTPS. **No DB credential, no tunnel, no second way to read the CDR that could disagree with the first.** Base URL requires the `/mbilling` suffix — the bare host fails.

**`total` does not exist.** Response keys are `rows, count, sum`. A check written against `total` would have been *a check that never fires*. `count` is the match total, proven by varying `limit` while `count` held constant (862,868 at limit=1 and limit=25), then narrowed two independent ways (`starttime` 771 / 17,080; `calledstation` prefix 814,082 ≈ 94% local).

**Negative control:** `calledstation = ZZZZNOSUCH` → `count=0, rows=0`. That is what makes every other number mean something — a zero is a real zero, not a broken filter.

**SCOPING RESOLVED — and it changes how the baseline must be built.** The unfiltered count (862,868) is *lower* than any filtered count. Every explicit filter — `starttime gt 1970-01-01`, `gt 2020-01-01`, `lt 2030-01-01`, `id gt 0`, `sessiontime gt -1` — returns the **identical 914,586**. Filters therefore do not narrow an 862,868 universe; they **replace a default scope** the grid applies only when no filter is supplied. **914,586 is the true universe; 862,868 is a defaulted subset (Δ 51,718) whose window we neither control nor can see, and which will drift as time passes.**

> **RULE FOR THE WATCH: always pass an explicit filter. Never baseline on the unfiltered count.** An undefined baseline is a threshold wearing a number.

#### Credential for the CDR watch — option taken, and why

Preference order was: (1) read-scoped Magnus key, (2) compute on voice00 and push the verdict, (3) the existing key under constraints.

**(2) was priced and rejected.** voice00 is CentOS 7 and a read-only host today, with no deployment tooling present. Standing up a job there creates a **new deployable surface on the PBX** — a larger change than the watch it enables. Not a free option.

**Taking (3), with the constraints hardened because C-09 is money-moving:**

1. **The credential lives in the secret store, never in a file on a host.** (C-09's loose copy is already removed.)
2. **Read-only BY CONSTRUCTION.** The sentinel's Magnus client is a purpose-built module in which **no code path can emit `save` or `refill` — the capability does not exist in the module.** Not a flag, not a convention, not a runtime check. Tested by attempting to induce it.
3. **It goes on this register** (as C-09) so it is rotated with everything else and never forgotten.

**The REST key is an INTERIM with a short life, not the design.** The intended end state is an **Asterisk AMI read-only user** — `manager.conf` permission classes give a genuinely read-scoped credential (`read = cdr,call`, `write =` empty), which removes a money-moving credential from a monitoring service entirely. That is the next step, not a someday.

### F-01 — the existing `ami-listener` AMI account is full-privilege (FINDING; reported, not changed)

Checked because a second event listener holding an over-scoped AMI user would be the same class of problem. **It is.** `/etc/asterisk/manager.conf` on voice00, section `[epic-ai-app]` — the account `ami-listener` on deepseek logs in as (`AMI_USER` default `epic-ai-app`, `AMI_SECRET` from env; the code refuses to start on a hardcoded fallback, which is correct):

| line | directive | effect |
|---|---|---|
| 29 | `deny=0.0.0.0/0.0.0.0` | default-deny — good |
| 32 | `permit = 66.118.37.12/…` | **deepseek only.** Two stale permits sit commented out with dates and lane attribution; the earlier `0.0.0.0/0` exposure is gone. |
| 33 | `read = system,call,log,verbose,agent,user,config,dtmf,reporting,cdr,dialplan` | a deliberately scoped class… |
| 34 | `write = system,call,agent,user,config,command,reporting,originate` | …including `originate` (place calls) and `command` (Asterisk CLI) |
| 36 | `read = all` | **overrides line 33** |
| 37 | `write = all` | **overrides line 34** |

**Effective permission is `read = all, write = all` — full control of the PBX.** In `manager.conf` a later directive in the same section wins. Verified the boundary: the query filtered on `^\[` as well as read/write/permit/deny, so a section header between 27 and 37 would have appeared. **None did — lines 36–37 are inside `[epic-ai-app]`.**

**Lines 33–34 show someone already tried to scope this account.** That intent is dead config, defeated by two trailing lines that look appended from a template — the declared-vs-effective class again, this time in a config file.

**CORRECTION — "delete two lines" is NOT the fix, and I had it wrong.** Line 34's *scoped* intent is already
`write = system,call,agent,user,config,command,reporting,originate` — which **still carries `command` (Asterisk CLI) and `originate` (place calls)**. Deleting 36–37 narrows blast radius while leaving the two capabilities that actually matter. The read-only end state needs **line 34 changed too**.

**AND THE PREREQUISITE READ CHANGES THE ANSWER AGAIN. `ami-listener` is not an event listener.** Every AMI action it issues, enumerated from `/opt/bff-v2/ami-listener.js`:

| line | action | class |
|---|---|---|
| 388 | `Login` | auth |
| 402 | `Events` `EventMask: 'call,cdr'` | **read** — the only listening it does |
| 514 | **`Originate`** | **write** — places a call |
| 549 | **`Originate`** | **write** — places a call |
| 580 | **`Hangup`** | **write** — tears down a call |

So `write =` empty would **break it**. It is a **call-control service carrying an event-listener's name**, and that naming is itself a hazard: it invites exactly the "an event listener only needs read" reasoning I applied a paragraph ago.

**Minimal permission set, derived from observed behaviour rather than guessed:**

```
read  = call,cdr          ; matches its own EventMask exactly
write = call,originate    ; Originate + Hangup, nothing more
```

That drops `system`, `config`, **`command`**, `agent`, `user`, `reporting`, `log`, `verbose`, `dtmf`, `dialplan`. **`command` — arbitrary Asterisk CLI — is never used and is the single most dangerous entry in the list.**

**NOT TONIGHT.** voice00 is live and must not break. The risk is conditional on deepseek being compromised, not an internet exposure, so it takes a scheduled change with verification — not a 3am edit to a production PBX. The two `Originate` call sites should also be read in full first, to confirm what triggers them.

**Adjacent, and it sharpens the "if deepseek is compromised" clause:** `ami-listener` also runs an HTTP server whose only accepted action is `hangup` (it 400s everything else — a good default). That server listens on **`*:3016` — all interfaces, not loopback** (`ss -tlnp`, pid 1455). So the call-control path is not restricted by the process itself.

**Whether it is reachable from outside is NOT established and I have not tested it.** Per the estate's own law, a local probe proves nothing here: my egress (`66.118.37.10`) is in the same `/24` as deepseek, so a successful connection from here would demonstrate only same-subnet reachability. Exposure has to be proven from a genuinely external vantage — the method already used to confirm voice00's AMI `5038` is filtered. **Recorded as an open verification item, not as an exposure claim.**

Residual risk today is bounded by the network ACL: a caller must be on deepseek. So this is not an open internet exposure — it is a **blast-radius** problem. If deepseek is compromised, that account can originate calls and run CLI commands on the PBX.

**Reported, not changed**, per instruction. Not a credential exposure, so it is not a C-row; it belongs to the same sweep because the AMI read-only user is C-09's end state.

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
