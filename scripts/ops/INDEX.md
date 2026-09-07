# Release-lane procedure registry — Isola-Foundation / host03

Per `dec-c360-ops-procedure-registry-2026-09-05` and the Isola Agent Contract's
procedure-registry discipline: **an action performed a second way is a defect.**
Every procedure here was registered because the same operation was hand-rolled
more than once in this release lane, and each one carries its own proof step
so a stale procedure fails loudly instead of lying.

`isola-guard.js`'s `ad-hoc-fixture-teardown` rule refuses any new file that
writes `litePlanSubscription` state or `sipPasswordHash` directly, outside
`scripts/ops/` or real application source (`app/lib`, `app/api`). If you hit
that refusal, you are looking for one of the scripts below, not a new file.

This registry is split across two repos because each script imports and runs
against the repo whose modules and live substrate it actually needs — there is
no single checkout that has both. Each side's INDEX cross-references the
other.

## Registered here (Isola-Foundation / host03, Chatwoot + release-lane infra)

| Script | Governs | Why it exists |
|---|---|---|
| [`chatwoot-token-verify.ps1`](./chatwoot-token-verify.ps1) (+ [`chatwoot-token-verify-remote.sh`](./chatwoot-token-verify-remote.sh) companion) | Confirming `CHATWOOT_SERVICE_TOKEN` actually resolved on a live Foundation/C360 container | Was checked ad hoc, three different ways, across the PR #121/#122 promotion (boot-log grep, one-off DB query, one-off curl) — none of the three alone is proof; the token can be present in one layer and dead in another. |
| [`ancestry-check.ps1`](./ancestry-check.ps1) | Verifying a commit is a real ancestor of a target branch, from a machine with real `gh`/git history (host03 and deepseek have neither) | The deploy guard below requires this check's verdict be computed off-host and embedded as a Docker label before a build is trusted. Written once here so both the C360 and bff-v2 deploy guards call the same logic instead of two hand-rolled `gh api compare` calls. PowerShell, not bash — measured 2026-09-05 that WSL/Git-Bash calling `gh.exe` via interop hangs indefinitely on this machine, while the same `gh api` call runs natively from PowerShell in under a second; see the script's own header. |
| [`safe-file-edit.mjs`](./safe-file-edit.mjs) | Shortening or rewriting a repository source file on Windows without destroying its UTF-8 encoding, and proving afterwards that it didn't | `Get-Content \| Set-Content -Encoding utf8` silently rewrote 11 em-dashes into mojibake in `lite-provision.ts` (2026-09-06). The trap was already in a memory note and was walked into anyway — **a note that does not stop the action is not a control**. Use `keep-lines --file=<p> --keep=<N>` instead of any shell pipeline, and `check <file...>` before every commit that touched a non-ASCII file. Its proof step is byte-identity of the retained region, not just a signature scan, so it catches corruption shapes nobody has catalogued. Run `self-scan` after ANY edit to it: the detector's first version passed a genuinely corrupted control as clean because its positive control was hand-written in the one corruption shape it already knew — `self-scan` now generates both the ISO-8859-1 and CP1252 shapes mechanically and also asserts legitimate accented prose is *not* flagged. |
| [`c360-remote-build.sh`](./c360-remote-build.sh) + [`c360-deploy.sh`](./c360-deploy.sh) | Building and deploying the Customer 360 UAT stack on host03, with an ancestry-verified guard | `dec-c360-deploy-ancestry-guard-2026-09-05`'s two-file guard (GUARD A: build-id-match against last-recorded state; GUARD B: refuses an image whose `isola.ancestry-verified` label is missing or not `YES`) existed only as loose per-build files on host03 with SHA hand-substituted at the top each time and no canonical copy anywhere — registered here 2026-09-05, parameterized to take the commit sha as an argument instead. Deploy this file's content to host03 (it must run there — see the script's own header) rather than hand-editing a fresh copy per build. |

## Registered in `epicdm/isolav2` (bff-v2, Lite fixtures)

See that repo's own `scripts/ops/INDEX.md` for the authoritative descriptions.
Named here so this side of the registry is discoverable without switching
repos:

| Script | Governs |
|---|---|
| `fixture-reset.ts` | Expiring a Lite fixture account's active plan subscriptions between test runs. |
| `fixture-credential-swap-smoke-test.ts` | Temporarily swapping a fixture's `sipPasswordHash`, calling one or more authenticated endpoints, restoring, and independently re-verifying the restore. |

Both were hand-rolled three separate times in one session
(`fixture_purchase.ts`, `fixture_purchase2.ts`, `fixture_purchase3.ts`) before
being registered — see that repo's INDEX for the full history.

## Adding a new procedure

Register here (or in the other repo, whichever owns the substrate the
procedure touches) instead of writing a one-off when:
- the same operation shape has been hand-written more than once, or
- the operation reads or mutates a governed-domain shape
  (`AD_HOC_FIXTURE_TEARDOWN_RE` in `.claude/hooks/lib/isola-topology.js`), or
- a future lane will predictably need to do this again.

## The Claude-plugin hook mirror is DELETED. Do not recreate it.

`tools/claude-plugins/isola-engineering/hooks/` was a second copy of
`.claude/hooks/` — its own `isola-guard.js`, `isola-topology.js` and friends,
wired as a real `PreToolUse` hook via `hooks.json`. It was deleted on trunk in
`f7b5bd8` (PR #125), *"delete the unused Claude-plugin mirror instead of syncing
it"*, and the reasoning is recorded here because otherwise someone reconstitutes
it in six months and it will look like an improvement.

Why it had to go: by the time it was removed it was **three whole rule sets
behind** the canonical hooks — missing the network-destroy rules, the
secret/config/volume-destroy rules and the narrative-text exemption — while
still presenting as a security guard. **A guard that looks like protection and
is not is worse than no guard**, because it is trusted. Nothing installed it, so
nothing had noticed.

"Have the plugin import the canonical file" is not available: a distributable
plugin resolves under `CLAUDE_PLUGIN_ROOT` and cannot reach the repository's
`.claude/`. So if a plugin ever needs these hooks again, **it must be GENERATED
at release time from the canonical `.claude/hooks/`, with a drift check that
FAILS THE BUILD when the two differ.** A copy kept in sync by discipline is a
copy that will drift; rule 2.3 — one source, never a sync.

**Merge hazard, still live.** Any unmerged branch based on a commit before
`f7b5bd8` still contains the mirror, and any such branch that *modified* it will
produce a modify/delete conflict on merge. Resolving that conflict by keeping
the file silently resurrects ~4,300 lines of stale guard. Resolve it by taking
the deletion.

## Standing rules for applying a fix

**MEASURE TRUNK, NOT THE SHARED CHECKOUT.** Before asserting anything about a
file's state — that it exists, that it is stale, that it contains a rule, that
it is a duplicate — read it from `origin/main`, never from the working tree:

```
git fetch origin
git ls-tree -r --name-only origin/main -- <path>     # does it exist on trunk?
git show origin/main:<path>                          # what does trunk actually say?
git log --oneline --diff-filter=D origin/main -- <path>   # was it already deleted?
```

The shared working checkout is routinely sitting on a feature branch cut from an
older `main`, so it answers a different question than the one you asked. This
produced **three wrong answers in a single session on 2026-09-06**: a hook file
reported as stale when trunk's was newer, a plugin mirror reported as a live
duplicate when trunk had already deleted it, and a fix applied by copying the
older file over the newer one. Each was caught late and by luck. The correct
answer was one `git ls-tree origin/main` away every time.

Corollary, and it is the same rule pointed at a different substrate: **verify
the instrument before believing a green result.** A typecheck that reported
"clean" had not run at all — the worktree had no `node_modules`, so the binary
never resolved and the grep for errors found nothing. Every typecheck now plants
a deliberate error first and asserts the checker reports it. A zero from an
instrument you have not proved can see a positive is not a measurement.

Corollary, earned the same day: **never write a commit message with
`Out-File -Encoding utf8`.** PowerShell 5.1 prepends a BOM, and it lands in the
commit subject line. Use a real UTF-8 writer, or `git commit -F` on a file
written by one.

**A UNIT IS PART OF A VALUE. Read a money field in its own units before calling
it wrong.** Measured 2026-09-06: three rows were read out of the portal's
dj-stripe store and reported as a P1 money-correctness defect —
`Isola Personal Line $1,296.00 usd`, `Visitor Pass $926.00`, `Annual
$12,963.00` — against a ratified ladder of EC$5/15/35/55. It read as two errors
stacked: cents-stored-as-dollars, and a currency mislabelled `usd` when it
should be XCD.

**Both were wrong, and the reporter had introduced both.** Stripe's
`unit_amount` is denominated in **cents**, so those integers are US$12.96,
US$9.26 and US$129.63 — and the source field is literally named `usd_cents`
(`apps/isola_provisioning/personal_line_stripe_catalog.py`:
`usd_cents=1296,  # US$12.96 -- ratified figure, not recomputed here.`). USD is
the ratified design, not a mislabel: XCD is hard-pegged at 2.70, Stripe charges
USD, and US$12.96 × 2.70 = **EC$35.00**, the owner's ladder exactly.

The value of this entry is what nearly happened next. The report was escalated
to a P1 with a quarantine, and the quarantine carried one clause — *"do not
correct them without the owner ruling on the real ladder; a wrong correction is
as bad as the wrong value."* **That clause is the only thing that prevented a
×100 "correction" pricing the Personal Line at 13 US cents.**

Provenance was one `git show` away the whole time: the commit production runs is
titled *"feat(isola-provisioning): Stripe payment wiring for Personal Line (test
mode)"*, and its message states the three figures in both currencies.

So the rule is not "don't flag" — flagging an anomaly beside a ratified figure
was right. The rule is:
- **read the field's own units first** (the schema, the field name, the
  producer's own docs — Stripe, Odoo, Magnus and Reloadly all use minor units in
  at least one place);
- **check provenance before severity** — `git log`/`git show` on the file that
  writes the row costs seconds and answers "who wrote this and why";
- and when a value looks wrong by a factor of exactly 100, **suspect the reader
  before the writer.**

Same family as the busybox grep and the ghost-id probe: the instrument was
wrong, and it was the instrument nobody thought to check because it was
arithmetic.

**WHEN ABSENCE AND A NEGATIVE VALUE SHARE A FALSY CHECK, ABSENCE GETS RENDERED
AS THE NEGATIVE. Test `=== false`, never `!x`, for any field that carries a
judgement.** Measured 2026-09-06 while porting the Lumen design pack's customer
workspace. `Contact.healthy` had no source on this estate, so it arrived as
`null`. Every branch in the screen read `!ct.healthy` or `ct.healthy ? … : …`:

```js
const n = !ct.healthy ? { t: "At risk after a recent issue — a goodwill
                              gesture keeps them.", c: "Make it right" } : …
return <div className={"nba" + (!ct.healthy ? " nba-danger" : …)}>
```

`null` is falsy, so **every customer with no health data was ACCUSED OF BEING AT
RISK — in danger styling, with a "Make it right" call to action.** The same
falsy read drove a red dot on the avatar and an "AI insight" reading *"At risk —
sentiment dropped after a late delivery."* Nothing was broken; nothing logged;
the screen simply asserted something defamatory about real named customers
because a field was missing.

This is the general shape, and it is not a React problem:

- `!x` cannot distinguish **absent** from **false**, and `x ? a : b` sends
  `null`, `0`, `""` and `NaN` down the `b` branch.
- Whichever branch is the *negative* one therefore becomes the **default for
  missing data** — and negative branches are exactly where the alarming copy,
  the red styling and the escalation live.
- So the failure is always in the dangerous direction. A missing field never
  quietly renders "healthy"; it renders "at risk".

The rule, in three parts:

1. **For any field that carries a judgement — health, risk, status, approval,
   verification, eligibility — make it nullable and test `=== false` /
   `=== true` explicitly.** `!x` is only safe on a field that genuinely cannot
   be absent.
2. **Absence renders as absence** — `—`, or the element is not rendered at all.
   Not a grey third state and not a hedged sentence: both still assert that the
   judgement applies and we merely could not decide.
3. **An empty collection is not a checked collection.** `invoices: []` from an
   unwired source rendering "Open invoices: 0" is a positive claim that we
   looked. Carry an explicit "is this source wired" flag beside the data; a real
   zero and an absent source must not render the same.

Sibling of §2.12 (*fail closed, because the dangerous failure is fluent, not
loud*) and of the pay-page defect that told a paying customer their link never
existed. Same shape each time: **the system did not fail, it confidently said
the wrong thing, and the wrongness pointed at a real person.**


**Never apply a fix by copying a whole file over another. Edit in place, against
the file that is actually loaded.** Learned 2026-09-06: the same file existed in
two checkouts at different versions; the fix was made in one and `Copy-Item`-ed
to the other. The copy was byte-perfect and hash-verified — and wrong, because
the destination was NEWER, so the copy silently deleted a function it had gained
and broke three tests. A whole-file copy carries the source's *absences* as well
as its contents, and hash-verifying it proves only that the copy succeeded. If
two copies of a file must exist at all, that is its own defect (rule 2.3, one
source never a sync) — fix the duplication rather than getting better at syncing
it.

**Verify your own writes.** Read back what you wrote, from the place that will
be read. A successful write is not a stored write, and a successful copy is not
a correct copy.

## Adding a new procedure (continued)

A registered procedure must: take arguments rather than hardcoding a target,
refuse to run against anything off an explicit fixture/target allowlist where
the substrate is customer-facing, and end with an independent re-read that
fails loudly (non-zero exit, explicit `FAIL:` line) if the expected end state
was not actually reached — never trust a mutation's own return value as proof.

## STANDING CHECK — a service that cannot say what commit it is, is undiagnosable

**Ratified 2026-09-06 by the owner, after the second occurrence.**

> Before this lane calls any deploy verified, the service must expose its
> revision and it must be READ BACK.

Two production services have now been silently stale or dangling, and **both
were found by accident**:

1. **`isola-lumen-prod` (webapp)** — its entire source was `FROM
   isola-portal-web:lumen-6ee15ba`, an image that **no longer existed on the
   host**. A "deploy" would not have shipped anything; it would have failed on a
   registry pull for a local-only tag. Found only because the pin was checked
   before deploying rather than after.
2. **`isola-lumen-api-prod`** — ran code from 2026-08-31 while the branch had
   moved on 2026-09-04. `GET /api/isola/tenants/<t>/customers/` answered
   `not_configured` forever and the owner's customer list was permanently empty,
   **while every configuration value that path needs was present and correct**.
   The image carried **no revision label at all**. Found only by reading the
   deployed source out of the running container by hand, after noticing that
   `is_configured()` returning `True` contradicted a `not_configured` response.

Note what both have in common: **the symptom pointed at configuration, and the
cause was provenance.** In (2) the config was flawless. Anyone debugging from
the symptom would have spent the day on env vars and Odoo bindings.

### The check, applied to every deploy

1. **Before deploying, establish what the service's source actually is.** If it
   is `FROM <image>`, confirm that image EXISTS, with a positive control proving
   the probe can report PRESENT and a negative control proving it can report
   ABSENT. A dangling pin makes "just deploy" a no-op or a failure, never a fix.
2. **After deploying, read the revision back from OUTSIDE** — the served
   endpoint (`/version`, `version.json`), not the deploy's success response and
   not the build log. Then read it from INSIDE the container as the second,
   independent leg.
3. **If the service cannot answer "what commit are you", that is the first
   defect to fix** — before the one you came for. It is not hardening: it is the
   difference between a five-minute diagnosis and finding a four-day-stale
   production service by luck.

### What this implies for anything new

Any service this estate builds emits `org.opencontainers.image.revision` from a
**required** `GIT_SHA` build arg, baked at BUILD time, and exposes that same
single value on an unauthenticated endpoint. One value, both places, so they
cannot drift — `packages/webapp/Dockerfile.prod` records a 2026-08-24 case where
a **deploy-time** `GIT_SHA` env var drifted five days from the image tag,
because it was set once at deploy and never updated on a later
`docker service update --image`.

An unauthenticated version endpoint is deliberate. A version you must
authenticate to read is useless to monitoring and to an operator at 2am, which
is precisely when this matters. Disclose the sha and nothing else — not the
branch, the build host, the environment name, or anything derived from a
credential.

**Two occurrences is a pattern, not an incident.**
