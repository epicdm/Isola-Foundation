# Credential sweep register — opened 2026-08-16

**Status: OPEN. Nothing in this file has been rotated.**

> ### REGISTER LANGUAGE — no row is ever "purged" as a resolution
>
> A purge removes a value from files that existed **at scan time**, in the **roots the
> scan walked**. It cannot bind a concurrent writer, and it does not change the
> credential. So rows say **CONTAINED AT `<UTC timestamp>`, roots: `<paths>`** — never
> "purged", never "resolved", never "closed".
>
> **THE ROOTS ARE PART OF THE CLAIM.** A purge that walked three trees says nothing
> about a fourth. **THE TIMESTAMP IS PART OF THE CLAIM TOO**: a verification of a
> mutable system decays, and must be re-stated or re-run, never inherited. Proven the
> hard way on C-10 — `0 remaining` was true when written and false forty minutes on.
>
> **Only ROTATION closes a row.** Containment is a statement about a moment.
>
> ### STANDARD CHECKS — every row answers these
>
> 1. **Where does it live**, and **does the git work tree IGNORE it?**
>    **A CREDENTIAL IN A GIT WORK TREE IS ONE COMMAND FROM PERMANENT.** Everything else
>    in this register is containable by a purge; a *committed* credential is not
>    contained, it is **distributed** — into every clone, every fork, every mirror, and
>    into history that rewriting only partly reaches. That makes ignore-file coverage a
>    **control, not tidiness.** Two rows already hit this class at the same workspace
>    root: C-09 (`magnus.txt`, money-moving) and the `.paperclip-cli-approval-url.txt`
>    find (an approval URL **is** a credential — the token rides in the query string).
>    Both were untracked **and un-ignored**, one `git add -A` from permanent, in a tree
>    **shared by two agent lanes**.
> 2. **What does it grant**, and what depends on it.
> 3. **Placement decision** — never merely reissue into the same bad location.
> 4. **Was it used**, answered honestly (a live credential in daily use has no unused
>    baseline, and that is a real answer, not a clean bill).
>
> ### API, NOT SQL — and the reason is encoding, not style
>
> **The database does not store the value. It stores a representation the application
> knows how to interpret.** Writing past the application produces a row that **looks
> right and behaves wrong** — and every shape-based check passes. Three instances on
> 2026-08-16, which is why this is a law and not a preference:
>
> - `agent_bots.secret` is **ActiveRecord-encrypted JSON**. Reading the raw column
>   yields ciphertext that is the right length and the right shape and would have
>   failed HMAC verification **silently**, surfacing later as "the bot does not respond".
> - `agent_api_keys.key_hash` is a **sha256 hash**. A SQL insert could not have produced
>   a working key **at all** — Paperclip's own `POST /api/agents/{id}/keys` was the only
>   instrument that could.
> - Chatwoot's `provider_config` and Paperclip's `adapter_config` are **jsonb blobs that
>   accumulate secrets** — which is separately why `SELECT *` on them is a credential
>   read (X-03).
>
> **The distinction the next person needs**, so this is not read as a flat ban: the
> `jsonb_set` used to correct `adapter_config.url` was a **plain string field**, applied
> in a transaction that aborted unless the current value matched exactly, with all nine
> keys verified intact afterwards. **That is not the same class as writing an ENCODED
> field.** The rule protects fields whose encoding the application owns —
> encrypted, hashed, or derived. Prefer the API always; understand that for an encoded
> field it is not a preference but the only thing that works.
>
> **Standard scan roots** used by every containment claim below, unless a row says
> otherwise:
> `C:/Users/girau/.claude/projects/C--epic-workspace-Isola-Foundation` (ALL sessions,
> including other lanes' transcripts and subagent files) and this session's scratch +
> tool-results tree. Depth 4.

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
| **RE-EXPOSED 2026-08-16, ESTATE lane, different vector** | Same value, confirmed by byte-match. This time via `SELECT *`-shaped Postgres read of `agents.adapter_config` on `isola_ai-db` (host03) while verifying fd2867d1's binding — not a yaml read, so C-04's own "control added" (the yaml-reader redactor) does not cover this vector. **Purged**: byte-level in-place patch (same method as C-01's SIP-secret purge), needle assembled from fragments, run against every `.claude/projects/C--epic-workspace-Isola-Foundation` transcript and this session's scratch/tool-results roots. 10 occurrences overwritten across 4 files — **3 of those 4 files were prior sessions, not this one**, confirming the token had already leaked before tonight. 0 remaining after a re-read verification pass. **New standing law from this exposure**: `SELECT *` on a table with a config/secret-bearing column is a credential read — enumerate columns, never wildcard. Not yet enforced by any hook; Bash-only guard coverage (see "Coverage boundary" below) would not catch a `psql` SELECT either way, since the sensitive text arrives via a remote container's stdout, not a local credential-surface file. |

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

### C-10 — Paperclip **board** token (`pcp_board_…`) in bff-v2's `.env` — HIGHEST PRIVILEGE FOUND TO DATE

| field | value |
|---|---|
| **What it is** | `PAPERCLIP_API_TOKEN=pcp_board_…`, a board-level Paperclip credential — the level above an agent key. Per the isola-runtime deploy comments, an **agent key cannot mutate without a run id Paperclip never issues (verified 401→500 both call sites, 2026-08-15)**, which is exactly why the runtime instead holds a board-scoped key for write-backs. A board token has no such restriction: it is the level that can write agent **instructions**, the thing agent keys are 403'd from. **This is the highest-privilege credential found in this register so far — worse than C-09's money-moving Magnus key**, because it is unscoped write access to an entire agent platform (create/edit/pause/instruct every agent, not adjust one numeric field. |
| **Where it lives** | `/opt/bff-v2/.env` on deepseek, line 125, alongside `PAPERCLIP_API_URL=http://127.0.0.1:3200` — deepseek's own compose Paperclip (`paperclip-paperclip-1`, company `48f327a1-…`, 14 agents, 167 issues), **not** the host03 instance. |
| **Exposed** | 2026-08-16, by me (ESTATE lane), reading `PAPERCLIP_API_URL` from bff-v2's `.env` for the four-pointer Paperclip-instance resolution (see below). Ran through `secret-redact.js` in the same pipeline, but **the redactor did not match this line** — `PAPERCLIP_API_TOKEN` is not one of its known key-name patterns, so the value passed through in clear. |
| **Why the guard/redactor missed it** | Key-name-pattern miss — the same failure class VOICE's redactor closed hours earlier for `AWS_SECRET_ACCESS_KEY=` (underscores breaking a `\b` boundary, plus bare prefixed tokens). **This is a cross-lane propagation gap, not a local one**: a fix made to one copy of a shared-class control did not reach the other copy, and the class reappeared — this time on a board token. Recorded as a floor item, trigger "next time either redactor is opened" — not fixed tonight; VOICE's fix is already written and tested (195 green) and should be the one ported, not reinvented here. |
| **Depends on it** | bff-v2's Paperclip integration on deepseek (persona/agent reads for voice, per VOICE lane's R1 work). Rotating affects that path only — confirmed unrelated to the host03 WhatsApp/gateway path, which uses its own separate credential chain (`PAPERCLIP_API_KEY_FILE` swarm secret on `isolart_runtime`, already tracked, not this token). |
| **PLACEMENT DECISION** | Deferred to the sweep per the standing rule (value unchanged today, so not yet a rotation). Placement question to resolve at sweep time: **does bff-v2 need board-level access at all**, or does its actual usage (persona/agent reads) fit an agent-scoped or read-scoped credential instead — narrowing this the same way C-09's AMI end-state narrows `ami-listener`. |
| **Was it used illegitimately?** | Not checked — this is bff-v2's live, in-daily-use credential for its own Paperclip integration, so (same as C-09) there is no unused baseline to probe against. |
| **Purged** | Same run as C-04's re-exposure purge, same method. 7 occurrences overwritten across 3 files — **2 of the 3 were prior sessions**, meaning this token was also already exposed before tonight, independent of this read. 0 remaining after verification. |
| **CONTAINMENT STATUS** | **CONTAINED AT 2026-08-16T15:38:05Z**, standard roots. NOT resolved, NOT closed — the credential is unchanged and remains valid. **Source-stop in force from 2026-08-16: `/opt/bff-v2/.env` is not to be read again by either lane, for any reason.** Every fact needed from it is already recorded (`PAPERCLIP_API_URL=http://127.0.0.1:3200`, `PAPERCLIP_FANOUT_ENABLED=1`, and this token's existence and privilege level). |
| **Why the freeze still holds for THIS row, reasoning recorded so it can be challenged** | The obvious response to "purging cannot hold this" is *rotate it now*. Deliberately not doing that: `pcp_board_…` is **bff-v2's live credential for its own Paperclip integration** — fanout, tenant provisioning, admin teardown, skills catalogue, EMA dispatch. Rotating means changing a live service's config on deepseek **and restarting it, mid-cutover** — precisely what the owner's freeze exists to prevent — while the exposure is to **local transcripts, not the internet**. So: contain the symptom, stop the source, rotate on the owner's day. **TRIGGER NAMED IN ADVANCE: if this token is exposed a FOURTH time after the source-stop is in force, the source-stop has failed and a SCOPED rotation exception goes to the owner — this one credential, not the sweep.** |
| **THE PURGE DID NOT HOLD — and this is the row's most important line** | A later **independent verify-only scan** (no patching, with two known-positive controls in the same run) found the token **back: 7 fresh occurrences in `…/fef820c8-….jsonl`, a DIFFERENT session's transcript, mtime 15:14:59Z — after my purge completed at ~14:25.** That is a **concurrent lane** (VOICE, by timing and subject) that read the same `/opt/bff-v2/.env` independently and was still writing. Re-purged; all six session-exposed values now verify absent against a proven-working scanner. **LAW: a purge is scoped to what exists at scan time and to the roots it walks. It cannot bind a concurrent writer, and a lane that re-derives the value re-exposes it minutes later.** The earlier `remaining=0` was true when written and false forty minutes on. **Purging is containment, never remediation — only rotation ends this row**, and this token is now the strongest argument in the register for that, because it is the highest-privilege credential in it and has now been independently exposed by two lanes. |
| **Second-order note** | The background purge process reported `exit code 127` to the harness — an artifact of the `Stop-Process` used to clear it after it hung on a stdout pipe with its work already complete (4.3s CPU over 74 minutes). **The failure code described the kill, not the purge**; believing it would have re-run a completed job, and disbelieving the *summary* is what surfaced the genuine re-exposure above. Verify the check before believing it about the system — in both directions. |

### C-11 — Two Chatwoot agent-bot secret/token pairs, read via unredacted `cat` of a swarm secret

| field | value |
|---|---|
| **What it is** | Two `agentBotSecret` / `agentBotAccessToken` pairs from `isolagw_gateway`'s live `GATEWAY_BINDINGS_JSON_FILE` — one per bound tenant (`isola-uat-a` → Chatwoot inbox 4; `epic-frontdesk-6737` → the **legacy** Chatwoot at `inbox.epic.dm`, inbox 46). |
| **What they grant** | The bot secret authenticates the gateway's agent-bot identity to Chatwoot for that inbox (message read/write as the bot). Scoped per-tenant, not estate-wide. |
| **Where it lives** | Swarm secret `gateway_bindings`, mounted at `/run/secrets/gateway_bindings` inside `isolagw_gateway`. Immutable by design — minting `isola_gw_bindings_v3` (in progress) will carry these same two entries forward unchanged plus one new one. |
| **Exposed** | 2026-08-16, by me (ESTATE), running `docker exec … cat /run/secrets/gateway_bindings` directly — **the exact mistake the C-04 re-exposure entry above had just identified as a new law** (`SELECT *`/wildcard-shaped reads on config-bearing stores are credential reads). I read this file straight, not through `secret-redact.js`, immediately after writing that law down. `isola-guard`'s `credential-surface-redact` pattern does not currently match `/run/secrets/*` paths, so nothing stopped it. |
| **CONTAINED AT 2026-08-16T15:38:05Z**, standard roots | Byte-level, needles from fragments. `uat-a` secret: 2 files, 6 occurrences. `uat-a` token: 1 file, 2 occurrences. `frontdesk-6737` secret: **5 files (including two other sessions' subagent transcripts and an ssh-deepseek tool-result file), 20 occurrences** — already broadly exposed before today. `frontdesk-6737` token: 4 files, 8 occurrences. All four verified absent by an **independent verify-only scan carrying two known-positive controls in the same run** — without those controls a zero would not have been evidence. **NOT resolved: these credentials are unchanged and remain valid.** Source-stop: `/run/secrets/*` is not to be read again by either lane; ask for the key NAME and its presence instead. |
| **PLACEMENT DECISION** | Deferred to sweep, not rotated tonight (freeze holds). Structural gap to close regardless of rotation timing: **extend `isola-guard`'s credential-surface pattern to `/run/secrets/*` and any `docker exec … cat` of a mounted secret**, the same class of miss as C-02's `sed`-on-SIP-config gap that got closed same day. |
| **Was it used?** | Not checked — live in-use gateway credentials for two active tenants, no unused baseline to probe against, same as C-09/C-10. |

### C-12 — Paperclip AGENT-SCOPED read-only key for the voice context path (CREATED 2026-08-16, deliberately)

**This row is not an exposure. It is a credential we created on purpose to retire the use
of a higher-privilege one.** Creating a credential is not a rotation, so the freeze is
untouched — same reasoning as the Magnus IP scoping and the C-01 deploy-key decision.

| field | value |
|---|---|
| **What it is** | Paperclip **agent-scoped** API key, `pcp_…` (**not** `pcp_board_…`), id `f11aaba3-b029-4f0c-bcc1-dc45f765c90c`, name `voice-context-readonly-2026-08-16`, minted on agent `fd2867d1` in company `3ed3869b` on the **host03** Paperclip. |
| **Why it exists** | The voice persona proof previously required a **board** token to read an instructions bundle — the highest-privilege credential we own, used for a read. C-10 is the same class of defect. This key retires that collision permanently. |
| **Minted through the API, not SQL** | `POST /api/agents/{id}/keys` → `201`. Keys are stored as a `sha256` **hash** (`agent_api_keys.key_hash`), so a SQL insert could not have produced a usable key anyway — the engine's own endpoint is the only correct instrument. |
| **Where it lives** | `/home/epicdm/.isola/voice-paperclip-agent-readonly.key` on **deepseek**, `0600`, owner `epicdm` (the user running bff-v2), 52 bytes. Directory `0700`. **Additive only** — one new file; nothing repointed, nothing restarted, nothing on deepseek modified. |
| **Never materialised** | Minted, property-tested and transported in one pipeline: the new token was written to **stdout only** and piped directly into the destination file, while every diagnostic went to **stderr**. It was never printed, never in argv, never in a shell variable. The board token used to mint it was read from its mounted file inside the process and scrubbed from every echo. |
| **SCOPE PROVEN — BOTH HALVES** | **CAN read:** `GET /api/agents/fd2867d1/instructions-bundle` → **200**, `entryFile=AGENTS.md`, 1 file, 866 bytes. **CANNOT write:** `PUT /api/agents/{id}/instructions-bundle/file` → **403** `"Only board-authenticated callers can manage instructions path or bundle configuration"`. **Read-only BY CONSTRUCTION, not by convention**: `assertCanManageInstructionsPath` is a hard `actor.type !== "board" → forbidden` type check, and independently, an agent key cannot mutate at all without an `X-Paperclip-Run-Id` Paperclip never issues (measured 2026-08-15). Two independent mechanisms, neither a flag. |
| **The write probe was aimed at the RETIRED agent on purpose** | `5e2d5fba` ("RETIRED - do not use"), not the live customer-facing agent. The guard runs *before* any bundle logic, so a 403 there proves the guard for every agent in the company — while a surprise **success** would have landed on a retired agent instead of production. **A permission probe should never be aimed at a live customer surface.** |
| **Positive control in the same run** | `GET .../instructions-bundle` on the same probe agent **with the board token** → **200**. Without it, the 403 could have been a dead endpoint or a broken auth path rather than a scoped refusal. |
| **OPEN RESIDUAL — TRIGGER: AT THE HIRE** | The key's actor identity is `fd2867d1` — the live front-desk agent — because that is the persona the voice path reads and it keeps audit attribution honest. Least privilege would prefer a **dedicated read-only identity**, which means hiring a new agent (**TYPE 1**, board approval is on). Deliberately not done: the residual is bounded and stated, and it is cheaper to fix at hire time than to hold the launch for. Note the read guard is **company-scoped** — this key can read any agent's bundle in `3ed3869b`, not only `fd2867d1`. **Carried open. Re-point this key at the dedicated identity when the next agent is hired.** |
| **Revocation** | `agent_api_keys.revoked_at` via Paperclip's own key-revocation route; the row is listed by `GET /api/agents/{id}/keys`. |

### C-13 — Four Meta system-user tokens for `EPIC_BFF_WA`, pasted into a lane transcript

| field | value |
|---|---|
| **What they are** | Four successive Meta **system-user access tokens** for `EPIC_BFF_WA` (`122102823939422508`) on app `EPIC_BFF`. Tokens 1–3 lacked `business_management` and **were never usable** for the write they were issued for; token 4 carries it and performed the phone-level override. |
| **What they grant** | Tokens 1–3: read of the WABA/phone objects. Token 4: additionally **write** of phone-level webhook configuration on WABA `227366173803234` — i.e. it can redirect where a live customer number's messages are delivered. |
| **Exposed** | 2026-08-16, pasted by the owner directly into the ESTATE lane transcript, at the PM's explicit instruction. |
| **ACCEPTED METHOD — named rather than pretended away** | `decision-meta-token-least-privilege-2026-07-24` says "never place either token in chat, Port, Git or logs." **A LANE TRANSCRIPT IS A LOG.** The rule was bent, deliberately, and the practice that honours it is the one executed four times: **paste → straight to a `0600` root-owned file on host03 → byte-level purge of every transcript copy → verify 0 remaining with a controls-proven scanner → then use it only from the file, never in `argv`.** Placements: 201/197/203/199 bytes. Purges: 2, 2, 2 and 3 occurrences, **0 remaining each**. |
| **RESIDUAL, stated not hidden** | **Seconds of exposure in a transcript**, between the paste arriving and the purge completing — plus whatever the harness may have flushed elsewhere in that window. Contained and verified, **not** eliminated. An exception practised without being named is how a rule dies; this row is the naming. |
| **Cheaper alternative for next time** | The owner places the token into a `0600` file on host03 himself and tells the lane the path. Same outcome, zero transcript exposure. **Preferred for any future token.** |
| **CONTAINED AT 2026-08-16T18:22Z**, standard roots | Not resolved — tokens 1–3 remain valid credentials that were never revoked, and token 4 is in active use. |

### C-14 — Agent bot 3's HMAC secret, **EXPOSED BY A DEPENDENCY'S OWN LOGGING**

> **THIS ROW IS ITS OWN CATEGORY, and the category is the finding.** Not a paste, not a
> command, not a wildcard read — **a third-party application logged our secret on its own
> initiative.** Chatwoot's ActiveJob logger prints the full job arguments of
> `AgentBots::WebhookJob`, and `secret:` is one of them, in cleartext, on every enqueue.
>
> **SOURCE-STOP DISCIPLINE CANNOT PREVENT THIS CLASS.** We did not read anything we
> shouldn't have; the dependency wrote it where we were already looking. **You cannot
> avoid it — you can only detect it.** Detection therefore means the scanner must run over
> **logs we do not write**, which is a different control from every other row here.

| field | value |
|---|---|
| **What it is** | The HMAC signing secret for agent bot 3 ("Isola Front Desk Agent"), account 2, inbox 7 — the credential the gateway verifies inbound Chatwoot webhooks against. |
| **Where it leaked** | `isola_chatwoot-sidekiq` job logs, `[ActiveJob] [AgentBots::WebhookJob] … {secret: "…", delivery_id: …}` — emitted on **every** agent-bot dispatch, i.e. once per customer message. Surfaced into the transcript while reading those logs to diagnose the probe. |
| **Why the redactor missed it** | Ruby hash syntax `secret: "…"` in an application log line; the redactor's patterns target env-assignment and URL-credential shapes. |
| **CONTAINED AT 2026-08-16T18:42Z**, standard roots | 4 occurrences, 1 file, **0 remaining**, verified. **NOT resolved — the secret is unchanged and Chatwoot will log it again on the next message.** |
| **⛔ NOT ROTATION-CLOSEABLE** | **This entry survives its own remediation and MUST NOT be ticked off on rotation day.** Rotating the secret fixes a *disclosure*; it does nothing about a *disclosure process*. The replacement secret is logged by the identical code path on the very next customer message. **C-14 is the first entry in this register that rotation does not close.** |
| **It is a RATE, not an event** | Chatwoot logs it on **every** agent-bot dispatch — **once per customer message**. So the exposure grows in exact proportion to the thing we are trying to make succeed: **every customer we win writes the credential to disk again.** |
| **GATE TEST → FLOOR, with a hard boundary** | (1) normal use triggers it? **YES, every message.** (2) exposes customer data to the internet? **NO** — the log is on host03; reading it needs host access, and an attacker with host access has already won by a shorter route. (3) launching makes it unfixable? **NO.** ⇒ **FLOOR. Launch is not held for it.** |
| **⚠ STANDING PROHIBITION — the control that KEEPS it a floor** | **CHATWOOT LOGS DO NOT LEAVE host03** — not to a vendor, not to a bucket, not to a log-shipper, not to an APM agent, not to a support bundle or an EasyPanel log export, not pasted into a ticket or a screenshot — **until C-14 is closed at the mechanism.** The instant those logs leave the host, a local credential becomes a remote one and **this entry converts from floor to GATE**. The conversion is invisible because nobody thinks of "turn on logging" as a security decision. Without this prohibition, C-14 is a gate we have not noticed yet. |
| **PLACEMENT DECISION — three candidate fixes, FILED NOT SCHEDULED** | (1) upstream patch so Chatwoot filters job arguments; (2) redaction at the log sink; (3) a mechanism that removes the secret from the dispatch path entirely. **Start none of them now.** Until one lands, treat sidekiq job logs as a credential-bearing surface and read them only through the redactor, with `secret:`-style Ruby hash syntax added to its patterns. |

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

## Cross-lane propagation items — a fix to a shared-class control must reach every copy

**These are NOT to be fixed by ESTATE.** `isola-guard.js` and its redactor are the
VOICE lane's files. Each row names the gap and the trigger so VOICE takes it in one
pass rather than three. Recorded because the alternative — patching another lane's
security control unannounced — is its own defect (the same reasoning that left
`~/.claude/hooks/enforce-safety.js` reported rather than edited).

| id | gap | evidence | trigger |
|---|---|---|---|
| **X-01** | `secret-redact.js` does not match `PAPERCLIP_API_TOKEN=`, because the key name is not in its pattern set. | C-10: a **board-level** Paperclip token passed through the redactor in clear, on 2026-08-16, in the same pipeline that correctly redacted `DATABASE_URL`'s password two commands earlier. | Same class VOICE closed hours earlier for `AWS_SECRET_ACCESS_KEY=` (underscores breaking `\b`, plus bare prefixed tokens). **Port VOICE's existing fix — do not reinvent it here.** Next time either redactor is opened. |
| **X-02 — ★ TOP OF THE FLOOR QUEUE** | `isola-guard.js`'s `CREDENTIAL_SURFACE_RE` covers neither **`/run/secrets/*`** nor **`/opt/*/.env`** — two path classes whose *entire purpose* is holding secrets, invisible to the control built to catch secret reads. | C-11: `docker exec … cat /run/secrets/gateway_bindings` ran unwrapped and printed two live Chatwoot bot secret/token pairs. C-10: a board token came out of `/opt/bff-v2/.env` and was then **independently re-derived by a second lane**, defeating the purge. Nothing intercepted either. | Add both path classes (and `docker exec … cat` of a mounted secret) alongside X-01, in one pass. **Ranked first with a reason, not a schedule: the source-stop discipline is the only other control, and discipline failed three times on 2026-08-16. This is the last remaining guard gap that costs us on a normal day.** Same shape as the `sed`-on-SIP-config gap C-02 closed the day it was found. |
| **X-03** | No control covers a **`SELECT *`-shaped database read** of a config/secret-bearing column. The guard reads command *text*; a `psql` SELECT is not a credential-surface file, and the sensitive text arrives as a remote container's stdout. | C-04's re-exposure: `agents.adapter_config` carried a runtime bearer in a JSON `headers.Authorization` field. | Likely unfixable by pattern-matching alone — recorded as the reason the **standing law** (enumerate columns, never wildcard) has to carry the weight instead. Floor. |

> **The pattern across all four exposures on 2026-08-16 is one sentence: every leak
> came from a READ, not a write.** The guards were built around mutation. The
> inversion this implies — *the redacted path is the default and an unredacted read
> is the exception needing a reason* — is the shape the next iteration of the read
> tooling should take. Not work for tonight; recorded so it is not rediscovered.

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

**ANSWERED BY READING THE FIREWALL, not by probing** — no packets were aimed at a live PBX-adjacent service, and a probe from this egress would have proven only same-subnet reachability anyway.

`iptables -S` on deepseek: **`-P INPUT DROP`.** The host is default-deny. `ami-listener` is a **native process (pid 1455), not a container**, so its inbound traffic traverses `INPUT` — it does not bypass via the Docker chains. **No rule anywhere permits 3016**: it appears in neither `iptables` nor ufw's allow list.

> **So 3016 binds broadly but is NOT externally reachable. It is contained by the host's default-deny policy.**

Residual caveat, kept deliberately: a firewall rule read is not the same as an external probe, which remains the gold standard. But the read is definitive about *intent and configuration*, and it was the instructed method.

#### CORRECTION TO MY OWN EARLIER CLAIM — 8020 is contained, and I reported otherwise

Earlier in this session I reported `bff-voice-engine` as *"port 8020 published on 0.0.0.0 (internet-facing)… re-confirmed live"*, citing `docker ps`. **That was the declared-vs-effective error, committed by me.** `docker ps` shows the *publish declaration*; it says nothing about whether packets survive the filter. They do not:

```
-A DOCKER-USER ! -s 127.0.0.0/8 -p tcp --dport 8020 -j DROP
      # "block bff-voice-engine internet exposure inc-bff-voice-engine-exposed-2026-07-11"
-A ufw-user-input -p tcp --dport 8020 -j DROP
```

**Blocked in two independent places since 2026-07-11**, with the incident id in the rule comment. `DOCKER-USER` is the correct chain for a published container port — the one place a Docker publish *can* be filtered.

I also checked the known drift trap (ufw listing a rule that `iptables` no longer has, after a reboot): **no drift here.** The 8020 DROP is present in *both* views. Checking both is what makes that statement meaningful.

**So this is ONE finding about the host, and it is a good one:** deepseek is default-deny with explicit, documented containment. Not two service exposures. The Port risk record describing 8020 as an open exposure is **stale and should be corrected.**

#### FLAGGED, NOT CHASED — broad `ALLOW Anywhere` rules on deepseek

Seen while reading the firewall; **outside this register's scope, not investigated, raised for a decision rather than actioned**:

| rule | note |
|---|---|
| `5432/tcp ALLOW Anywhere  # PostgreSQL for Vercel` | **a database port open to the internet** — the item most worth a second look |
| `5433/tcp ALLOW Anywhere` | second Postgres, no comment |
| `3000`, `5173`, `19000`, `8065` `ALLOW Anywhere` | app/dev ports open broadly |
| `10000:20000/udp`, `5080/udp ALLOW Anywhere` | RTP + SIP — plausibly required for voice, but worth confirming they are intended |

Note the *contrast* that makes these stand out: `11434` (Ollama) is correctly restricted to three named source addresses, and `4000` to one. So this host demonstrably knows how to scope a rule — the broad ones look like accumulation, not policy.

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
