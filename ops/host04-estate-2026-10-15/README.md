# host04 estate move — what runs, where its source is (2026-10-15, Lane A)

Owner direction: deepseek is a test server and host03 is retired; everything lives on host04. This folder + `scripts/owner-run/zz-*` is the **committed source of what was changed** (protocol: commit what runs). Port is the authority; evidence ids are listed at the bottom.

## Images that run on host04 (by digest)
| Service | Image (registry `localhost:5000`, host04) | Source |
|---|---|---|
| uplink/plsvc-app (Personal Line service) | `pl/plsvc@sha256:1354bf933b7fb1c223d98e1ec0644553927d6e25726569753fe28af2a3e9d74e` | base tree of image `07bd7895` (commit `0dfab14` of the plsvc work tree) + `plsvc-open-my-line-v3/open-my-line-v3.patch` (7 files, commit `4032ffc` on branch `lane-a/open-my-line-v3-image-1354bf93` of the local-only work tree). Rollback: `REVERSE=1 python scripts/owner-run/zz-openmyline-plsvc-image.py` (image-only). |
| bff/bff-v2 (new bff.epic.dm) | `bff/bff-v2@sha256:80b782fffefe5bba78583a0da4109bd9eddc9cf3ce3b68b88f72db0f9c5b7473` | the DEPLOYED commit `d736dbf3a` of bff-v2 (deepseek working tree == HEAD, 0 tracked modifications), built in an isolated dir with the repo Dockerfile and a BuildKit secret env. |
| fiserv/fiserv-api (api01.epic.dm, *.saas00 fiserv-api) | `fiserv/api` (host03 image `a658c818c677`, tag `host03-a658c818`) | image moved unchanged from host03; app source `emapro-api` @ `242acb23`. Digest pin recorded in `/etc/pl-watch/fiserv-expected-digest`. |
| PL action adapter file | `plsvc-open-my-line-v3/pl-action-adapter.mjs` (sha256 prefix `49cb2e13c63fc3e1`) | bind-mounted file in uplink/pl-action-adapter |

## Data
* Fiserv Postgres 18 + Redis: cold sha256-verified copy host03 → host04, restore proven (82 tables / 2,217 rows == the 10-11 dump). Scripts: `zz-fiserv-move-host04.py`.
* bff `isolav2`: `pg_dump -Fc` → host04 `bff/bff-db` (postgres:18), proven restore **94/94 tables, 16,747/16,747 rows**. Scripts: `zz-bff-host04-create-db.py`, `zz-bff-host04-create-app.py`, `zz-bff-host04-panel.py`.

## Routing / DNS
* `bff.epic.dm` → host04 (owner flipped the A record 2026-10-15 ~07:40Z; **TTL is 3600 s**). bff-v2 serves `/`; `/api/lite`, `/api/internal/personal-line`, `/api/internal/payment-link`, `/go` go to plsvc (same four prefixes deepseek nginx used to peel). Let's Encrypt did not issue until Traefik was nudged after the flip: `zz-bff-cert-nudge.py`, `zz-test-epic-dm-host04.py ACTION=nudge|unnudge`.
* `test.epic.dm` → host04 panel config (`zz-test-epic-dm-host04.py`): `/home*` and everything else 302 to `app.isola.epic.dm` (query kept), `/api/lite` + `/go` to plsvc. A stale `test.epic.dm → fiserv-api` panel mapping was deleted. **Owner DNS step: A record `test.epic.dm` → 66.118.37.29** (a background watcher issues the certificate when it resolves).
* `provision.epic.dm`: **retired, not moved** — no real client traffic in any retained log (only scanners), and superseded by Port decision `dec-owner-acrobits-tab-redirect-test-epic-to-app-isola-2026-09-27`.
* deepseek nginx edits (`host-artifacts/deepseek-nginx-*.diff`) are config on a test server; deepseek `bff-v2-web` (pm2) was stopped after 20 minutes of zero outside traffic (`pm2 start bff-v2-web` to undo).

## Scheduled jobs / guards now on host04
| Item | Where | Notes |
|---|---|---|
| plan-lifecycle (*/15) + plan-metering (:07 :22 :37 :52) | `pl-plan-*-tick.timer` — `zz-pl-plan-ticks-install.sh` | x-cron-secret read in-process from `/app/.cronsecret`; the plan jobs were disabled on deepseek 2026-10-10 |
| registration-watch (1 min) | `pl-registration-tick.timer` — `zz-pl-registration-tick-install.sh` | |
| **nightly backup 02:30 UTC** | `host04-backup.timer` — `zz-host04-backup-install.sh` | pg dump of every DB container + restic to the existing Wasabi bucket (repo `<bucket>/host04`), 7 daily/4 weekly/6 monthly. Credentials moved value-blind (`zz-host04-restic-credentials.py`); a copy is on the owner's laptop **outside any repo**. **Restore proven** from the off-site repo into a scratch Postgres: PL production DB 95/95 tables, 18,760 vs 18,761 live rows (1 audit row written after the dump). Dump bug fixed: the PL DB container's POSTGRES_USER (`ocmt`) is not a superuser — fall back to `postgres`. |
| console :3000 closed to the internet | `console-port-guard.timer` (copied from host03) | before: reachable; after: closed on IPv4 and IPv6 while 443 and the panel API still work |
| pl-watch v3.4/v3.5 | `host-artifacts/pl-watch.v3.5.py`, `pl-watch-did-check.js`, patch scripts | new checks: Magnus unassigned PL numbers ≥ 15, backup freshness < 26 h, root disk < 85 %, fiserv image pin; each proven with a forced-fail control (`PLW_CTRL=did|bk|disk|pin`) |

## Retired on host03 (timers disabled, reversible `systemctl enable --now`)
`isola-om-detector`, `-stale`, `isola-om-run-stale` (their output target `isola-ai.saas00` is a DISABLED service on host04; the same signals are covered by pl-watch), `lumen-coherence`, `isola-ar-run`, `easypanel-backup`, `disk-alert`, `fiserv-pin-guard`, `meta-topology-verify` (guards nothing: no meta-egress network/gateway exists). Kept until power-off because they protect host03 itself: `console-port-guard`, `meta-egress-enforce`.

## Known gaps (not hidden)
* Charging is **enabled** on plsvc (`zz-plsvc-enable-fiserv-charge.py`, reverse with `REVERSE=1`) but has not been exercised with a real card.
* Fiserv startup logs 5 schema-init errors (foreign-key type mismatch in the app vs `users.id`) — identical image and data to host03, not caused by the move.
* `ISOLA_SCHEDULERS_ENABLED` is read by no code; the real scheduler on deepseek was an Inngest dev server. The needed jobs were reproduced as host04 timers; the rest were judged not needed for the launch (see Port evidence).
* Off-site backups depend on the existing Wasabi account; the restic password/credential file copy lives on the owner's laptop.

## Port evidence
`ev-laneA-open-my-line-fix-live-plsvc-1354bf93-2026-10-15`, `ev-laneA-fiserv-api-moved-to-host04-api01-live-2026-10-15`, `ev-laneA-provision-epic-dm-pay-paths-repointed-to-host04-fiserv-2026-10-15`, `ev-laneA-paylink-lookup-peeled-to-plsvc-host04-2026-10-15`, `ev-laneA-bff-epic-dm-staged-on-host04-ready-for-dns-flip-2026-10-15`, `ev-laneA-bff-epic-dm-cutover-to-host04-live-2026-10-15`, `ev-laneA-plan-timers-chatwoot-cron-retired-number-inventory-watch-2026-10-15`, `def-laneA-card-pay-link-minted-on-plsvc-looked-up-on-deepseek-bff-404-2026-10-15`, `def-laneA-om-detector-on-host03-stale-alert-path-dead-and-host03-timers-pending-move-2026-10-15`.
