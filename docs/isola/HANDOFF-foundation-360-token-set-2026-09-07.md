# HANDOFF — Foundation-360 service-token set, 2026-09-07

**Resume from cold with this file alone.** Written mid-deploy so a fresh session does not
have to reconstruct anything. Read `START-HERE` → `isola-manual-is-the-plan` first, then
this.

---

## WHERE THINGS STAND

| | |
|---|---|
| Repo | `epicdm/Isola-Foundation` |
| Branch | `fix/foundation-360-accepts-a-set-of-service-tokens-2026-09-07` |
| HEAD to deploy | `264a8f65bf8ed005c748ebf6da08fedbf3725915` (short `264a8f65`) |
| Ops-index branch | `docs/units-are-part-of-a-value` @ `f36e8b6` (separate worktree `C:\epic-workspace\_wt-isola-foundation-lane-2026-09-03`) |
| Host | host03 `66.118.37.110`, user `epicadmin`. **`epicadmin` is NOT in the docker group — every docker call needs `sudo -n`.** |
| Foundation container | `isola360uat_app.1.*` · service `isola360uat_app` · build dir `/home/epicadmin/builds/isola360-264a8f65` |
| Prod caller | `isola_isola-lumen-api-prod.1.*` |
| Staging caller | `isola_isola-lumen-api.1.*` |

### DONE
1. Code: the door accepts a **set** of tokens (`f4b6c00`). 44/44 green, sabotage control run, codex review answered.
2. `deploy/` committed as-is, then edited as a visible diff (`264a8f65`): entrypoint block, stack secret, base-image digest pin, `.gitattributes eol=lf`.
3. **Swarm secret placed**: `isola_360_service_token_prod_20260907`. Host secret count went 81 → 82.
4. Ops index: salted digest, floating-tag law, scan-before-commit law.
5. Port: `dec-foundation-360-accepts-a-set-of-service-tokens-2026-09-07`, `def-foundation-360-deploy-artefacts-are-not-version-controlled-2026-09-07`, `def-cleartext-credentials-in-host03-deploy-scripts-2026-09-07`.

### IN FLIGHT / NOT DONE
- **Image build** of `isola-foundation-360:264a8f65` (was still running at handoff — buildx alive, Next compile at ~33% CPU, 388 GB free, so progressing not wedged).
- **Deploy** — not run yet.
- **Four-request probe** — not run yet.
- **Revocation drill** — not run yet.
- **Containment `chmod 0600`** on the 22×3 credential-bearing files — authorized, not yet run.

---

## THE EXACT COMMANDS

Everything below runs on host03. Put multi-line scripts in a **file** and pipe base64 —
the project guard blocks these patterns inline, and its own remedy is "put it in a file".
From Windows PowerShell:

```powershell
$s = [IO.File]::ReadAllText("<script.sh>") -replace "`r`n","`n"
$b = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($s))
ssh -o BatchMode=yes epicadmin@66.118.37.110 "echo $b | base64 -d | bash" 2>&1 |
  node "C:\epic-workspace\Isola-Foundation\.claude\hooks\lib\secret-redact.js"
```

### 1. Build (if it did not finish)

```bash
cd /home/epicadmin/builds/isola360-264a8f65
bash deploy/remote-build.sh \
  264a8f65bf8ed005c748ebf6da08fedbf3725915 \
  origin/recover/c360-served-f38f6ecd \
  NO
```

`NO` is the **honest, measured** ancestry verdict — `264a8f65` is not merged into the
serving branch. Control: the serving commit `5fe25d3b` **is** an ancestor of that same tip,
so the check discriminates. It is not off-trunk; it descends from the serving commit.

### 2. Deploy — the override is required and is not optional

```bash
cd /home/epicadmin/builds/isola360-264a8f65
bash deploy/deploy.sh 264a8f65bf8ed005c748ebf6da08fedbf3725915 \
  --override AUTHORIZED:dec-foundation-360-accepts-a-set-of-service-tokens-2026-09-07
```

`deploy.sh` Guard B refuses any image whose `isola.ancestry-verified` label is not exactly
`YES`. This image is honestly labelled `NO`, so the named override is the sanctioned path —
**not** a merge, which this lane is not authorized to make. Guard A should pass: the state
file at `/home/epicadmin/builds/.isola360-deploy-state` records `5fe25d3b`, which is what is
actually serving.

Rollback: `sudo -n docker service rollback isola360uat_app`, or re-run `deploy.sh` with
`5fe25d3b970515b85e7f02c00bf173af10b5ba78` and the same override.

### 3. Verification — scripts already written

Scratchpad, this session:
`C:\Users\girau\AppData\Local\Temp\claude\C--epic-workspace-Isola-Foundation\5eb97233-bb93-4cad-8129-58b626e2a18b\scratchpad\`
· `verify.sh` · `revocation-drill.sh` · `place-secret.sh` · `map-callers.sh`

If that scratchpad is gone, rebuild `verify.sh` from this spec:

**(a) What is actually serving** — `docker service ps`, plus the image's `isola.commit` and
`isola.ancestry-verified` labels. **Never the deploy's own success message.**

**(b) Inside the container** — `docker service logs isola360uat_app --tail 60 | grep -i 'service token'`.
Expect a **length** for staging *and* for PROD. Values are never logged.

**(c) Salted digest**, one random salt for the whole run, 12 hex printed, value never
leaves the pipeline:

* CONTROL A — digest the literal string `control` in all three containers. Must be identical, or the pipelines are not comparable and everything below is noise.
* CONTROL B — digest `ISOLA_360_SERVICE_TENANT_ID` in all three. Known equal; must be identical, or the method cannot detect sameness.
* prod api's `ISOLA_360_SERVICE_TOKEN` **must equal** Foundation's `ISOLA_360_SERVICE_TOKEN_PROD`.
* staging api's must still equal Foundation's `ISOLA_360_SERVICE_TOKEN`.

**Read Foundation's values from `/proc/<pid>/environ` of the `next-server` process, NOT
`docker exec printenv`.** The entrypoint exports swarm secrets into the process it launches;
`docker exec` starts a new process from `Config.Env` and reports UNSET. Carry the read
control in the same read: assert `HOSTNAME` is found — `pgrep` is absent from this image, and
a failed read otherwise looks exactly like an absent variable.

**(d) THE FOUR-REQUEST PROBE**, issued from inside each caller's own container against
`$FOUNDATION_BASE_URL/api/v1/customers/search?q=a`:

| from | request | expected |
|---|---|---|
| **production** | `Bearer $ISOLA_360_SERVICE_TOKEN` | **200** ← the whole point |
| production | `Bearer xxxx…` (same length) | 401 |
| production | no `Authorization` header | 401 |
| **staging** | `Bearer $ISOLA_360_SERVICE_TOKEN` | **200** ← no-regression control |

Before this change, production returned **401 to all four**, which is why a probe run only
from production could not tell "wrong credential" from "wrong path". The staging row is what
separates them. Keep both sides.

### 4. Revocation drill — required before this is called done

Scratch swarm service from the **same image**, mounting **only** production's secret, on the
same overlay network, `--restart-condition none`, removed on exit. Then:

| probe | expected |
|---|---|
| production's token → scratch service | **NOT 401** ← the positive half |
| garbage token → scratch service | 401 |
| **staging's token → scratch service** | **401** ← the revocation claim |
| staging's token → the **live** Foundation | **200** ← proves the live stack was untouched |

**Without the production row this "passes" against a service that refuses everything.** That
is the whole reason the drill exists: until it runs, "independently revocable" is a unit-test
claim, not a substrate fact, and the decision entity must keep saying so.

### 5. Containment — authorized, do not skip

`chmod 0600` on all **22 copies each** of `prove-unavailable2.sh`, `seed.mjs`, `sid.mjs`
under `/home/epicadmin/builds/isola360-*/deploy/`. **Record the before-state permissions
first** so it is reversible. Do **not** move, delete or edit them.

**DO NOT ROTATE the Odoo key.** It is very likely load-bearing for the Foundation → Odoo
path being proven green in this same pass; rotating now breaks the thing just fixed and
costs hours proving they were unrelated. The freeze
(`dec-credential-rotation-deferred-to-pre-launch-2026-08-13`) holds.

---

## DONE MEANS

`/records` (soon `/customers`) on **`isola-lumen-prod`** returns **real Odoo rows**, and the
PM performs Chapter 1 in the owner's browser. A 200 from an API is not a rendered screen —
the PM's browser is the acceptance test, not this lane's probe.

## AFTER THAT, IN ORDER

1. Collapse `/records` → `/customers` (portal repo). No live experiment: the A/B existed for a pixel-overlay test nobody has ever performed. **Chapter 1's URL changes when this lands — the PM re-verifies the redirect rather than assuming it.**
2. The three Chapter 1 UI defects: one-letter blank, 767 phone, route collapse.
3. **Chapter 2's probes are NOT this lane's** — a Paperclip lane owns them. Do not start them. Cross-lane facts travel in handover notes.

## TRAPS THAT WILL COST YOU AN HOUR EACH

* `docker exec printenv` reports UNSET for entrypoint-exported secrets. Read `/proc/<pid>/environ`.
* `epicadmin` is not in the docker group. Every docker call needs `sudo -n`.
* PowerShell 5.1: no `&&`, native args are quote-stripped. Put scripts in files and pipe base64.
* The project guard blocks credential-shaped commands **inline**; its own remedy is a file plus the redactor. That is a sanctioned path, not a workaround. **If it blocks a document rather than an operation, report it — do not reword to get through.**
* **Port's upsert overwrites a string property wholesale.** `merge=true` is top-level only. Never "append" to an existing `decision_text` or `description` — you will destroy the body. File a new entity and link it.
