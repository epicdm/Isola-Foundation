# Foundation-360 accepts a SET of service tokens — promotion runbook

**Date:** 2026-09-07 · **Option B, as ruled.** A is not being taken.
**Code change:** `artifacts/isola/lib/customer-360/service-auth.ts`, `lib/engines.ts`, tests.
**Deploy change:** `deploy/entrypoint.sh` + `deploy/stack.yml` — **which live only on host03**, see
the finding at the bottom.

---

## 1. What was actually wrong — measured, not inferred

`isola-lumen-prod` shows an empty customer screen because Foundation refuses its bearer.
The reason is not a missing credential. **Production already has its own token.** Foundation
had simply never been told about it.

Salted-digest comparison, one random salt, all three digests computed in-container so no
value ever entered a transcript:

| holder | digest (12 hex of `sha256(salt‖value)`) |
|---|---|
| control — the literal string `control`, in all three containers | `cc283a43d05b` (identical → the pipelines are comparable) |
| control — `ISOLA_360_SERVICE_TENANT_ID`, all three | `096c7957b41f` (identical → the method detects sameness) |
| `isola_isola-lumen-api` (staging) `ISOLA_360_SERVICE_TOKEN` | `37e425f8a4a8` |
| Foundation's running `next-server` (pid 169) expected value | **`37e425f8a4a8`** — same |
| `isola_isola-lumen-api-prod` `ISOLA_360_SERVICE_TOKEN` | **`d25ba0f58ed5`** — different |

Confirmed end-to-end over HTTP, the same four requests issued from each side:

| from | REAL token | WRONG token | no header | reach control `GET /` |
|---|---|---|---|---|
| staging | **200**, 96 bytes | 401 | 401 | 200 |
| production | **401** | 401 | 401 | 200 |

The staging row is the positive control that makes the production row mean something: the
path, the header shape and the host are all proven good in the same run. Production's 401
is a **wrong credential**, not a wrong request.

### The contradiction from the previous cycle, settled

`ISOLA_360_SERVICE_TOKEN` reads UNSET under `docker exec` while the server has it, because
`deploy/entrypoint.sh` lines 47–49 read the swarm secret file and `export` it into the
process it launches. `docker exec` starts a **new** process from the container's
`Config.Env`, which never contained it. The same probe output shows both halves at once:
`next-server` (pid 169) carries the name, the probe's own shell (pid 73261) does not, and
`HOSTNAME` is present in both — so the read worked and the difference is real.

The other three candidates were tested and each said NO:
* **swarm configs** — none; secrets only (`isola_360_service_token_20260830`).
* **build-time inlining** — all three real env names still appear in 20 files under
  `.next/server`, so they are runtime reads. The planted fake name
  `ISOLA_360_DEFINITELY_NOT_A_REAL_VAR` returned 0, which is what makes that grep mean
  anything.
* **a different process serving the route** — pid 169's cwd is `/repo/artifacts/isola`,
  and `.next/BUILD_ID` (2026-09-05 11:42) is **newer** than `service-auth.ts`
  (11:33). The running build is the source that was read.

---

## 2. Why a SET, and not production borrowing staging's value

Copying makes production and staging **one principal**. After that, staging's access cannot
be revoked without taking production down with it — and `def-staging-serves-real-customer-data-2026-09-07`
is precisely the reason someone will want to revoke staging's access.

A set keeps them separable, and the separability is asserted in a test
(`REVOCATION WORKS: dropping one entry refuses that caller and only that caller`) rather
than assumed.

**A set of tokens is a set of CALLERS, not a set of tenants.** Every accepted credential
still resolves the single `ISOLA_360_SERVICE_TENANT_ID`, and the tenant is still absent
from `resolveServiceCaller`'s signature, so the 2026-08-29 construction ruling is intact.
That is also asserted, not described.

---

## 3. The code change (done, reviewable, NOT deployed)

`serviceAuthEnvFrom` now enumerates `ISOLA_360_SERVICE_TOKEN` **plus** any
`ISOLA_360_SERVICE_TOKEN_<LABEL>`. Each label is its own variable, therefore its own swarm
secret, therefore independently creatable and deletable.

Three properties that had to survive the change, each with its own test:

1. **Fail closed.** An empty set refuses, exactly as an empty string did. And a set of
   nothing but blanks is an **empty set, not a set of one** — an empty secret file must not
   become an accepted empty token.
2. **No early exit** in the comparison loop. Exiting on first match would make elapsed time
   depend on *which* credential was presented. Comparing all candidates leaks only the set
   size, which is not secret.
3. **The operator readout cannot disagree with the door.** `lib/engines.ts` now answers
   "configured?" from the *same* enumerator, because a screen that reads one variable while
   the door reads a set is how production spent this cycle looking unconfigured while
   holding a perfectly good token.

**Sabotage control, run:** removing blank-filtering from both the enumerator and the guard
turns exactly 2 tests red; restoring returns 30/30. The suite is not vacuous.
`44/44` green across `service-auth.test.ts` and `route-context.caller.test.ts`; typecheck
clean for every file this change touches.

---

## 4. The deploy delta — owner action, three steps

### Step 1 — create the secret without anyone reading it

Production's token already exists in the API container's environment. It can be piped
straight into a swarm secret, so **neither the owner nor this lane ever sees the value**:

```bash
PROD=$(sudo docker ps --format '{{.Names}}' | grep -m1 isola_isola-lumen-api-prod)
sudo docker exec "$PROD" printenv ISOLA_360_SERVICE_TOKEN \
  | tr -d '\n' \
  | sudo docker secret create isola_360_service_token_prod_20260907 -
```

`tr -d '\n'` matters: `printenv` appends a newline that the HTTP caller does not send, and a
trailing newline would produce a secret that never matches.

Verify by length only — `sudo docker secret inspect isola_360_service_token_prod_20260907`
shows metadata, never the value.

### Step 2 — `deploy/entrypoint.sh`, mirroring lines 47–55 exactly

```sh
if [ -f /run/secrets/isola_360_service_token_prod ]; then
  ISOLA_360_SERVICE_TOKEN_PROD="$(cat /run/secrets/isola_360_service_token_prod)"
  export ISOLA_360_SERVICE_TOKEN_PROD
  log "isola-360 PROD service token loaded from swarm secret (length ${#ISOLA_360_SERVICE_TOKEN_PROD}, value not logged)"
else
  log "isola-360 PROD service token NOT present -- production callers are refused (fail closed)"
fi
```

### Step 3 — `deploy/stack.yml`

Under the `app` service's `secrets:` list (line ~74):

```yaml
      - isola_360_service_token_prod
```

Under the top-level `secrets:` block (line ~113):

```yaml
  isola_360_service_token_prod:
    external: true
    name: isola_360_service_token_prod_20260907
```

Nothing about staging's existing secret changes. It keeps working, by construction and by
test.

---

## 5. Acceptance — every negative paired with its positive control

| # | check | control that makes it mean something |
|---|---|---|
| 1 | from the prod API container, `GET /api/v1/customers/search` with its own token → **200** | the same call with a wrong token → **401** |
| 2 | from the **staging** API container, the same call → still **200** | this is the no-regression control: the set must not have cost the existing caller its access |
| 3 | Foundation's env readout reports the 360 token as configured | it reported configured before the change too, from one variable — so also assert the count is now **2** |
| 4 | `/customers` on `isola-lumen-prod` renders real Odoo rows in the owner's browser | the owner performs it; a 200 from an API is not a rendered screen |

Deferred but owed: **a revocation drill** — delete the staging secret in a scratch stack and
prove production survives. Until that is run, "independently revocable" is a design claim
backed by a unit test, not by the substrate.

Also still owed on the next deploy of `isola-lumen-api-prod` (not this one, which is
Foundation): verify `DJANGO_SECRET_KEY` **by name and length only**, inside the running
container.

---

## 6. Finding to file, not to act on

**The deploy artefacts that wire Foundation's credentials are not version controlled.**
`deploy/Dockerfile`, `deploy/entrypoint.sh` and `deploy/stack.yml` exist only on host03, as
one directory per build under `/home/epicadmin/builds/isola360-<sha>/deploy/`, hand-edited
in place with manual backups beside them — `entrypoint.sh.pre-servicetoken`,
`stack.yml.pre-prododoo`, `stack.yml.bak-preS8W1`, `stack.yml.pre-servicetoken-20260830`.
`git ls-files deploy` in this repository returns **0**.

The build tree is otherwise this repository (same `CLAUDE.md`, `artifacts/`, `lib/`,
`services/`, `tsconfig.json`), so `deploy/` is the one part of a production-depended
service that no review ever sees, that no branch protects, and whose history is a naming
convention. The change in §4 has to be applied there, which is the immediate reason it is
worth saying out loud: **this runbook exists because the file it describes cannot be
committed.**
