# `deploy/` — the Foundation-360 deploy artefacts, now under version control

**Committed 2026-09-07, as-is, before any edit.** This directory decides which
credentials the Customer 360 service door accepts, what base image the runtime is
built on, and what gets promoted to `isola-360-uat.saas00.epic.dm`. Until this commit it
existed in exactly one place — host03 — and `git ls-files deploy` returned 0.

## Provenance

Copied verbatim from `/home/epicadmin/builds/isola360-5fe25d3b/deploy/` on host03
(66.118.37.110). That directory is canonical because `5fe25d3b` is the tag of the image
the running service is actually serving:

```
docker service inspect isola360uat_app --format '{{.Spec.TaskTemplate.ContainerSpec.Image}}'
  → isola-foundation-360:5fe25d3b
```

Byte counts were compared against the source after transfer and match exactly, so nothing
was mangled by line endings.

**There are ~20 other `isola360-<sha>/deploy/` directories on that host.** Nothing marks
which is authoritative; the only way to know was to match the image tag to a directory
name. That is the situation this commit ends.

## THREE FILES ARE DELIBERATELY ABSENT — they contain literal credentials

Committing them would put live secrets into git history, permanently, in a repository
that is pushed to GitHub. They stay on host03 and are recorded here by name so their
absence is deliberate and visible rather than an oversight:

| file | line | what is in it |
|---|---|---|
| `prove-unavailable2.sh` | 56 | `ODOO_API_KEY=` a 39-character **literal** — a live Odoo API key in plaintext |
| `seed.mjs` | 115 | `access_token:` a 26-character literal |
| `sid.mjs` | 11 | a 28-character literal under a `credential` key |

Each was classified by shape — the value contains no `$`, is not a filesystem path, and is
long enough to be a secret — against a **planted positive control** carrying one
`$`-reference and one literal, so the classifier was proven able to tell them apart before
any verdict was believed. The two files that matter most for the change this commit
precedes, `entrypoint.sh` and `stack.yml`, came back **clean**: every credential in them is
a `$`-reference or a `/run/secrets/...` path, never a value.

`ODOO_API_KEY` in a plaintext script on a shared host is filed as its own finding. Rotating
it is a separate, owner-gated operation; nothing here touches it.

## How the credentials actually reach the process

`entrypoint.sh` reads swarm secret **files** and `export`s them into the process it
launches:

```
/run/secrets/isola_360_service_token  → ISOLA_360_SERVICE_TOKEN
/run/secrets/odoo_api_key             → ODOO_API_KEY
/run/secrets/chatwoot_service_token   → CHATWOOT_SERVICE_TOKEN
/run/secrets/db_password              → composed into DATABASE_URL
```

The values never appear in `stack.yml` and are never disclosed by
`docker service inspect`, which is the point of the design.

**The trap this creates, and it cost a full cycle:** `docker exec <c> printenv X` starts a
*new* process from the container's `Config.Env`, which never held these values. It reports
UNSET while the running server has them. To read what the server sees, read
`/proc/<pid>/environ` of the serving process — and carry a control in the same read
(assert `HOSTNAME` is found), because `pgrep` is absent from this image and a failed read
otherwise looks exactly like an absent variable.

## The base image is a floating tag, not a digest

`Dockerfile:18` is `FROM node:22-bookworm-slim`. As of 2026-09-07 that image is **not
present in host03's local cache** (verified, with a deliberately non-existent tag as the
control, so "No such image" is a real answer and not a broken lookup). A rebuild therefore
pulls whatever that tag points at today.

**The base the running `5fe25d3b` image was built on is not recoverable** — it was never
pinned and is no longer cached. That is stated rather than papered over; the pin added
alongside this commit makes future builds reproducible, it does not reconstruct the past
one.
