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

## WHEN A PROBE CAN ONLY SAY YES, IT IS NOT A PROBE

**Ratified 2026-09-07.** Every existence check carries a **negative control that
must fail**. If you cannot make the probe say no, you have not measured
anything — you have confirmed your own assumption in a louder voice.

**Measured the day it was written.** Establishing which Foundation instances
existed, a DNS check reported that *every* candidate host resolved:

```
isola-360.saas00.epic.dm          RESOLVES
isola-360-prod.saas00.epic.dm     RESOLVES
isola-360-uat.saas00.epic.dm      RESOLVES
isola-360-staging.saas00.epic.dm  RESOLVES
CONTROL definitely-not-a-host-xyz.saas00.epic.dm   RESOLVES   <-- invented
```

`*.saas00.epic.dm` is a **wildcard record**, so DNS answers "is there a
wildcard", never "does this service exist". Without the invented host, that
output reads as *four Foundation instances exist* — and the next step would have
been choosing between production instances that were never there.

The re-run on a real instrument (HTTPS, then swarm services) showed **one**
instance, UAT, with both controls behaving. The finding — *production has no
Foundation* — is the opposite of what the first probe implied.

### The shape

1. **Name the negative control before you run the probe**, not after. A control
   invented to explain a surprising result is a rationalisation.
2. **It must be of the same kind as the thing you are testing** — an invented
   hostname for a hostname probe, a nonexistent image tag for an image probe, a
   sentinel string for a grep.
3. **If the negative control passes, the probe is broken and its positive
   results are void.** Not "mostly right" — void. Change instrument.
4. **Prefer an instrument that touches the thing itself.** DNS is one layer away
   from a service; HTTPS is at it; the container list is inside it. The further
   out you measure, the more the infrastructure answers for the thing.

Same family as the busybox grep, the ghost-id permission probe, and the
`grep -c` over an empty file. This is that rule pointed at existence checks,
which are the ones most likely to be believed, because a list of things that
resolve looks like evidence.

---

## COMPARE TWO SECRETS WITHOUT DISCLOSING EITHER — THE SALTED DIGEST

*Named 2026-09-07, after it settled in one run a question that had cost two cycles.*

**The question that keeps coming up:** two systems each hold a credential and one
of them is being refused. Is it the same one or a different one? Reading either
value answers it and puts a live credential into a transcript, a log and a
scrollback buffer — so in practice the question goes unanswered and is replaced by
a guess.

**The technique.** Generate ONE random salt for the run. In each place the value
lives, compute `sha256(salt ‖ value)` **inside the same pipeline that reads it**,
and print only the first ~12 hex characters. Equal prefixes mean equal values;
unequal means different. Nothing else is learned, and nothing leaves the pipeline.

```
SALT=$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')
# inside each container, in one pipeline:
#   read the variable → prepend $SALT → sha256sum → cut -c1-12
```

**The salt is not decoration.** Without it the digest is a stable fingerprint, and
publishing it invites an offline dictionary attack against any low-entropy value.
A fresh salt per run makes the printed digest meaningless five minutes later and
meaningless across runs — which is exactly right, because the comparison is only
ever valid within one run.

**TWO CONTROLS, AND IT IS WORTHLESS WITHOUT BOTH.**

1. **A known-shared literal.** Digest the string `control` in every location with
   the same salt. All must match. If they do not, the pipelines are not comparable
   — a different `sha256sum`, a shell appending a newline, a different encoding —
   and every other digest in the run is noise.
2. **A known-EQUAL real value.** Digest something already known to be identical in
   both places (a tenant id, a base URL). It must match. Control 1 proves the
   plumbing; control 2 proves the method detects sameness on real data. Without
   it, a pipeline that produced a constant would pass control 1 and then report
   "different" for every real comparison — and that failure reads exactly like a
   finding.

**Read the value where the PROCESS reads it, not where it is convenient.** On
2026-09-07 the same variable was UNSET under `docker exec` and SET in the running
server: the entrypoint reads a swarm secret file and exports it into the process
it launches, while `docker exec` starts a NEW process from the container's
`Config.Env`, which never contained it. Digesting `/proc/<pid>/environ` of the
actual server answered the question. Digesting the convenient surface would have
produced a confident, wrong "Foundation has no credential at all".

**What it does NOT tell you:** whether either value is *correct* — only whether two
copies agree. Pair it with a behavioural probe carrying its own control before
concluding anything about a door.

Same family as the ghost-id permission probe and the negative-control rule above:
each replaces a disclosing or destructive measurement with one that answers the
same question, and cannot be believed without its control.

---

## NO PRODUCTION IMAGE BUILDS FROM A FLOATING TAG

*Ruled 2026-09-07. This is the version-identity law, one layer further down.*

**A floating base tag means every rebuild is a different product.** `FROM node:22-bookworm-slim`
is not a version; it is a subscription. Two builds of the same commit, a week apart, are
two different images, and nothing in the build output says so.

**And the damage is not recoverable after the fact.** Once the tag moves, the base an image
already in production was built on **cannot be determined** — not from the image, not from
the Dockerfile, not from the registry. Measured on host03: `isola-foundation-360:5fe25d3b`
had been serving for two days; `node:22-bookworm-slim` was **not in the host's image cache**
(verified with a deliberately non-existent tag as the control, so "No such image" was a real
answer and not a broken lookup). Its base is gone. The best available statement was
*"the tag's current image was created before that build, so unless it was republished twice
in that window this is the same base"* — evidence, not proof, and it was written into the
Dockerfile in those words.

**The rule.** Pin by digest:

```
FROM node:22-bookworm-slim@sha256:83f487e0…  AS base
```

and **record the digest where the next reader will look** — in the Dockerfile, with a
comment saying when it was resolved and why. A digest in a build log nobody reads is not a
pin.

This is the same failure as an unpinned deploy that reports success, a `BUILD_ID` nobody
checked, and a version endpoint returning the literal string `undefined`: **the artefact
cannot say what it is.** Pinning the base is where that chain starts.

---

## SCAN BEFORE YOU COMMIT A DIRECTORY YOU DID NOT AUTHOR

*Added 2026-09-07, the day it stopped a live third-party API key from reaching GitHub.*

Putting an unversioned operational directory under version control is a good thing to do and
a **one-way door**: a pushed secret is public forever, and no amount of rewriting history on
a shared remote takes it back. Scan first, and scan by the **shape of the value**, not by the
name of the variable.

For every line whose *name* looks credential-ish (`token|api_key|secret|password|credential`),
classify its **value**:

| value shape | verdict |
|---|---|
| contains `$` | **reference** — safe, it reads from the environment |
| starts with `/` | **path** — safe, e.g. `/run/secrets/db_password` |
| empty | a YAML key or a declaration, not an assignment |
| anything else, ≥12 chars | **LITERAL — do not commit** |

**PLANT A POSITIVE CONTROL FILE AND CLASSIFY IT IN THE SAME RUN.** Two lines: one
`export X="${X}"` and one `export X="a-long-literal-value"`. The run must report exactly one
reference and one literal. Without it this is an ordinary grep — and an ordinary grep that
silently matches nothing reports a clean tree, which is the worst possible failure here
because the output is indistinguishable from success.

**Expect false positives, and clear them with their own control.** Prose matches: a comment
reading `# Mediated secret: the Odoo key arrives as…` matches `secret:` and looks like an
assignment. Clear it by testing whether the line starts with `#` — and pair that with a line
you *know* is not a comment, or the check cannot discriminate.

**Then count the copies before you write the finding.** The three literals found this way were
in one directory the scan looked at and in **22 build directories** on the same host. §2.21:
a remediation applied to one copy is a moved problem, and a finding that names one file
understates the exposure by a factor of twenty-two.

**Name what you held back, in the commit and in a README beside it.** The next person sees
files present on the host and absent from git, concludes the commit was incomplete, and runs
`git add`. That is one command away from the exposure you just prevented.

---

## HOW TO GIVE A SCRIPT A CREDENTIAL — THE SANCTIONED PATTERN

*Ratified 2026-09-07. This is the standard. Nothing else is.*

**Read this first, because it is the actual finding.** Three cleartext credentials were found
on host03 — a live Odoo API key among them — in 66 files. Rotating 66 values does not close
it. **The next incident produces the sixty-seventh**, because:

> An operational script needs a credential at the moment it runs, and the estate offers no
> ordinary way to give it one — so whoever was mid-incident pasted it inline, and the file
> outlived the incident.

**A rule that is harder than the thing it forbids does not get followed under incident
pressure.** So the fix is not a prohibition, it is an easier path. It already exists, twelve
lines from where the inline pastes were found, in Foundation's own `entrypoint.sh`.

### The three lines. Copy them.

```sh
if [ -f /run/secrets/NAME ]; then
  MY_VAR="$(cat /run/secrets/NAME)"; export MY_VAR
  log "MY_VAR loaded from swarm secret (length ${#MY_VAR}, value not logged)"
else
  log "MY_VAR NOT present -- this path fails closed"
fi
```

Create the secret **without anyone reading it** — if the value already exists somewhere on
the host, pipe it; read and write are one pipe, and it never becomes a shell variable, a
file, or an argument:

```sh
sudo docker exec <container> printenv THE_VAR | tr -d '\n' \
  | sudo docker secret create the_name_$(date +%Y%m%d) -
```

`tr -d '\n'` is load-bearing: `printenv` appends a newline the real caller does not send, and
a trailing byte produces a secret that never matches — a failure indistinguishable from a
wrong credential.

Then reference it by name only, in the stack file:

```yaml
    secrets:
      - the_name
secrets:
  the_name:
    external: true
    name: the_name_20260907
```

### Why this shape and not another

* The **value never appears in the stack file** and is never disclosed by `docker service inspect`.
* It fails closed and **says so in the log** — a length, never a value.
* One secret per caller means each is **separately deletable**. A shared value makes two
  systems one principal, and then neither can be revoked without breaking the other.

### The trap it creates, which you must know before you debug it

`docker exec <c> printenv X` starts a **new** process from the container's `Config.Env`,
which never held these values. It reports **UNSET while the running server has them**. Read
`/proc/<pid>/environ` of the serving process, and carry a control in the same read (assert
`HOSTNAME` is found) — `pgrep` is absent from these images, and a failed read looks exactly
like an absent variable. This cost a full cycle before it was written down.

### Containment when you find an inline paste and cannot rotate yet

`chmod 0600`, having **recorded the before-state first** so it is reversible. Do not move,
delete, or edit the file, and **do not rotate a key that may be load-bearing for something
you are mid-way through proving green** — that breaks the thing you just fixed and costs
hours proving the two were unrelated. Measured 2026-09-07: all 66 files were world-readable
(44 at `644`, 22 at `755`) on a host running 87 containers.

---

## PORT'S UPSERT OVERWRITES A STRING PROPERTY WHOLESALE

**`merge=true` is top-level only.** It merges *properties*, not the contents of one. Writing
`decision_text` or `description` on an existing entity **replaces the entire body** — there
is no append, and what was there is gone.

So: **never "add a note" to an existing decision or defect.** File a new entity and link it
by identifier from both sides. Read-modify-write is not an option either, because the read
path does not reliably return long property bodies.

Cost of learning this the other way, twice in one night: lost entity bodies that had to be
reconstructed from memory.

---

## THE FILE YOU EDITED MAY NOT BE THE FILE THE TOOL READS

*2026-09-07. Third member of this family in one day.*

**EasyPanel regenerates a service's `code/` directory from its own database on every
deploy.** The Dockerfile on disk is an *output*, not an input. Editing it does nothing:
the next deploy overwrites it with the stored copy and builds that.

How it was caught, and why nothing weaker would have caught it: the file was rewritten,
the change **verified on disk by reading it back**, and the deploy then built a Dockerfile
containing the *old* content — while the hand-made backup left beside it had been
**deleted**. The write succeeded, the read-back confirmed it, and the tool used something
else entirely.

The only writable input is the API: `updateAppSourceDockerfile` (or `updateAppBuild` /
`updateAppSourceGit` for the other source types).

**The family.** Same shape as *read where the PROCESS reads, not where it is convenient*
(`docker exec printenv` vs `/proc/<pid>/environ`), and as *the export is the write*. In all
three, a surface that looks authoritative is a copy, and the real one is somewhere else.
**Before editing any config a tool consumes, establish that the tool reads THAT file** —
change it, run the tool, and confirm the tool's behaviour changed. A read-back proves the
write landed; it does not prove anything reads it.

---

## RE-RUN THE TOOL'S OWN COMMAND TO SEE THE REAL ERROR

*Same incident, and it is what turned two failed deploys into a diagnosis.*

An API wrapper reported:

```
Command failed with exit code 1: docker buildx build ... (BAD_REQUEST, HTTP 400)
```

`BAD_REQUEST` is the **wrapper's** framing. It says the call failed; it says nothing about
why, and "400" invites you to look for a malformed request that does not exist.

Good wrappers echo the command they ran. **Run it yourself, verbatim, and read the stderr
the wrapper swallowed.** Here that produced the actual cause in one line:

```
failed to resolve source metadata for docker.io/library/isola-portal-web:lumen-0c22d82:
pull access denied, repository does not exist or may require authorization
```

— a `FROM` pinned to a tag that only ever existed locally and had since been pruned, so
buildx fell through to Docker Hub. Nothing about the wrapper's message pointed there, and
two hypotheses were formed and discarded before the real command was run. One of them
(*"buildx cannot see local images"*) was **disproved by an A/B in the same run**: plain
`docker build` and `docker buildx build` both resolved the identical one-line Dockerfile.

**Do this before hypothesising, not after.** And when the re-run touches production, check
what it is allowed to overwrite first — here it could only rewrite a tag whose image was
already pinned under a second name, so the reproduction was safe by construction.

---

## OPERATIONS THAT SUCCEED BY DOING NOTHING

*2026-09-07. The hardest one to catch, because the failure signal is **silence**.*

A whole class of commands **exit 0 having done nothing at all**, and their success is
indistinguishable from a real pass:

* a syntax check run against **an empty file**
* a grep or `--include` whose pattern **matched nothing**
* a filter (`pnpm --filter`, `docker ps --filter`, `jq`) that **selected no targets**
* a diff between **two empty extractions**
* a test suite that **collected zero tests**

All of them print nothing, return 0, and look exactly like the thing working.

**The instance.** A new deploy script was syntax-checked with `bash -n` and reported
`BASH SYNTAX OK`. It had validated an **empty file** — a relative path had resolved against
the wrong working directory, so the read that was supposed to produce the script produced
nothing, and the copy that followed shipped 0 bytes. Two *real* controls were in the same
run (a deliberately broken script was rejected, a trivial one accepted) and **both still
passed**, because they tested `bash -n` rather than the file. The check was fine. The input
was empty.

**What actually caught it** was a fourth line that had nothing to do with syntax: a
fail-closed probe running the script with no arguments, which should have printed
`commit sha required` and printed **nothing**. A silence where an error belonged.

### The rule

**Assert the SIZE of what you are about to check, not only the result of checking it.**

* Print the byte count or line count of every input, next to the verdict. `OK` beside
  `bytes=0` is self-evidently vacuous; `OK` alone is not.
* When a file crosses a machine, **compare the count on both sides**. Here: 14,160 bytes
  locally, 14,160 in the staging copy, 14,160 on the host — three numbers that agree.
* **Use absolute paths in anything that reads a file to feed a check.** A relative path is
  resolved against a working directory you did not necessarily set, and PowerShell's .NET
  methods do not follow `Set-Location`.
* Give the harness **a probe that must produce OUTPUT**, not merely exit 0 — an error path
  you deliberately trigger. An empty result there is a broken harness, always.

**A control that tests the TOOL does not test the INPUT.** Both controls in that run were
correct and both were beside the point. This is the sibling of *when a probe can only say
yes, it is not a probe* above, and of CLAUDE.md §2.11's `--include` that matched nothing —
and it is the sharper version, because there the check reported failure and here it
reported success.
