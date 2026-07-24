# Delta 1 — Hermes Workspace: Protected access + canonical profile binding

Executor session: Claude Code, 2026-07-24. Host: deepseek (66.118.37.12, user epicdm).
Port packet: `xp-agent-platform-hermes-epic-activation`, DELTA 1, gate
`isola-gate-05-hermes-operator-experience`. Acceptance bar:
`decision-hermes-workspace-standalone-fast-path-2026-07-23`.

## Status summary

| Step | Result |
|---|---|
| 1. Preserve `owner_os_router` | Done (with a caught-and-fixed near-miss, see below) |
| 2. Tailscale restore | **PENDING-OWNER** — auth URL delivered, Eric has not yet logged in |
| 3. Bind workspace to `epic-operator` profile | Done, verified end-to-end |
| 4. Fix `/api/hermes-config` 500 | Done, verified |
| 5. Retire stopped pm2 duplicates | **BLOCKED** — see below |
| 6. Evidence + Port | This document + Port entities updated |

## 1. Preserve `owner_os_router`

- Branched `/home/epicdm/.hermes/hermes-agent` at `epic/owner-os-router-preserve`
  (commit `44040af614fc46518d066474c27fbc71fadc6c52`), added and committed
  `plugins/owner_os_router/{__init__.py,plugin.yaml}`.
- Patch archived: `/home/epicdm/backups/0001-preserve-live-owner_os_router-plugin-epic-operator-f.patch`,
  mirrored into this repo at `artifacts/isola/hermes/owner-os-router-44040af6.patch`.
- Push to `NousResearch/hermes-agent` upstream is not possible (no write access to that repo) —
  the branch + patch is the preservation record.

**Near-miss, caught and fixed:** the packet assumed `git checkout main` after committing on the
preserve branch would leave the plugin files in place on disk ("only git metadata changed"). That
assumption is wrong: `git checkout` removes files that are tracked in the branch you're leaving
but untracked in the branch you're entering. `__init__.py` and `plugin.yaml` were briefly removed
from `/home/epicdm/.hermes/hermes-agent/plugins/owner_os_router/` (only `__pycache__` survived).
Caught within the same operation via a verification read, restored both files byte-identical from
the preserve-branch commit (`git show epic/owner-os-router-preserve:<path> > <path>`, which writes
content without re-touching the index — so the directory stayed untracked on `main`, matching its
original state exactly). `hermes-gateway.service` was never restarted during the ~1 minute the
files were missing (PID unchanged throughout), so the running process never lost the loaded
module — no live service interruption occurred. **Anyone repeating this pattern (branch → commit →
checkout away) needs to know it removes the untracked-elsewhere files; use the `git show`-based
restore, not a bare re-checkout.**

## 2. Tailscale restore — PENDING-OWNER

Ran `sudo tailscale up --ssh` (host requires `--ssh` to be re-specified as a non-default flag).
Auth URL captured and delivered to Eric in-session:

```
https://login.tailscale.com/a/f8b3125345ac9
```

Not blocked on — proceeded with steps 3-5 per stop condition S1. A1 (tailnet path + non-tailnet
deny) is PENDING-OWNER, not failed. `/etc/nginx/sites-enabled/hermes-workspace-tailscale` was not
touched.

## 3. Bind workspace to canonical `epic-operator` profile

### 3a. Enabled the operator gateway's API server
`/home/epicdm/.hermes/profiles/epic-operator/.env` — backed up to
`.env.bak-20260724-015106` before editing. That profile had `API_SERVER_ENABLED=false` and no
`API_SERVER_HOST`/`API_SERVER_PORT` keys at all (unlike `epic-business`, used as the working
template, which runs its api_server on `127.0.0.1:8644`). Set:
- `API_SERVER_ENABLED=true`
- `API_SERVER_HOST=127.0.0.1`
- `API_SERVER_PORT=8645` (confirmed free via `ss -tlnp` before use)
- `API_SERVER_KEY=<generated, openssl rand -hex 32>` (never printed; first 4 chars `46b2` used
  for verification only)

### 3b. Restarted `hermes-epic-operator-gateway` (pm2 id 20)
Health checks within the 2-minute window (S2), from the fresh process's own log:
```
gateway.run: ✓ telegram connected
gateway.platforms.api_server: API server listening on http://127.0.0.1:8645 (model: hermes-agent)
gateway.run: ✓ api_server connected
```
`ss -tlnp` confirmed the listener on `127.0.0.1:8645`. **Still needed: a live Telegram ping-pong
from Eric** to close out A2's operator-round-trip requirement fully — not done in this session
(no channel to initiate as the owner).

### 3c. Pointed the workspace at the operator gateway
Investigated `hermes-workspace`'s connection architecture first (`src/server/gateway-capabilities.ts`):
the gateway *URL* has a live runtime-override path (`~/.hermes/workspace-overrides.json`, settable
from the UI, no restart needed) — but the bearer *token* does not; it's frozen into `process.env`
at process start (`BEARER_TOKEN` in `gateway-capabilities.ts`, consumed by
`openai-compat-api.ts`/`claude-proxy/$.ts`). Since the operator gateway's `API_SERVER_KEY` differs
from whatever the workspace was previously using, both had to change together, which requires a
restart regardless — so this used the packet's originally-specified `.env` + restart path rather
than the override file.

`/home/epicdm/hermes-workspace/.env` backed up to `.env.bak-20260724-015542`. Set:
- `HERMES_API_URL=http://127.0.0.1:8645`
- `HERMES_API_TOKEN=<same key as epic-operator's API_SERVER_KEY, masked 46b2...>`

`pm2 restart hermes-workspace`, then verified end-to-end (all via authenticated curl against the
loopback workspace, session obtained via `POST /api/auth` with the workspace's own
`HERMES_PASSWORD`):
- `GET /api/connection-settings` → `{"gateway":"http://127.0.0.1:8645",...,"source":"env"}`
- `GET /api/model/info` → `200`, `{"model":"kimi-k2.6","gatewayMode":"zero-fork",...}`
- `GET /api/claude-proxy/v1/models` → `200`, lists `hermes-agent`
- **Real chat completion round trip**: `POST /api/claude-proxy/v1/chat/completions` with
  `"Reply with exactly the single word: pong"` → `200`, `{"content":"pong"}` — proves the
  workspace → proxy → `epic-operator` gateway (port 8645) → LLM backend chain is live and
  correctly authenticated.
- **Session persistence across restart**: obtained a session cookie, restarted the workspace
  process, same cookie (no re-login) still authenticated (`200` on `/api/connection-settings`) —
  sessions persist to a JSON file (`auth-middleware.ts`), not just in-process memory.

The old default-profile pairing (systemd `hermes-gateway.service`, port 8642, root
`~/.hermes` state) is now secondary — the workspace no longer talks to it. That service itself was
untouched and remains running for whatever else depends on it.

### Security note — secret exposure in this session's transcript
While testing `/api/hermes-config` authenticated, its response body included
`dashboard.basic_auth.secret` **in full cleartext** (unlike `KIMI_API_KEY` in the same response,
which the endpoint correctly masks) plus a scrypt `password_hash` for user `eric`. That secret
value is now present in this session's conversation transcript. **Recommend Eric rotates
`dashboard.basic_auth.secret` and the `eric` password hash in `~/.hermes/config.yaml`.** Not
rotated in this session — out of Delta 1's named scope (touches dashboard auth, not
gateway/workspace binding), flagged per stop condition S3 rather than acted on unilaterally.
This also confirms `/api/hermes-config` has a broader secret-redaction gap worth a follow-up
defect beyond the 401/500 bug fixed in step 4.

## 4. Fixed `/api/hermes-config` 500

**Root cause**: `authorize()` in `src/server/hermes-config-route.ts` type-cast
`isAuthenticated(request)` to `Response | true` (`as AuthResult`), but `isAuthenticated()` in
`auth-middleware.ts` actually returns a plain `boolean`. On an unauthenticated request this made
`authorize()` `return false` — a bare boolean where the router expects a `Response` — which threw
downstream and surfaced as an unhandled `500 {"status":500,...,"message":"HTTPError"}` instead of
a clean `401`. Every other route in the codebase (e.g. `swarm-missions.ts`) checks
`isAuthenticated()` as a boolean directly and returns a real `Response.json(..., {status:401})` —
`hermes-config-route.ts` was the outlier.

Branch `fix/delta1-hermes-config-500` off local HEAD `48be7978` (not rebased/cleaned, per
instruction). Fix: `authorize()` now checks the boolean directly and returns
`Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 })` on failure. Commit
`5e7c37bcbe9020d71ebf9656f76e54117e26b7c7`.

`npx tsc --noEmit` run before commit: zero errors in the touched file; ~50 pre-existing errors
elsewhere in the repo (e2e specs, playground worker, unrelated components) are baseline noise
predating this change, left untouched per "HEAD is a local commit — do not rebase/clean."

Built (`npx vite build`, 15.57s, exit 0) and deployed via a workspace process restart (the
process runs from the `dist/` build, not `src/` directly — confirmed rebuild was required).
Verified:
- Unauthenticated: `GET /api/hermes-config` → `401 {"ok":false,"error":"Unauthorized"}`
- Authenticated: `GET /api/hermes-config` → `200`

Push to `outsourc-e/hermes-workspace` failed (`403`, no write permission for `epicdm`) — expected
per the packet's fallback. Patch archived at
`/home/epicdm/backups/0001-fix-api-api-hermes-config-returns-401-not-500-when-u.patch`, mirrored
into this repo at `artifacts/isola/hermes/hermes-workspace-config-401-fix-5e7c37bc.patch`.

**Tooling note**: an initial attempt to apply this fix via the `ssh-edit-block` MCP tool reported
"Replacements made: 68, Expected: 1" but `git diff` showed the file completely unchanged — the
tool's result was not trustworthy here. Abandoned it in favor of an exact, asserted Python
line-splice (with an `assert actual == old_block` guard) confirmed via `git diff` before
proceeding. A stray `hermes-config-route.ts.backup.<timestamp>` file (byte-identical to the
pre-fix version) was left behind by that failed attempt and has been removed.

## 5. Retire stopped pm2 duplicates — BLOCKED

Saved the current pm2 process list and backed it up:
`/home/epicdm/backups/dump.pm2.bak-20260724-020640`. Confirmed by id that pm2 ids 11 and 12 (both
named `hermes-gateway`) are `status: stopped`, distinct from the five online `hermes-*` processes
and the systemd `hermes-gateway.service` unit.

Removing them was blocked by a deployed safety hook (`enforce-safety.js`) on this machine, which
flags pm2's process-removal commands as capable of taking down production and directs that changes
of this kind go "through the gate" — i.e. some validated UI/API layer, not a raw process-manager
command run directly over SSH.

This is a hard block, not a warning, and the doctrine implies there's a sanctioned mechanism ("the
gate") for this kind of change other than a direct removal command. Did not attempt to route
around it (e.g. hand-editing the pm2 dump file and forcing a process-list restore from it), since
that would defeat the exact thing the hook exists to prevent. **Nothing was removed — ids 11/12
are untouched, in their original `stopped` state.** Needs Eric to say what "the gate" is, or to do
this step directly, or to grant an explicit one-time exception.

## Rollback inventory

| File | Backup |
|---|---|
| `~/.hermes/profiles/epic-operator/.env` | `~/.hermes/profiles/epic-operator/.env.bak-20260724-015106` |
| `~/hermes-workspace/.env` | `~/hermes-workspace/.env.bak-20260724-015542` |
| `~/hermes-workspace/src/server/hermes-config-route.ts` | `~/backups/hermes-config-route.ts.bak-<ts>` (pre-fix) |
| pm2 process list | `~/backups/dump.pm2.bak-20260724-020640` (pre any change — none occurred) |
| `.hermes/hermes-agent` plugin state | preserved on branch `epic/owner-os-router-preserve` @ `44040af6`, patch archived |

Rollback for 3a/3c: restore the two `.env` backups above, restart
`hermes-epic-operator-gateway` and `hermes-workspace`. Rollback for step 4: revert commit
`5e7c37bc` on `fix/delta1-hermes-config-500` (or just don't merge it), rebuild, restart
`hermes-workspace`. Nothing in step 5 needs rollback — no change was made.

## Acceptance tests (A1–A6)

- **A1** (tailscale end-to-end): PENDING-OWNER — auth URL delivered, awaiting Eric's login.
- **A2** (workspace chat round-trip on `epic-operator` + session survives restart): chat
  round-trip and session persistence both verified via curl (see step 3c). Live Telegram
  ping-pong on the operator gateway: PENDING-OWNER.
- **A3** (`/api/hermes-config` 200 authed / 401 unauthed): verified, see step 4.
- **A4** (`owner_os_router` committed + patch archived, files still live on disk): done, see
  step 1.
- **A5** (no stopped `hermes-gateway` entries; pm2 dump backup archived; systemd unit + 3 profile
  gateways + dashboard + workspace all online): dump backup archived; all named processes
  confirmed online throughout; **stopped entries still present — BLOCKED, see step 5.**
- **A6** (zero secret values in any output): **violated once** — see the security note under step
  3c. Caught, flagged, and the affected secret's rotation recommended. No secret values appear in
  this document; masked forms only (`46b2...`, key names).

## Open items for Eric

1. Complete tailscale login: `https://login.tailscale.com/a/f8b3125345ac9`
2. Send a Telegram message to the `epic-operator` bot to close out the live round-trip check.
3. Rotate `dashboard.basic_auth.secret` (and consider the `eric` password hash) in
   `~/.hermes/config.yaml` — exposed once in this session's transcript.
4. Clarify what "the gate" is for retiring the two stopped `hermes-gateway` pm2 entries (ids 11,
   12), or do it directly, or grant an explicit exception to the `enforce-safety.js` block.
