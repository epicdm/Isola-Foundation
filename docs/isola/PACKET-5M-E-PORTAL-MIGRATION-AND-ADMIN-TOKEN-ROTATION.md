# Packet 5M-E — portal-api migration and GATEWAY_ADMIN_TOKEN rotation

**Status: NOT EXECUTED.** This document is the procedure. Packets 5M-R and 5M-RR were
repository, build and Port work only. Nothing here has been run.

**Why this exists.** `isola_isola-portal-api` holds six credentials as plaintext
environment variables, one of which is the live gateway administrator token. An EasyPanel
app service cannot mount a Docker secret — measured against the panel's own OpenAPI:
app-service mount types are exactly `bind`, `volume` and `file`, and `file` requires
inline `content`, which is the same plaintext class, persisted. So the token cannot be
rotated while it lives there, because rotating it would mean writing a fresh production
credential into another plaintext field. Moving the service to a hand-managed Swarm stack
is what unblocks the rotation. Steps 19–22 then perform it.

**Authority.** Steps 7, 12, 15, 18, 19, 20, 21 and 22 mutate production. Each requires the
owner's explicit go-ahead **for the operation as described**. If a step's measured blast
radius differs materially from what is written here, STOP and re-ask. Refusing is
compliance, not obstruction; an authorization is not a token to be spent on whatever the
task turns out to be.

**Owner-only throughout:** creating or destroying any credential, any Meta asset change,
any real customer contact, and the retirement in step 18.

---

## Fixed inputs

| Thing | Value |
|---|---|
| Portal release commit | **`115291e`** (`115291e2bb20b209e064cbf2db30f9092f9c7568`) — branch `feat/secret-file-support-2026-08-20`. Source tree `79351a446d6e517e6cf3ac3b1237321652319ac8`, backend tree `bba5cbd17d4d2bc272d13fd70b93452b5205d5e7`. Supersedes `afaba01`, `513e552`, `32c8b80`, `90fdbb1`, `5c5bed3`. |
| Portal image (BUILT) | **`isola-portal-api:115291e`**, id **`0a7a43c27cf7`**. Built from the exact commit above, `BUILD_EXIT=0` captured directly (not through a pipe). Prior tags verified byte-unchanged by the build script's own immutability control: `afaba01`=`f77e6516f66e`, `513e552`=`f80f560ec14f`, `rollback-7f58a926579e`=`6000d3efa7dd`. Nothing was deleted. |
| Artifact release gate | Workflow **`release gate (artifact-tied)`**, run **32508930356**, job **96855302664**, conclusion `success`. Identity record read from the run's own log: `requested_sha == head_sha == 115291e2bb20b209e064cbf2db30f9092f9c7568`, `source_tree=79351a446d6e517e6cf3ac3b1237321652319ac8`, `backend_tree=bba5cbd17d4d2bc272d13fd70b93452b5205d5e7` — all three identical to the tree the image was built from. It checks out the RELEASE COMMIT, not GitHub's `refs/pull/N/merge`, and refuses if they disagree or if HEAD is a synthetic merge commit. |
| Node set | **338 nodes**, SHA-256 **`d090a0fa9e0b3c03928e5000cc2338dbf50c8c2fb068552c939a57aebf181c34`** — byte-identical to the set recorded for `afaba01`, which is the evidence that ER4H changed **build and packaging only** and touched no test. |
| Release-gating test command | `pytest apps/users/tests/ apps/isola_provisioning/tests/ config/tests/ common/tests/ --create-db -p no:cacheprovider -q --tb=short -rf` — **identical in CI and in candidate-image acceptance.** In the image it must now be run with `.test.env` mounted read-only (see the note below the table). Measured on `115291e`: **338 passed, 0 failed, 0 errors**, `PYTEST_EXIT=0`, 486s. |
| ~~Node-set parity (superseded)~~ | ~~**327 nodes**, normalized SHA-256 `005d2ae68ffe759a0e2839c6cbc79a8d049d207bf46c01d631547e918f4a46ce`, identical in CI and in the image. Suite result in the image: 327 passed, 0 failed, 0 errors.~~ **Superseded by the `115291e` row above (338 nodes, `d090a0fa…`).** The 327 figure belonged to release `513e552`; the set grew to 338 at `afaba01` when Packet 5M-ER4L added the migration-owner lock tests, and is unchanged at `115291e`. Both figures were correct for their own commit — this row is struck rather than deleted so the two numbers are never mistaken for a discrepancy. Note that the in-image half of that parity claim was only obtainable because the credential file shipped inside the artifact; see the operating-fact note above. |
| Credentials | **Six LIVE**, each mapped to an external Docker secret (table below). The loader SUPPORTS eight `secret_env()` names — the six plus `STRIPE_LIVE_SECRET_KEY` and `STRIPE_TEST_SECRET_KEY`, which are ABSENT from the live service and fall back to placeholder defaults. Supporting a name is not holding a credential. |
| Rendered stack contract (verified) | 29 carried non-secret keys + 3 template keys + 6 `*_FILE` pointers = 38 rendered env keys; 6 secret `source:`→`target:` mappings; 6 external declarations; 0 plaintext occurrences of any credential key; `PORTAL_RUN_MIGRATIONS: "false"`; 0 active Traefik labels (route disabled by default); commented cutover `priority: 1000`; image pinned to the final candidate; 0 writable volumes. `docker stack config` exit 0; sabotage removal of a required secret declaration → non-zero; canonical render revalidated exit 0. |
| Gateway release commit | `b05abf1` — branch `feat/credential-rotation-grace-2026-08-20` |
| Gateway image (built, verified) | `isola-gateway:admingrace-b05abf1`, id `e1ea6bc0d41d` |
| Live service being replaced | `isola_isola-portal-api` |
| New stack / service | `isolaportal` / `isolaportal_api` |
| Public hostname | `isola-portal.saas00.epic.dm` |
| Host | `epicadmin@66.118.37.110` (host03) |
| Traefik dynamic config | `/etc/easypanel/traefik/config/main.yaml` |

> **CHANGE OF OPERATING FACT, 2026-08-21 (Packet 5M-ER4H) — read this before running
> any in-image test step in this runbook.**
>
> Up to and including `afaba01`, the runtime image shipped `packages/backend/.test.env`
> at `/app/.test.env`. That is the defect 5M-ER4H removed, and the removal is proven
> twice: the file is absent from the merged filesystem, **and** a scan of every layer
> tar — 95,738 entries, with a positive control that located `app/manage.py` — finds no
> dotenv file in any layer. The merged-filesystem check alone would not have been
> enough: a file copied in one layer and deleted in a later one is invisible to `find`
> and still recoverable from `docker save`.
>
> **The consequence is operational and is not optional.** `setup.cfg` declares
> `env_files = .test.env` under pytest-dotenv with `env_override_existing_values = 1`,
> so that file supplies the suite's configuration *and overrides anything passed with
> `-e`*. Measured on `115291e`, one pair of runs against the same image:
>
> | Run | Result |
> |---|---|
> | `.test.env` mounted read-only at test time | **338 passed, 0 failed, 0 errors**, `PYTEST_EXIT=0`, 486s |
> | no mount (the contrasting control) | `ImproperlyConfigured: Set the DJANGO_SECRET_KEY environment variable`, exit 1 |
>
> So the earlier "327/327 in the image" figure was obtainable **only because the
> credential file shipped inside the artifact**. Node-set parity must now be
> established by mounting the file for the duration of the run, never by baking it in:
>
> ```
> docker run --rm --network <net> \
>   -v <build-tree>/packages/backend/.test.env:/app/.test.env:ro \
>   --entrypoint sh isola-portal-api:115291e -c 'cd /app && pytest …'
> ```
>
> The fixture must also answer to the hostnames and role that file names — host `db`,
> host `redis`, role/database `backend` — which is why the CI job aliases them. A step
> that omits the mount will fail in a way that **looks like a regression in the
> candidate** and is not one.
>
> **NOTE, 2026-08-21 (Packet 5M-ER4).** The `32c8b80` row this replaces cited "CI run
> 32444300921 green". That run was green, but it tested **`refs/pull/68/merge`** —
> GitHub's synthetic merge of the branch into trunk — not the release commit. It
> collected 513 nodes because trunk carries 261 test nodes the release does not.
> Nothing was wrong with the candidate (the release's 252 nodes were a strict subset
> and all passed), but a PR gate certifies a tree that is not the artifact. That is why
> the artifact-tied gate above now exists and is the row that matters for 5M-E.

### Secret mappings, by name only

Six Swarm secrets carry the six credential-bearing variables. No value appears in this
document, in any command argument, or in any transcript.

| Env pointer | Swarm secret (external) | Mounted as |
|---|---|---|
| `DJANGO_SECRET_KEY_FILE` | `isola_portal_django_secret_key_v1` | `/run/secrets/portal_django_secret_key` |
| `HASHID_FIELD_SALT_FILE` | `isola_portal_hashid_salt_v1` | `/run/secrets/portal_hashid_salt` |
| `DATABASE_URL_FILE` | `isola_portal_database_url_v1` | `/run/secrets/portal_database_url` |
| `REDIS_CONNECTION_FILE` | `isola_portal_redis_connection_v1` | `/run/secrets/portal_redis_connection` |
| `PAPERCLIP_BOARD_TOKEN_FILE` | `isola_portal_paperclip_board_token_v1` | `/run/secrets/portal_paperclip_board_token` |
| `ISOLA_GATEWAY_ADMIN_TOKEN_FILE` | `isola_portal_gateway_admin_token_v1` | `/run/secrets/portal_gateway_admin_token` |

> **Six live credentials, eight loader-supported names — reconciled 2026-08-20.**
> The packet commissioning this runbook expected **eight** portal secret mappings.
> Measured against the live service, there are **six** credential-bearing variables,
> and the six rows above are the complete set.
>
> The number eight is real, but it counts something else: `config/settings.py` has
> **eight `secret_env()` call sites**. Two of them — `STRIPE_LIVE_SECRET_KEY` and
> `STRIPE_TEST_SECRET_KEY` — are **absent from the live service** and fall back to
> `sk_<CHANGE_ME>` placeholder defaults, i.e. Stripe is not configured on this
> service. The loader supports them so that they need no code change if Stripe is
> ever enabled; supporting a name is not the same as holding a credential.
>
> An earlier note here attributed the eight to the renderer's exclusion set (six
> credentials plus `DEPLOY_TIMESTAMP` and `GIT_SHA`). That arithmetic also reaches
> eight, which is exactly why it was believable and exactly why it was worth
> checking: **two different derivations landing on the same number made the wrong
> one look confirmed.** The loader count is the one the packet meant.
>
> **No credential is being invented to satisfy a count.** If Stripe is to be
> configured, that is a separate decision with its own keys, and this table is
> extended before step 7 — it is not something to discover mid-window.


---

## A. Pre-flight (steps 1–5) — no production change

### 1. Capture the baseline you may have to restore

```bash
sudo mkdir -p /opt/isola/backup
sudo docker service inspect isola_isola-portal-api \
  > /opt/isola/backup/portal-api-baseline-$(date +%Y%m%d-%H%M%S).json
sudo cp /etc/easypanel/traefik/config/main.yaml \
  /opt/isola/backup/main.yaml.$(date +%Y%m%d-%H%M%S)
sudo docker service ls --format '{{.Name}} {{.Replicas}}' | grep portal
```

**Expect:** `isola_isola-portal-api 1/1`, and both files written.

**Do not proceed without them.** The baseline JSON is the only complete record of the live
environment. Step 9 reads the live service; after step 18 that source is gone. This file
IS the EasyPanel recovery record referenced in step 18.

### 2. Verify the release, and ship the WHOLE monorepo as build context

```bash
git -C <isola-portal> rev-parse HEAD          # expect 23c669f...
git -C <isola-portal> status --porcelain      # expect EMPTY
git -C <isola-portal> -c core.autocrlf=false archive --format=tar HEAD > /tmp/rel.tar
sha256sum /tmp/rel.tar
```

Record the sha. Two things about that command are load-bearing.

**`-c core.autocrlf=false` IS NOT OPTIONAL.** `git archive` HONOURS `core.autocrlf`,
so on a Windows checkout it ships CRLF even though the committed blobs are LF.
Measured 2026-08-21: the committed `packages/backend/.test.env` had 0 CR bytes, the
working tree had 42, and plain `git archive` produced 42. That single difference cost
two packets — see step 8.

**The context is the monorepo root, not `packages/backend`.** An
earlier version of this step archived `packages/backend` alone; that produced a
context in which the production Dockerfile cannot even resolve its `COPY` paths.
See step 8 for why.

Still verify the release tree and the absence of unrelated change:

```bash
git -C <isola-portal> diff --name-only cfcbe4f..23c669f          # expect only the release files
git -C <isola-portal> diff --name-only 8743ddc..23c669f          # expect only packages/backend/deploy/*
```

Use `git archive`, **never** `tar` of the working tree: on a Windows checkout
`core.autocrlf` smudges shell scripts to CRLF, and a carriage-returned shebang does
not execute in a Linux container. That mistake produced a false test failure during
5M-R.

### 3. Drift check — is the live service still what the baseline describes?

```bash
sudo docker service inspect isola_isola-portal-api \
  --format '{{.Version.Index}} {{.UpdatedAt}} {{.Spec.TaskTemplate.ContainerSpec.Image}}'
sudo docker service inspect isola_isola-portal-api \
  --format '{{range .Spec.TaskTemplate.ContainerSpec.Env}}{{println .}}{{end}}' \
  | cut -d= -f1 | sort > /tmp/keys.now
```

**Expect:** 39 key names, and an `UpdatedAt` you can account for. If the service has been
redeployed since 5M-R, the env set may have changed — re-run step 9's completeness
assertion before trusting the rendered stack. **A stale render is the failure mode that
takes a service down quietly.**

### 4. Confirm the execution window

Confirm with the owner, in writing, before any mutation:

- the operation is *"replace the EasyPanel portal-api service with a hand-managed
  secret-backed Swarm stack, then rotate the gateway administrator token"*;
- **downtime is accepted** — update order is `stop-first` by design, because the container
  is stateless (`mounts: []`) but a `start-first` roll would put two tasks through the
  startup script at once;
- the window is now, and a person is available for the full soak in step 17.

**Do not begin outside an agreed window.** Steps 15–18 change what the public hostname
serves.

### 5. Verify prerequisites

```bash
sudo docker network ls --format '{{.Name}}' | grep -E '^easypanel$|^easypanel-isola$'
sudo docker images --format '{{.Repository}}:{{.Tag}} {{.ID}}' | grep isola-gateway
df -h /var/lib/docker | tail -1
```

**Expect:** both networks present; `isola-gateway:admingrace-b05abf1` present with id
`e1ea6bc0d41d`; disk headroom for one image.

---

## B. EasyPanel token handoff (step 6) — owner

### 6. `/run/ep.key` requirements

Some steps may need the EasyPanel API to read or adjust the panel's own view of the
service. If so, the owner stages a **temporary** token at `/run/ep.key` and the following
rules apply without exception:

- the file is created by the owner, not by the operator, and not by an agent;
- **never interpolate the token into a command argument, a URL, a header written on a
  command line, or an environment variable** — read it inside the HTTP client from the
  file;
- never print it, never copy it into a document, a log, a Port entity or a transcript;
- it is revoked in **step 23**, and its absence is proven there;
- if no step actually requires the panel API, **do not stage it at all**. A credential
  that was never created cannot leak.

The panel's `listUsers` procedure **must not be called**: it is documented as returning
users without their passwords and in fact returns a live API token. That is a recorded P0.

---

## C. Build (steps 7–8)

### 7. Create the six external secrets — OWNER ONLY

Each value is the one the live service uses **today**, taken from the step-1 baseline.

```bash
printf '%s' "<value>" | sudo docker secret create isola_portal_django_secret_key_v1 -
printf '%s' "<value>" | sudo docker secret create isola_portal_hashid_salt_v1 -
printf '%s' "<value>" | sudo docker secret create isola_portal_database_url_v1 -
printf '%s' "<value>" | sudo docker secret create isola_portal_redis_connection_v1 -
printf '%s' "<value>" | sudo docker secret create isola_portal_paperclip_board_token_v1 -
printf '%s' "<value>" | sudo docker secret create isola_portal_gateway_admin_token_v1 -
```

Use `printf '%s'`, not `echo`, and run in a shell with history disabled.
**Trailing newline matters:** `config/secret_files.py` strips exactly one trailing `\n` or
`\r\n` and nothing else, so a value pasted with an extra blank line is wrong by one byte
and fails authentication in a way that looks like a bad credential rather than a bad paste.

Verify by name only:

```bash
sudo docker secret ls --format '{{.Name}}' | grep isola_portal_
```

**Expect:** exactly six names. Do not attempt to read a value; `docker secret inspect` does
not return one.

**Rollback:** remove any secret created in error and create it again. Secrets are
immutable — a wrong value is replaced by creating a `_v2` and swapping, never by editing.

### 8. Ship, verify integrity, and build — FROM THE MONOREPO ROOT

```bash
scp /tmp/rel.tar epicadmin@66.118.37.110:/tmp/rel.tar
ssh epicadmin@66.118.37.110
D=/opt/isola-portal-build/mono-23c669f
sudo mkdir -p $D && sudo tar -xf /tmp/rel.tar -C $D && sudo rm -f /tmp/rel.tar
sha256sum /tmp/rel.tar                                       # MUST equal step 2
printf 'a\r\nb\r\n' > /tmp/ctl
tr -cd '\r' < /tmp/ctl | wc -c                                # control: MUST print 2
# AUDIT EVERY CONSUMED TEXT FILE, NOT JUST THE SHELL SCRIPTS:
find $D/packages/backend -type f \( -name '*.sh' -o -name '*.py' -o -name '.test.env' \) \
  -exec sh -c 'n=$(tr -cd "\r" < "$1" | wc -c); [ "$n" != 0 ] && echo "CR=$n $1"' _ {} \;
# MUST print nothing. Checking only *.sh is what let a CRLF .test.env through.
rm -f /tmp/ctl
```

**Build with `Dockerfile.render`, from the repository root:**

```bash
cd $D
sudo docker build -f packages/backend/Dockerfile.render -t isola-portal-api:23c669f . > /tmp/build.log 2>&1
echo "BUILD_EXIT=$?"
```

**CAPTURE THE BUILD'S OWN EXIT CODE. DO NOT PIPE IT.**

`docker build ... | tail -25` reports the exit status of `tail`, which is always 0.
Measured 2026-08-20: a build that had already failed was reported as "exit code 0"
and the failure was found only by reading the log. Redirect to a file and echo `$?`
as above. If you must pipe, set `set -o pipefail` first AND prove the originating
status — an unproven pipeline is not a measurement.

Then confirm the artefact actually exists, which a build log cannot tell you:

```bash
sudo docker images --format '{{.Repository}}:{{.Tag}} {{.ID}}' | grep '^isola-portal-api:23c669f '
```

**WHY NOT `packages/backend/Dockerfile`.** That file exists and looks like the
production build. It is not. The live image's own layer history shows
`COPY packages/backend/ /app/` and copies from `packages/webapp-libs/...`, which only
resolve with the repository root as context — and an `email_builder` stage that runs
`pnpm nx run webapp-emails:build` and contributes `index.umd.js`. Only
`packages/backend/Dockerfile.render` matches that history. The name is misleading:
despite "render", this is what produces the deployed EasyPanel image.

**Record the image id in the Port evidence entity.** There is no registry on this
host, so the tag is the only provenance and a tag can be moved.

**RESOLVED 2026-08-21. This step now succeeds — `BUILD_EXIT=0`, image
`isola-portal-api:5c5bed3` id `fb60ec4d76c8`.** Superseded the same day by Packet
5M-ER3R's final release commit `32c8b80`, image `isola-portal-api:32c8b80` id
`21034f2ef0da` — see the Fixed Inputs table above. The `5c5bed3` build stays recorded
here as the first proof that this step's mechanics work; it is not the candidate to use.

It failed for two packets, and neither cause was a code defect in the migration delta.

1. WRONG CONTEXT AND DOCKERFILE — corrected above.
2. A CRLF `.test.env`, shipped by `git archive` honouring `core.autocrlf`.
   `build_static.sh` sources it with `export $(egrep -v '^#' ./.test.env | xargs)`, so
   EVERY value gained a trailing carriage return. `LAMBDA_TASKS_BASE_HANDLER` became
   `common.tasks.LambdaTask\r`, and `apps/users/tasks.py` called
   `getattr(module, "LambdaTask\r")` — which fails even though the module genuinely
   has `LambdaTask`. That is why Python suggested a name that looked identical: the
   difference is invisible.

   DIAGNOSTIC TELL, worth remembering: an `AttributeError` whose "did you mean"
   suggestion equals the missing name means a non-printing character, not a naming
   mistake. Check `repr()` before theorising about imports. Three structural
   hypotheses — circular import, module shadowing, settings lifecycle — were each
   disproved by measurement before this surfaced.

SINGLE-VARIABLE CONTROL, recorded so the fix is attributable: the same commit in the
same image, with only `.test.env` line endings differing, gives `collectstatic exit=0`
(LF) and `exit=1` with the exact error (CRLF).

A separate, genuine latent defect was also repaired in `5c5bed3`: `common/tasks.py`
evaluated `settings.WORKERS_EVENT_BUS_NAME` in a DEFAULT ARGUMENT, making the module
importable only when settings resolved at import. It is fixed with a private sentinel
(not `None`, because the setting is itself `env(default=None)` and an explicit `None`
must stay distinguishable from omission). That repair was NOT what unblocked the
build, and the runbook says so rather than letting the two be conflated.
**Rollback:** nothing to roll back; no production object has changed.
---

## D. Render and validate (steps 9–11) — no production change

### 9. Render the stack from the live service

```bash
cd $D/deploy && chmod +x render-portal-stack.sh
sudo bash render-portal-stack.sh 23c669f > /opt/isola/isola-portal-api-stack.yml
```

**Expect:** exit 0, and a `carried keys:` line on stderr naming 29 keys.

A Swarm stack inherits **nothing** from EasyPanel. The live service carries 39 environment
variables and the committed template declares three plus the six pointers, so the env block
is generated rather than transcribed — hand-transcription would put live configuration in
git and guarantee drift.

**If the renderer refuses,** it has found a secret-shaped value in a key that is not on the
exclusion list. That is the script working. Classify the key, add it to `EXCLUDE_SECRET`,
deliver it as a secret, and extend the table at the top of this document. **Do not widen
the heuristic to make the refusal go away.**

### 10. Assert that nothing was silently lost

```bash
sudo docker service inspect isola_isola-portal-api \
  --format '{{range .Spec.TaskTemplate.ContainerSpec.Env}}{{println .}}{{end}}' \
  | cut -d= -f1 | grep -v '^$' | sort -u > /tmp/live.keys
grep -oE '^      [A-Z][A-Z0-9_]*:' /opt/isola/isola-portal-api-stack.yml \
  | tr -d ' :' | sort -u > /tmp/rendered.keys
printf '%s\n' DJANGO_SECRET_KEY HASHID_FIELD_SALT DATABASE_URL REDIS_CONNECTION \
  ISOLA_GATEWAY_ADMIN_TOKEN PAPERCLIP_BOARD_TOKEN DEPLOY_TIMESTAMP GIT_SHA \
  | sort -u > /tmp/excluded.keys
comm -23 /tmp/live.keys /tmp/rendered.keys | comm -23 - /tmp/excluded.keys
```

**Expect:** EMPTY output — every live key is either rendered or deliberately excluded.

**Prove the comparison is not blind before trusting an empty result:**

```bash
grep -v DJANGO_ALLOWED_HOSTS /tmp/rendered.keys > /tmp/sab.keys
comm -23 /tmp/live.keys /tmp/sab.keys | comm -23 - /tmp/excluded.keys
```

**Expect:** it prints `DJANGO_ALLOWED_HOSTS`. If it prints nothing, the assertion above
proved nothing.

### 11. Validate as Swarm, not as YAML

```bash
sudo docker stack config -c /opt/isola/isola-portal-api-stack.yml > /dev/null; echo "exit=$?"
for K in DJANGO_SECRET_KEY DATABASE_URL ISOLA_GATEWAY_ADMIN_TOKEN PAPERCLIP_BOARD_TOKEN; do
  echo "$K plaintext: $(grep -cE "^      $K:" /opt/isola/isola-portal-api-stack.yml)"
done
grep -cE '^      API_URL:' /opt/isola/isola-portal-api-stack.yml
```

**Expect:** `exit=0`; each credential key `0`; the last line `1` as a positive control
proving the grep can see a key that should be present. A YAML parse alone is not the
schema Swarm applies.

---

## E. Shadow (steps 12–14)

### 12. Deploy the shadow, routing disabled — OWNER

Confirm the Traefik labels in the stack are still commented out, then:

```bash
sudo docker stack deploy -c /opt/isola/isola-portal-api-stack.yml isolaportal
sudo docker service ls --format '{{.Name}} {{.Replicas}}' \
  | grep -E 'isolaportal_api|isola_isola-portal-api'
```

**Expect:** `isolaportal_api 1/1` **and** `isola_isola-portal-api 1/1`. The EasyPanel
service keeps serving every real request throughout this phase.

`PORTAL_RUN_MIGRATIONS: "false"` is what makes this safe. The startup script does not only
migrate — it also seeds Customer Zero and initialises subscriptions, plans, locales and two
translation imports, all of which write. With the switch false, the shadow verifies the
schema is current and **refuses to start if migrations are pending**, rather than booting
against a schema its code does not match.

**If it prints `REFUSING TO START`:** migrations are pending. That is correct behaviour,
not a fault. Go to step 13.

**Rollback:** remove the `isolaportal` stack. Nothing public has changed and the EasyPanel
service never stopped serving.

### 13. Only if migrations are pending — run them as the one owner

```bash
sudo docker service scale isola_isola-portal-api=0     # stop the other owner first
sudo docker run --network easypanel-isola \
  -e DATABASE_URL_FILE=/run/secrets/portal_database_url \
  --mount type=bind,source=/dev/null,target=/dev/null \
  isola-portal-api:23c669f python manage.py isola_migrate
sudo docker service scale isola_isola-portal-api=1
```

> The secret is not available to a plain `docker run`; in practice run this as a one-shot
> service on the `isolaportal` stack, or temporarily set `PORTAL_RUN_MIGRATIONS=true` on
> the shadow **while the EasyPanel service is scaled to zero**. Either way the rule is the
> same: **exactly one migration owner at a time.**

**Expect:** `Migration lock acquired` → `Migrations complete` → `Migration lock released`.

**If it prints `REFUSED: another migration owner already holds the advisory lock`,** a
second owner is running. Find it and stop it. **Do not retry past this** — the lock is a
Postgres session-level advisory lock held by the connection, so it is telling you a fact
about the database, not reporting a transient error.

**Rollback:** scale the EasyPanel service back to 1. Migrations that already applied are
forward-only; a schema rollback needs the database backup, which is why step 1 exists.

### 14. Prove the shadow is actually ready, and accept it

```bash
sudo docker run --network easypanel-isola --entrypoint sh curlimages/curl:latest -c \
  "curl -s -o /dev/null -w '%{http_code}' http://isolaportal_api:80/healthz"
```

**Expect:** `200`.

`/healthz` proves Django routed the request, Postgres answered a query, and Redis completed
a set/get round trip. A TCP connect would have proved only that a socket opened — a task
with a dead database would report healthy and `failure_action: rollback` would have nothing
to act on. `503` means a dependency is genuinely unreachable from the new stack: check the
network attachments before changing anything else.

**Portal acceptance, before it serves anyone.** Exercise these directly against
`isolaportal_api`, not through the public hostname, which still points at EasyPanel:

1. one unauthenticated route returns its normal response;
2. one **authenticated** read returns real data for a known operator;
3. one call on a path that uses `ISOLA_GATEWAY_ADMIN_TOKEN`, proving the credential
   resolved **from its file** — this is the whole point of the migration;
4. the service log contains no credential value and no `ImproperlyConfigured`.

**Do not proceed if any of the four fails.**

---

## F. Cutover (steps 15–17)

### 15. Enable the route — OWNER

Uncomment the `labels:` block in `/opt/isola/isola-portal-api-stack.yml`, then:

```bash
sudo docker stack deploy -c /opt/isola/isola-portal-api-stack.yml isolaportal
```

**The priority is not decoration.** EasyPanel does not route this service with Docker
labels: it writes a **file-provider** router into `/etc/easypanel/traefik/config/main.yaml`
as `https-isola_isola-portal-api-0`, with rule
``Host(`isola-portal.saas00.epic.dm`) && PathPrefix(`/`)`` and `priority: 0`. Traefik reads
`0` as *unset* and derives the priority from the **rule length** — about 53 for that rule.
So "any positive number beats 0" is false. The label router states **`priority: 1000`**
explicitly, far above any length-derived value, so the winner is stated rather than
computed.

### 16. Prove which service is actually serving

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://isola-portal.saas00.epic.dm/healthz
sudo docker service logs isolaportal_api --since 2m | tail -5
sudo docker service logs isola_isola-portal-api --since 2m | tail -5
```

**Expect:** `200`, with the request appearing in **`isolaportal_api`'s** log and **not** in
the EasyPanel service's.

A `200` on its own does not prove which service answered — both are healthy right now, and
that is exactly the ambiguity to resolve. **Read the logs.**

**Rollback:** re-comment the labels and redeploy. Traefik's file-provider router resumes
serving from EasyPanel within seconds. **This is the last stage with a free rollback.**

### 17. Soak

Leave both services running for at least one business hour. Watch:

```bash
sudo docker service ps isolaportal_api --no-trunc | head -5
sudo docker service logs isolaportal_api --since 60m | grep -ciE '5[0-9][0-9]|traceback'
```

**Expect:** no restarts, and a 5xx/traceback count you can account for. Do not proceed to
retirement during the soak. **Do not retire on the same day if the soak was interrupted.**

---

## G. Retire the EasyPanel service (step 18)

### 18. Scale to zero — do not delete — OWNER

```bash
sudo docker service scale isola_isola-portal-api=0
curl -s -o /dev/null -w '%{http_code}\n' https://isola-portal.saas00.epic.dm/healthz
sudo docker service ls --format '{{.Name}} {{.Replicas}}' | grep portal
```

**Expect:** `200`, `isolaportal_api 1/1`, `isola_isola-portal-api 0/0`.

**Scale to zero; do not delete the service.** A scaled-to-zero service keeps its full
definition, including the environment that is the live record of the pre-migration
configuration. Together with the step-1 baseline JSON that is the **EasyPanel recovery
record**, and it is what makes the rollback below real rather than aspirational.

**Rollback:** scale it back to 1, re-comment the new stack's labels, redeploy.

---

## H. Rotate GATEWAY_ADMIN_TOKEN (steps 19–23) — the point of all of it

The gateway accepts a CURRENT and a NEXT administrator token simultaneously. Measured over
HTTP against image `e1ea6bc0d41d` on 2026-08-20: with both set, both return `200` and a
third value returns `401`; with NEXT unset, the grace value returns `401` while CURRENT
still returns `200`; NEXT identical to CURRENT, or NEXT without CURRENT, **refuses to boot
with exit 1**. Those refusals are real because `bootErrors()` was added as part of that
work — a rule naming a consequence the system cannot produce is a wish.

### 19. Introduce the new token as NEXT — OWNER

1. Generate a new token and create it as `isola_gateway_admin_token_v2`.
2. Add it to the **gateway** as `GATEWAY_ADMIN_TOKEN_NEXT`, keeping v1 as
   `GATEWAY_ADMIN_TOKEN`. Edit `/opt/isola/isola-gw-stack.yml` and redeploy the gateway
   stack.

**Rollback:** remove the NEXT reference and redeploy. v1 is still CURRENT, so nothing that
works today stops working.

### 20. Prove the overlap, credential by credential — OWNER

Before changing any consumer:

```bash
curl -s -o /dev/null -w 'v1=%{http_code}\n' -H "Authorization: Bearer <v1>" \
  http://<gateway>:8080/v1/bindings
curl -s -o /dev/null -w 'v2=%{http_code}\n' -H "Authorization: Bearer <v2>" \
  http://<gateway>:8080/v1/bindings
curl -s -o /dev/null -w 'bad=%{http_code}\n' -H "Authorization: Bearer not-a-real-value" \
  http://<gateway>:8080/v1/bindings
```

**Expect:** `v1=200`, `v2=200`, `bad=401`.

All three lines are required. Two 200s without the 401 cannot distinguish "both credentials
are accepted" from "this endpoint accepts anything".

Run these from a host that is not the operator's workstation if the token would otherwise
appear in a local shell history. **The token still appears in a process argument here,
which is the one place this document tolerates it** — prefer a client that reads the value
from a file if one is available.

### 21. Point the portal at v2 — OWNER

1. Change the `isolaportal` stack's secret source for target `portal_gateway_admin_token`
   from `isola_gateway_admin_token_v1` to `isola_gateway_admin_token_v2`.
2. Redeploy the stack.
3. Re-run **step 14 acceptance item 3** — the gateway-backed call must still succeed.

**Rollback:** point the secret source back at v1 and redeploy. Both values are accepted at
this moment, so this rollback cannot fail closed.

### 22. Promote v2, withdraw v1, and prove the withdrawal — OWNER

1. Set `GATEWAY_ADMIN_TOKEN` to v2 on the gateway, remove `GATEWAY_ADMIN_TOKEN_NEXT`,
   redeploy.
2. Prove it, **with the positive control in the same run**:

```bash
curl -s -o /dev/null -w 'old=%{http_code}\n' -H "Authorization: Bearer <v1>" \
  http://<gateway>:8080/v1/bindings     # expect 401
curl -s -o /dev/null -w 'new=%{http_code}\n' -H "Authorization: Bearer <v2>" \
  http://<gateway>:8080/v1/bindings     # expect 200
```

**The second line is not optional.** A `401` on its own is an ambiguous negative: it proves
the old value fails, not that the gateway still works. Without the control, a gateway that
refuses *everything* passes this step.

3. **STOP. Do not destroy v1 yet.** Promotion is reversible only while v1 still
   exists. If anything surfaces in the next hours — a consumer nobody enumerated, a
   cached client, a scheduled job that authenticates once a day — recovery means
   putting v1 back, and **a deleted secret cannot be put back, only re-minted as a
   different value in every store that held it.** Leave v1 in place through a soak of
   at least one business hour, and preferably until the next working day.

   Rollback during the soak is free and complete: set `GATEWAY_ADMIN_TOKEN` back to
   v1 (or re-add it as `GATEWAY_ADMIN_TOKEN_NEXT`) and redeploy the gateway. Nothing
   has to be reconstructed, because nothing has been destroyed.

4. **Zero-reference cleanup — only after that soak.** Before removing the superseded secret, enumerate every store
   that holds a copy:

```bash
sudo docker secret ls --format '{{.Name}}' | grep gateway_admin
grep -rl 'isola_gateway_admin_token_v1' /opt/isola/*.yml
sudo docker service ls --format '{{.Name}}' | while read S; do
  sudo docker service inspect "$S" --format '{{.Name}} {{range .Spec.TaskTemplate.ContainerSpec.Secrets}}{{.SecretName}} {{end}}' \
    | grep gateway_admin_token_v1
done
```

**Expect:** no service references v1. Only then remove it:

```bash
sudo docker secret rm isola_gateway_admin_token_v1
sudo docker secret ls --format '{{.Name}}' | grep -c gateway_admin_token_v1   # expect 0
```

A credential removed from one store while an identical copy lives in another is not a
rotation; it is a moved problem. **The enumeration is part of the fix, not a follow-up.**

**Rollback after step 22:** free until item 4 runs, and unavailable afterwards.
Promotion alone changes nothing irreversibly — v1 still exists and can be restored in
one redeploy. **Removing v1 is the point of no return**, which is why it now sits
behind its own soak gate, and why step 20's overlap proof and step 21's acceptance
must both have passed before you reach it.

### 23. Revoke the temporary EasyPanel token

If `/run/ep.key` was staged in step 6:

```bash
sudo shred -u /run/ep.key 2>/dev/null || sudo rm -f /run/ep.key
ls -la /run/ep.key            # expect: No such file or directory
```

Then **revoke the token in the panel** so the file's absence is not the only control, and
prove the revocation by making one authenticated call that now fails. A deleted file is
containment; revocation is remediation, and a value that existed on disk must be assumed
compromised.

---

## Stop conditions

Stop and ask the owner if any of these occur:

- the shadow refuses to start for any reason other than pending migrations;
- `isola_migrate` reports another lock owner;
- step 10 lists any unaccounted key, or its sabotage control prints nothing;
- the renderer refuses on a key you cannot confidently classify;
- step 16 shows the EasyPanel service still answering after cutover;
- step 20 does not produce exactly `200 / 200 / 401`;
- the soak in step 17 shows any restart or unexplained 5xx;
- any measured operation turns out to be materially larger than what step 4 authorized —
  an authorization covers **the operation as described**, and a bigger one needs a new ask.

## Reporting

On completion, one dispatch containing:

- the result per step, with the measured values, not adjectives;
- the portal image id built in step 8 and the gateway image id in force;
- the acceptance results from step 14 and the overlap/withdrawal proofs from steps 20 and 22;
- the zero-reference enumeration from step 22 and what each store now holds;
- confirmation that `/run/ep.key` is absent and its token revoked;
- **owner-conveyance count** — how many decisions were escalated and what each returned;
- a Port write recording the outcome, the evidence, and any defect found;
- the footer: `PORT: read <what> · wrote <entities>`.

---

## Appendix — Lane coordination: disposition of PR #70 (Packet 5M-ER4H, 2026-08-21)

**PR #70** — `fix/portal-build-hardening-2026-08-21` @ `052f63b97d034ebd7f9dc7196872fb5f9151ae7b`,
*"fix(portal): stop sourcing .test.env in the image build, pin the build, and prove both"* —
was opened by another lane against the same problem this packet fixes. It is **OPEN and
NOT merged.** Its diagnosis was correct and it found the defect first.

### What was adopted, and as what

Four of its five files were adopted **as Lane A commits on
`feat/secret-file-support-2026-08-20`**, not by merging the PR:

| File | Why it was required |
|---|---|
| root `.dockerignore` | `Dockerfile.render` builds from the **repository root**, so the root `.dockerignore` is the only one Docker consults. `packages/backend/.dockerignore` is never read for that build. The root file excluded nothing env-related, which is precisely how the file reached `/app/.test.env`. |
| `scripts/runtime/build_static.sh` | Removes `export $(egrep -v '^#' ./.test.env \| xargs)`. Behaviour-neutral: the Dockerfile's `static_files` stage already sets the same six variables, so the read was redundant. Verified empirically — the build's `collectstatic` copied 207 files and post-processed 591 with no env file present. |
| `.gitattributes` | Broader LF classes, superseding the single-path pin. |
| `Dockerfile.render` | Digest-pinned base images; pinned `pnpm`, `pip`, `setuptools`, `wheel`, `uv`. |

The fifth file, `.github/workflows/portal-build-hardening.yml`, was **not adopted**, per
the packet's instruction not to take it wholesale.

### What PR #70 has that this branch does NOT — recorded as gaps, not as "superseded"

An earlier pass of this comparison reported the workflow *"not present at `origin/pr70`"*.
**That was wrong** — a bad-ref artifact reported as a finding. The file is present at the
PR head and `gh workflow list` shows `portal-build-hardening` as an active workflow. The
corrected comparison finds genuinely unique controls, and honesty requires listing them
as outstanding rather than claiming `release-gate.yml` covers them:

| PR #70 control | Covered here? |
|---|---|
| **A planted secret in the excluded file cannot enter the context** — plants a marker in `.test.env`, builds, asserts the marker is absent from `/app`, **and builds a deliberately unsafe control image proving the marker WOULD have entered without the exclusion** | **NO.** This is the strongest control in either lane: it proves the exclusion is load-bearing, not merely present. ER4H proves the *file* is absent from every layer, which is a different and weaker claim. **Recommended for adoption.** |
| **No migration was applied during the image build**, with a control proving the detector can see an applied migration | **NO.** Nothing in `release-gate.yml` or `release-preflight.sh` checks this. |
| **No `SecretsUsedInArgOrEnv` build warning** | **NO.** |
| **No credential-shaped material in image, bytecode or bundles**, with a planted control | **PARTIAL.** ER4H scans layer *filenames* and the runtime *environment*; it does not scan file *content* or compiled bytecode. |
| Line endings pinned, asserted via `git check-attr` with a negative control on a nonexistent path | **PARTIAL.** ER4H sweeps for CR bytes across 482 files but does not assert the `.gitattributes` rule is in effect. |
| Database major version asserted before the suite runs | **NO.** |
| Build does not read an env file | **YES** — `release-preflight.sh` source mode, with a positive control. |
| `/app/.test.env` absent from the built image | **YES, and stronger** — ER4H also scans every layer tar (95,738 entries) with a positive control. |

### Recommended disposition

**Close PR #70 as "adopted selectively", not as rejected**, crediting the lane with
finding the defect — and open a follow-on item for the four uncovered controls above,
with the planted-secret/unsafe-control pair first. Its diagnosis was right; only its
justification over-reached, in claiming every value in `.test.env` is a public upstream
placeholder. That is not supported for the high-entropy keys: `STRIPE_TEST_SECRET_KEY`
carried a genuine `sk_test_` provider format at 107 characters and 5.53 bits/char. Its
*conclusion* — get the file out of the image — was nonetheless correct.
