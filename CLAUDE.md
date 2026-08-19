# Isola — engineering operating rules

This file is loaded into every session in this repository. It is the short form.
Port.io is the authority; where this file and Port disagree, **Port wins** — re-read
the record and correct this file.

Run `/isola-start` at the beginning of any substantive task.

---

## 1. Authority map — who owns what

| System | Owns |
|---|---|
| **Port.io** | Product truth, execution packets, evidence, acceptance. The plan of record. |
| **Odoo** | Business/commercial system of record (invoices, customers, work orders). **The authority is `epic-communications-inc.odoo.com` and nothing else** — deepseek's `epic` is empty (0 moves), `epic_sandbox` has 283 moves, a company correctly named "EPIC Communications Inc" and **no invoice 348**; host03's `isola_erp` has no `account_move` table at all. The ledger outranks any record of the ledger — AR figures come from Odoo, never from Port. Only `payment_state` is trustworthy; the note trail is not. Never sum currencies. |
| **Magnus** | Voice/PBX/DID/rating/CDR authority. Never rebuilt in Isola. |
| **Chatwoot** | Conversations, human takeover, dedup. AI plugs in as an agent-bot. |
| **Clawith v1.11.0** | Customer-agent runtime — registration, tenants, agents, native WhatsApp. |
| **Isola/Foundation** | Identity, entitlements, governed provisioning, permissions, audit, routing. |
| **Hermes** | EPIC-internal owner/operator cockpit only. **Never** the customer-facing brain. |
| **Meta** | WhatsApp asset ownership (WABA, phone numbers, webhooks). Owner-gated. |

**Do not rebuild what an engine already owns.** Isola's remaining scope is commerce,
entitlements, governance, Meta asset ownership, Chatwoot handoff, voice, support,
acceptance, audit correlation, suspension/rollback.

## 2. Laws that block a change

1. **One authoritative processor per WhatsApp number.** Never wire a number to Clawith,
   Chatwoot and the BFF at once. Human takeover is a governed escalation contract, not a
   second webhook.
2. **Zero upstream forks of Clawith.** Glue lives in `isola-customer-tools` (MCP), the
   additive `isola_bridge.py` endpoint, and the `brain-provider.ts` per-number gate.
3. **Never build in a live checkout.** See §4.
4. **No `prisma db push`.** Ever. Use a reviewed migration, or `db execute` with explicit
   DDL against a zero-row target. Never edit `_prisma_migrations`; never `migrate resolve`.
5. **Repository code is not evidence of deployed behavior.** Verify the substrate — read
   the live config/catalog or observe real behavior. An app's own success banner, a
   write-then-read-back, or "someone set the config" are not proof.
6. **A firewall rule is not containment.** Verify exposure from a genuinely external
   client, never from loopback. Structural fix beats a filter rule.
7. **Direct DB/SSH mutation is emergency containment, not the operating model.** Every fix
   must leave a state model, an API boundary, audit evidence and a UI management path.
8. **Completion semantics.** A packet at 100% means only that item is accepted. Nothing is
   "done" because it compiles.
9. **Never infer a permission from an error code; read the ACL.** Odoo resolves the
   recordset **before** checking access, so a ghost-id `write`/`unlink` probe raises
   `MissingError` whether the right is granted or denied — it made a genuinely read-only
   credential look write-capable (2026-08-14). The authority is `ir.model.access`
   intersected with the user's effective groups; `ir.rule` only ever *restricts*, so the
   ACL is the ceiling. And **a `create` permission cannot be probed without creating**:
   there is no read-only test for it. If a create probe is authorised on a live system it
   **is a write** — choose the target deliberately, write the cleanup before the attempt,
   and verify both removal *and* unchanged neighbouring state. Never probe by writing to
   `account.move`: automations #10/#11/#12 fire `on_write` and post the false "paid"
   notes, so the probe would manufacture the defect being investigated.
10. **A retry that changes the request is a different request, not a retry.** It can
    carry you from one failure mode into another while looking like recovery. Measured
    2026-08-15: an agent key with no `X-Paperclip-Run-Id` gets `401 "Agent run id
    required"`; with a run id Paperclip never issued it gets `500`. Both call sites
    "recovered" from the 500 by dropping the header — walking straight into the 401.
    **The retry meant to save the employee's output was guaranteeing its loss.** Check
    every retry path against that sentence.
11. **The measuring instrument is part of the system under test.** An acceptance script
    reported `INCONCLUSIVE` on a test that plainly passed, because it asserted a word
    absent from the "before" answer that the *question itself* contained. Same family as
    a traceability gate that rejected its own source data (hyphens read as minus signs),
    a `--include` that matched nothing, and a structural scan that passes on a capital
    letter. When a check reports failure, **verify the check before believing it about
    the system** — and a check nobody has deliberately fired is a check that reports
    success.
12. **Fail closed, because the dangerous failure is fluent, not loud.** The old
    front-desk path did not fall over — it answered confidently and wrongly. Measured
    against inbox 46's own history (2026-08-15): it invented *"over 200 channels"* and
    a *"$49.99 activation, $79.99/month"* price that does not exist, leaked the
    internal control token `[ask_owner: …]` to a customer, and sent a customer a raw
    `HTTP 402 Insufficient Balance` in Chinese. **A confident wrong price is more
    dangerous than an error message, because nothing about it looks broken** — and it
    is a number a customer could hold EPIC to. A default that answers when it does not
    know is not a fallback; it is the defect. Prefer a path that says it cannot help
    and escalates.
13. **Every measurement carries a known-positive control in the same query. If the
    control reads zero, the instrument is broken, not the world.** Law 11 is that rule
    for tests; this is it for measurements. Measured 2026-08-15: grepping Traefik's
    access log by **hostname** returned `0` for every service — including `isola_ai`,
    which had 2,233 requests. Traefik's default CLF line carries the path and the
    **router name**, never the Host. It was caught only by cross-checking against
    services known to be live; uncaught, it would have argued for **retiring the live
    customer path**. Record the consequence, not just the mechanism.
14. **Activity can prove alive. It cannot prove dead.** A window that starts at a
    reboot makes zero mean "no visitors since the reboot", not "nobody uses this".
    Retirement needs a **positive** reason: superseded by something named, the owner's
    word, or no configured caller anywhere. And for an *inbound* endpoint, traffic
    answers "who called recently" — only **configuration** answers "who would call next
    month". A quarterly webhook reads zero in a 19-hour window and is entirely alive.
15. **Before retiring anything, ask the catalogue, not the proxy.** `isola_nocobase`
    showed 0 requests in 19 hours and was nearly retired; the Port record shows it is
    the in-progress owner/tenant control cockpit, at a PARTIAL PASS with 8 corrections,
    holding hand-built roles and data scopes. **Zero requests meant "not finished yet",
    not "not used".** Traffic is the right instrument for a different question.
16. **A container can report success by existing.** `isola_isola-probe` runs
    `node p.js ; echo EXIT=$? ; while true; do sleep 3600; done` — it ran once on
    2026-08-14, printed `PROBE ERROR fetch failed`, and has slept since, while
    `docker ps` shows it running with `restarts=0`. The trailing sleep loop converts
    "my one job failed" into "I am up". Test a static config property by **asserting
    the config** and by **causing the behaviour at cutover** — never by a long-lived
    container whose liveness is its own answer.
17. **No service holding unique state is migrated without a PROVEN RESTORE.** Not a
    backup — a restore, performed, counted and evidenced. Chatwoot cleared this bar on
    2026-08-13 and NocoBase on 2026-08-15 (95/95 tables, 351/351 files, restored into a
    scratch database and counted against the source). **A backup nobody has restored is
    a hypothesis.** Two artefacts found on this estate prove the point: a 0-byte
    `chatwoot-host03-20260812-042842.dump`, and a committed
    `templates/employees/isola-ai-sales-front-desk-agent/v1/AGENTS.md` that no longer
    contains any of the live content — **a stale copy in git is not a second copy; it
    is the thing most likely to be mistaken for one.**
18. **Partial agreement is more dangerous than total disagreement.** When two figures
   disagree and a third agrees, **do not** assume the disagreement is definitional.
   **Confirm which database answered first.** Measured 2026-08-14: `epic_sandbox` returned
   246 XCD / 458,701.86 — wrong — alongside 2 USD / 971.17, *identical to the truth*. The
   matching leg made a wrong leg look like a definition problem rather than a wrong
   database, and cost real time.
19. **A test that passes because nothing happened is not a test that the wrong thing
   didn't happen.** Every absence-assertion needs a **positive control in the same
   harness** — a companion proving the thing CAN happen there. Without it, a broken
   fixture, a refused request or an empty database makes every "did not occur" test
   pass vacuously. Measured 2026-08-15: in `test_signup_session_gate.py`, the
   assertions that *no JWT* and *no session* were issued PASSED while the assertions
   that a user WAS created failed — because signup was being refused outright in that
   environment. The absence-assertions were passing against an endpoint that simply
   did not work. This is the positive-control rule this file already applies to greps,
   permission probes and negative claims, **pointed at test design**.
   Corollary, same date, same incident: **verify against the real thing, not a
   convenient artifact.** A suite certified green by mounting files into a container
   image that predated several merges — including its own `.test.env` — went red on
   CI's first run against the actual repo. Same family as the busybox grep, the
   ghost-id probe, and the gate that rejected its own source data.
20. **Test the PATH, not the pieces.** A suite that calls functions directly does not
   prove the route works. Measured by VOICE 2026-08-18: its canary could **mint** an
   access link and was then **refused its own page** — with **13/13 green**. The mint
   gated on `userId`; the render gated on `sipUsername`. One allowlist, two identity
   keys, zero failing tests, because no test ever traversed mint→render as a user
   does. Fixed at 17/17 by testing the route.
   **Corollary — the multi-gate rule.** When a feature has more than one gate, a test
   must assert that every gate keys on the **same field**, and must carry a **control
   proving those field names are genuinely distinct** — otherwise the assertion passes
   trivially when both sides happen to read the same variable in the harness.
   Sibling of "a green probe against the wrong code path is not reachability" (§2.11's
   family) and of the wrong-surface law: each is the same error at a different layer —
   **something green was measured, but not the thing that has to work.**
21. **When you fix a list, enumerate every place that list exists.** A remediation
   applied to one store while an identical stale copy lives in another is **not a
   remediation — it is a moved problem.** Measured 2026-08-18: a non-staff number was
   removed from the internal line's allowlist by re-minting
   `isola_gwint_bindings_v4`, and an untouched copy of the same binding — same inbox,
   same bot secret, same stale 7-entry allowlist — sat in the internet-facing
   gateway's `isola_gw_bindings_v7` the whole time. The fix was verified thoroughly
   **on one side**, and nobody asked *where else does this live?*
   Generalizes to **allowlists, secrets, config and feature flags**. The enumeration
   is part of the fix, not a follow-up: before declaring a list remediated, name every
   store that holds a copy and say what happened to each one.
   Corollary: **the copy you forget is the one with no owner watching it.** The stale
   copy here was only caught because an unrelated measurement printed the other
   gateway's bindings — not by any check that existed.
22. **An authorization is scoped to the operation AS DESCRIBED.** When measurement
   shows the real operation differs materially from the framing the authorization was
   given on, **the authorization does not transfer — stop and re-ask.**
   Measured 2026-08-18: the PM authorized *"remove one stale binding"* from the public
   gateway. The measured operation was *"re-mint an entire Swarm secret store,
   reconstructing bot credentials for four live bindings across two Chatwoot
   instances, one of them the live front desk."* Same sentence, different blast
   radius. The write was refused and the refusal was ratified.
   **Corollary, for the authorizing side, and it is half the law:** when a write is
   authorized, what is authorized is **the operation as described**. If the executor
   discovers it is bigger, **refusing is compliance, not obstruction** — and a
   *smaller* measured operation equally needs a fresh authorization, never a revived
   old one. An authorization is not a token to be spent on whatever the task turns
   out to be.
23. **An ambiguous negative is not a finding.** A zero, a `401`, an empty result or a
   missing row has **at least two explanations**: the thing is absent, *or the
   instrument could not see it*. Separate them before reporting — and **if you cannot
   separate them, report the ambiguity, not the conclusion.**
   Both of 2026-08-18's instances, named because both were caught late and by luck:
   **(a)** zero `rejected_sender` events were read as *"no non-staff sender has
   tried"*. The truth was the opposite and worse — a non-staff sender **had** tried
   and was **admitted**. The refusal never fired because there was nothing it was
   willing to refuse.
   **(b)** account 3 returned `401` and was nearly reported as *"the account does not
   exist on this instance"*. It was **token scope**. It exists.
   Corollary — **this is Law 11's other half.** A check that has never fired proves
   nothing; and **a check that fires zero proves nothing until you can say what a
   non-zero would have looked like.** If you cannot describe the positive case
   concretely, you are not reading a result, you are reading your own assumption.

24. **PROMPTS ARE NOT PERMISSIONS.** A charter that says an agent has *"NO tools of any
   kind"* is **documentation, not a control**. Capability is whatever the toolset grants,
   and it changes when config changes while the prose stays frozen.
   Measured 2026-08-18: the 9043 staff line's floor prompt asserted it had no tools. Its
   platform resolved `terminal`, `code_execution`, `file`, `web`, `browser`, `port-io`,
   `isola-ops`, `staff-ops` and `odoo-epic` — and had **used** them: 28 tool messages in
   Hermes' own store, including shell results with `exit_code` and a filesystem `ls`. A
   staff WhatsApp message asking *"how are sales today?"* caused a live Odoo tool call.
   The sentence was true when written and had been false ever since the path was wired.
   **Never accept an agent's own account of its powers, and never accept a charter as
   evidence of restriction — RESOLVE THE TOOLSET.** Sibling of *measure the hop, not the
   prose*.
   **Corollary — a timeout is not a security control.** The only thing limiting blast
   radius here was a 60s client timeout that killed tool-using loops before they finished.
   That is accidental containment, and it **disappears the moment the timeout is raised**
   — which it must be, for any agent that uses tools. **Scope the toolset BEFORE raising
   the timeout**, never after.
   **Corollary — a success banner is a claim about INTENT, not a measurement of STATE.**
   `✓ Disabled: image_gen, isola-ops:system_health` reported both as applied. Only
   re-reading the config showed what actually happened: the built-in toolset was scoped
   to the platform as asked, while the MCP tool was written to that server's
   **profile-global** `tools.exclude` — the `--platform` flag was accepted, echoed back
   as applied, and silently ignored. It removed the tool from the owner's CLI and
   Telegram, which the containment was explicitly required not to touch. Same family as
   the law above: **the system's own description of itself is not evidence.** Read the
   substrate after every write that claims success.
   **Corollary — a setting that requires ANOTHER setting to take effect is a silently
   ignored setting.** `platforms.api_server.port: 8646` was written, survived, and was
   ignored: the port is only read once the platform block also declares `enabled: true`.
   The gateway bound the default 8642 and said nothing. Same family as the `--platform`
   flag accepted and discarded. **Pin twice and verify the binding** — the config states
   intent, the bound socket states fact.
25. **What you didn't declare, you may still have INHERITED.** Creating a new instance
   from a parent, template or clone starts **everything the parent starts**, unless it is
   explicitly disabled. After creating any new profile, service or clone, **enumerate
   what it STARTED — not what you configured.**
   Measured 2026-08-18: a newly created Hermes profile, whose config declared only
   `api_server`, inherited Telegram and began polling **the same bot token as
   `epic-operator`** — two consumers competing for the owner's messages. Nothing in the
   declared config asked for that; it came from outside the file. Killed within ~25
   seconds, and the profile's own store recorded **0 messages**, so nothing was consumed.
   It is now disabled explicitly in BOTH `config.yaml` and `.env`, because one of them
   alone is a wish.
   The general shape: **absence of configuration is not absence of behaviour.** A fresh
   thing is not an empty thing. Sibling of §2.21 (enumerate every copy of what you fix)
   and §2.24 (capability is not prose) — all three are the same failure to distinguish
   what was *declared* from what is *true*.

26. **A containment that leaves a false assurance in place is not a containment.**
   When you disable a capability, **the surface must say so honestly.** Removing the
   function but leaving reassuring copy has not contained the problem — it has replaced
   a broken feature with a lie, which is worse, because the broken feature at least
   fails visibly. Every disablement answers: what does the user now SEE, and is it true?
   Silence filled with comfort is the failure mode; fail-closed means the surface says
   *"this is not available"*, never *"sit tight, something is coming"*.
   **Corollary to §2.21** — *a secret can sit anywhere in a request line*: path, query,
   header, body or fragment. Redaction written for query parameters only is redaction
   for one hiding place. Enumerate the SHAPES, not just the copies.
   **Corollary to §2.24** — *an async reload will lie to you for a second or two.*
   Verifying immediately after `systemctl reload nginx` can hit a worker still serving
   the old config; a verification that races the thing it verifies is not a
   measurement. Re-check after the workers have cycled.
   **Corollary, added 2026-08-19 after it cost us twice — A FAIL-CLOSED RULE NEEDS A
   MECHANISM TO FAIL WITH.** Before ruling "must refuse", check whether a refusal path
   exists. The runtime was ruled to refuse booting without a budget ceiling and had
   only *warnings* — nothing that could refuse — so the mechanism (`bootErrors()`,
   exiting non-zero) was part of the work, not an afterthought. A rule that names a
   consequence the system cannot produce is a wish.
27. **A field's name is a claim; its write-site is the truth.** *(three parts, one night)*
   **(a)** Before citing a flag as evidence, **read the code that SETS it**.
   `verified=true` meant only "the OTP was accepted" — rows carrying it came from runs
   where SIP registration still failed with *Wrong password*. `xmlFetched=true` meant
   only "a config fetch occurred". A column called `verified` verifies whatever its
   author decided to verify, which may not be your question.
   **(b)** **A read taken after you mutated the thing is not a measurement of its
   history.** A reset deleted 13 activation rows; the survivor was then reported as
   "the first ever verified" when it was merely the only one left. If you have written
   to or truncated a store during a session, any historical claim about it must come
   from a pre-mutation snapshot, and must say so.
   **(c)** **A guard that inspects prose instead of operations protects nothing.** A
   safety hook blocked a Port write because the DOCUMENTATION contained "destroy" near
   "Magnus" — while the actual delete operations it exists to prevent had already run
   unimpeded. A guard that fires on the description of an action and not the action is
   theatre: it produces the feeling of protection at the moment protection has already
   failed. **Guards must bind to operations.**
28. **A test can only protect a decision someone made.** A passing test encodes intent,
   so a test written around behaviour nobody chose does not protect the system — it
   **preserves the accident** and makes it costly to fix. When a test asserts something
   surprising, ask who decided it and when; if the answer is "nobody", **the test is the
   defect's bodyguard**. Measured 2026-08-19: `"treats an absent or zero budget as
   unlimited"` passed for as long as it existed, and was the reason an unbounded-spend
   default survived review.
   **Corollary — a sabotage test without a control cannot distinguish "refuses
   correctly" from "refuses everything".** Every negative proof needs its positive twin
   in the same run.
   **Corollary — RED TESTS CAN BE EVIDENCE.** Thirteen tests turning red when a required
   env var was withheld is the proof that the service now refuses to run unconfigured:
   the failure IS the measurement.

> **Where these laws come from.** Every law in this section was written after the
> thing it forbids had already happened here — and laws 21, 22 and 23 were each
> filed by the lane that made the mistake, catching itself and reporting it before
> anyone asked. That is the reason this register is worth keeping: it is not a list
> of rules handed down, it is the estate's own scar tissue, and a lane that hides a
> near miss removes the only evidence the next lane will get.

## 3. The 9 questions — answer before implementing

1. User and role served. 2. Existing route/surface that owns the capability. 3. Canonical
state owner. 4. Existing service/API contract. 5. External engine authority. 6. Smallest
current delta. 7. How it becomes manageable through the UI. 8. Replit migration effect.
9. What is reused, and what duplicate work is avoided.

## 4. Production topology — never build or write here

Host **deepseek 66.118.37.12**. These are live checkouts served by running processes:

`/opt/bff-v2` · `/opt/isola-runtime` · `/home/epicdm/clawith-v1110` ·
`/home/epicdm/hermes-workspace` · `/home/epicdm/.hermes/hermes-agent` ·
`/opt/hermes-eric` · `/opt/isola-bridge` · `/opt/lk-voice-agent` · `/opt/emapro-api`

> **Precedent:** a production build run inside `/opt/bff-v2` on a feature branch overwrote
> the live `.next` output in place, changed `BUILD_ID`, and traced candidate files into live
> route manifests. Build in a `git worktree` or an isolated copy — never in the directory a
> live process serves. Determine the deployed commit from the process's exec cwd, **not**
> from GitHub's default branch (which is stale for `epicdm/isolav2`; the real trunk is
> `fix/bffv2-retire-dashboard-reseller-campaigns-broadcast`).

**Protected numbers** — 3742 (sole public front door) · 9043 (Hermes internal, out of
scope) · 6737 (Front Desk / Customer Zero) · 0001 (legacy, do not touch) · 9525 (Anansi).
Shared WABA `272252189309178` carries 11 numbers: flip webhooks **per phone, never per
WABA**, and re-check `GET /{waba}/subscribed_apps` after any Chatwoot inbox change.

## 5. This repo

pnpm monorepo. **No CI, no lint, no CODEOWNERS** — a guard only runs if it is chained into a
`package.json` script. Prior art: `scripts/src/guard-not-prod-db.ts` (pure predicates +
entry-point-gated `main()` + unit **and** child-process integration tests).

| Task | Command |
|---|---|
| Targeted typecheck | `pnpm --filter @workspace/isola typecheck` |
| Single test | `pnpm --filter @workspace/isola exec vitest run <path>` |
| Guard tests | `pnpm --filter @workspace/scripts test` |
| Full typecheck | `pnpm run typecheck` |

Two independent auth realms: `lib/session.ts` (operator, Replit OIDC, carries the
`act_as_tenant_id` admin impersonation override) and `lib/consumer-session.ts` (consumer
OTP, HMAC cookie). They deliberately share no code. Five `tenant_id String?` columns rely
on an "exactly one of tenant_id / consumer_account_id" XOR that the schema does not
enforce. `api/voice/*` and `api/wallet/*` each have a `api/consumer/*` twin — one per
realm. These are the sharpest tenant-isolation review targets.

## 6. Stop conditions — stop and ask the owner

Unresolved conflict between ratified decisions · irreversible production or customer-data
risk · unavailable access with no approved route · tenant-isolation failure · a required
owner decision on price, legal terms or material product scope · an external dependency
with no safe fallback · uncertainty whether a governance floor is safely closed.

**Routine bugs and research questions are not stop conditions** — investigate and proceed.

Owner-only actions: Meta asset changes · Replit Publish · real customer contact · real
payment · broad launch · merging to a protected branch.

## 7. Skills

`/isola-start` · `/isola-plan-section` · `/isola-production-safety` · `/isola-pr-review` ·
`/isola-test-matrix` · `/isola-port-closeout` · `/isola-ui-convergence` ·
`/isola-deploy-readiness` · `/isola-incident`

Enforcement is deterministic, not advisory — and it lives in **two** places. Verifying one
does not verify the other.

**Project hooks — `.claude/hooks/`, version-controlled with this repo.** `isola-guard.js`
and `isola-stop-gate.js` block builds in live checkouts, secret reads/writes, writes into
live checkouts and build output, Meta mutations, and prohibited schema commands. Run
`node .claude/hooks/selftest.js` to verify; it exercises exactly those two files, and then
chains the user-home hook's own suite if that hook is installed.

**User-home hook — `~/.claude/hooks/enforce-safety.js`, NOT in this repository.** It gates
destructive shell, SQL and container operations, and it is the hook whose refusal reads
`BLOCKED by Isola safety hook`. Verify it directly with
`node ~/.claude/hooks/enforce-safety.test.js`; it also writes `enforce-safety.log` beside
itself, which is the record of every block, exemption and allow.

**Two cautions follow from where it lives.** Because it is outside the repository it is
**per-machine**: not reviewed in a PR, and it may differ between lanes — so a lane cannot
assume another lane is subject to the same rules. And it gates only what it is given: as of
2026-08-19 it applies its rules to shell invocations and file writes, and deliberately not
to records such as register entries or API calls. A record is not an operation; matching one
against command patterns blocked four Port writes before it was fixed
(`def-enforce-safety-guard-binds-to-vocabulary-not-operations-2026-08-19`,
`dec-enforce-safety-gated-to-operations-2026-08-19`).

**If a guard blocks a document rather than an operation, stop and report it. Do not reword
to get through** — a register that has learned to avoid its own vocabulary can no longer say
plainly what it decided about the operations it exists to govern, and writing around a guard
is one step from disabling it.

## 8. The Register Law — ratified 2026-08-17

Port entity: `dec-register-write-and-read-law-2026-08-17`.

> **The register is only useful if it's both written and read.**

**DUTY 1 — READ BEFORE BUILD.** Any new mechanism, pattern, integration or component
starts with a Port query for prior art (components, decisions, defects, ideas). *"No prior
art found"* is a **claim**, and it names the search that was run.
*Evidence:* the R12 persona shim was derived from scratch while `isola-runtime`'s
instructions-provider precedent — same fetch, same 60s TTL, same fail-closed ladder — sat
in Port the whole time.

**DUTY 2 — WRITE WITH THE WORK.** Every ratification, supersession, built outcome, defect
and retirement names its Port write **in the same dispatch or report that carries it**. A
decision or a build that has not reached Port **is not done**.
*Evidence:* a Hermes re-ratification was filed in the project register and its Port write
was never ordered. Port then spent a day asserting a freeze the owner had lifted, and
nearly reversed correct work.

**ENFORCEMENT — THE FOOTER.** Every lane report and every PM dispatch ends with one line:

```
PORT: read <what was checked> · wrote <entities>
```

or, when genuinely nothing applies, `PORT: no register impact`. Silence is never ambiguous
again. Reports without the footer bounce, exactly as reports without lane + HEAD do.
