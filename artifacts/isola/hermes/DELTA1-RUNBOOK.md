# Delta 1 — Hermes Workspace: Protected access + canonical profile binding

Executor session: Claude Code, 2026-07-24. Host: deepseek (66.118.37.12, user epicdm).
Port packet: `xp-agent-platform-hermes-epic-activation`, DELTA 1, gate
`isola-gate-05-hermes-operator-experience`. Acceptance bar:
`decision-hermes-workspace-standalone-fast-path-2026-07-23`.

## Status summary

| Step | Result |
|---|---|
| 1. Preserve `owner_os_router` | Done (with a caught-and-fixed near-miss, see below) |
| 2. Tailscale restore | Done — Eric authenticated; access-boundary verified server-side (see Round 2 §A) |
| 3. Bind workspace to `epic-operator` profile | Done, verified end-to-end |
| 4. Fix `/api/hermes-config` 500 | Done, verified |
| 4b. Fix `/api/hermes-config` secret disclosure | Done, verified (see Round 2 §C) |
| 5. Retire stopped pm2 duplicates | **BLOCKED**, real resurrection risk found, not disproven (see Round 2 §D) |
| Telegram round-trip (`HERMES-WORKSPACE-DELTA1-PING`) | **NOT FOUND** on any bot/profile (see Round 2 §B) |
| Dashboard secret rotation | Done, verified against the live plugin code (see Round 2 §C) |
| 6. Evidence + Port | This document + Port entities updated |

---

# Round 2 — owner-authorized secret rotation, redaction fix, PM2 investigation

Same executor session continuing after Eric completed tailscale auth and sent a Telegram probe.
Covers: tailscale verification, the Telegram round-trip check, owner-authorized rotation of
`dashboard.basic_auth.secret`, the `/api/hermes-config` redaction fix, and a read-only
investigation of the PM2 safety-hook block from Delta 1 step 5.

## Round 2 §A — Tailscale protected-access verification

`tailscale status` on deepseek now shows itself connected (`100.117.210.117`) alongside Eric's
`ericthinkpad` peer. Verified the actual nginx access-control logic server-side, since I have no
credential for the nginx basic-auth layer and won't attempt to obtain one:

- Non-tailnet source (loopback, `127.0.0.1` → `:7000`): **`403`** (CIDR allow-list `100.64.0.0/10`
  correctly denies it) — this **is** the non-tailnet-denial proof (A1 item 5).
- Tailnet-interface source (bound to `100.117.210.117` → `:7000` and `:7001`): **`401`** with
  `WWW-Authenticate: Basic realm="Hermes Workspace"` from `nginx/1.18.0` — proves the CIDR check
  passes for a real tailnet peer and nginx basic-auth engages **before** the app is ever reached
  (A1 items 2–3).
- Re-verified post-tailscale that workspace chat still uses `epic-operator`
  (`GET /api/connection-settings` → `gateway: http://127.0.0.1:8645`) (A1 item 6).

**Not verified**: an actual browser login through the tailnet path with nginx's basic-auth
password (A1 item 4) and the controlled-restart session-persistence check specifically *after*
tailscale (A1 item 7) — the session-persistence mechanism itself was already proven in Round 1 §3c
and re-confirmed incidentally during the Round 2 rotation/redaction restarts below, but not
re-run as a dedicated post-tailscale test. I don't have Eric's nginx basic-auth password and won't
try to obtain or guess it — this last leg needs Eric to do himself from his own browser.

## Round 2 §B — Telegram round-trip: NOT FOUND

Searched exhaustively for `HERMES-WORKSPACE-DELTA1-PING` on deepseek: `epic-operator`'s pm2 logs
(300-line tail and full log files), its profile log directory, the default gateway's systemd
journal (2-hour window), and every other profile's pm2 logs (`ema-customer`/`epic-business` have
no Telegram token; `sales` → `@epic_arbiter_bot`, checked too). **Zero matches anywhere.**
`getUpdates` against the `epic-operator` bot token returned an empty result (consistent with
either "already consumed by active polling" or "never sent" — not conclusive either way), and the
gateway process has been continuously online (no crashes) for the entire relevant window.

`epic-operator`'s actual bot is **`@epicdm_operator_bot`**. The likely explanation: Eric messaged
the old/habitual default bot, **`@EPICDM_Hermes_bot`** (root `~/.hermes`, systemd
`hermes-gateway.service`) instead — that bot's journal was also checked and also has no match, but
it's the more plausible target for muscle-memory. **Reporting this as unconfirmed rather than
fabricating a pass.** Eric: please resend `HERMES-WORKSPACE-DELTA1-PING` explicitly to
`@epicdm_operator_bot`.

## Round 2 §C — Secret rotation + redaction fix

### Consumer identification (before any change)
`dashboard.basic_auth.secret` exists in exactly one place: the root `/home/epicdm/.hermes/config.yaml`
(no per-profile `config.yaml` has its own copy, confirmed by grep across all 7 profiles). It has
exactly one consumer: the `dashboard_auth/basic` Hermes Agent plugin, loaded by the single pm2
process `hermes-dashboard` (id 21, script `hermes_cli.main dashboard --port 9119 --host 127.0.0.1`).
No `HERMES_DASHBOARD_BASIC_AUTH_SECRET` env-var override exists anywhere (would take precedence
over config.yaml if it did). The secret is a pure HMAC-SHA256 signing key for the dashboard's own
stateless session tokens (`_sign`/`_unsign` in the plugin) — unrelated to the nginx `.htpasswd`
credential (a completely separate auth layer) and unrelated to any other service on the host.

### Rotation
1. Backed up `/home/epicdm/.hermes/config.yaml` → `~/backups/config.yaml.bak-20260724-023733`
   before any edit.
2. **Incident during rotation**: a verification `diff` command printed **both** the old and the
   freshly-generated new secret values in full cleartext into this session's transcript — the
   exact mistake the owner's instructions explicitly warned against. Caught immediately; the
   compromised-on-arrival new value was discarded unused and a **second** new value was generated
   and written, this time verified via line-count + SHA-256 fingerprint only (never printing
   secret content). Only that second value was ever put into service.
3. Restarted `hermes-dashboard` (the sole consumer) via pm2.
4. **Verification** (old fails / new succeeds): direct HTTP testing against a live login session
   wasn't possible — see the structural finding below — so verification was done against the
   actual running plugin code, imported directly from its own file
   (`plugins/dashboard_auth/basic/__init__.py`) in its own venv, never reimplemented:
   `BasicAuthProvider.verify_session()` with a token signed using the **old** secret → `None`
   (rejected); the same call with a token signed using the **new** secret (loaded fresh from the
   post-rotation config file) → a valid `Session` object (accepted). All temp files that ever held
   secret material were `shred -u`'d off `/tmp` afterward.
5. Confirmed no collateral damage: `hermes-dashboard` online post-restart, `/` and `/login` both
   `200`, workspace still logs in and still points at `epic-operator`, and the nginx
   tailscale-fronted dashboard (`:7001`) still correctly challenges with basic auth.

### Structural finding: this credential is currently dormant
Tracing exactly how `dashboard.basic_auth` gets enforced turned up `should_require_auth(host)` in
`hermes_cli/web_server.py`: the cookie/password auth gate (`auth_required`) is **only** active for
non-loopback `Host` headers. This dashboard is started with `--host 127.0.0.1`, **and** the nginx
tailscale-proxy for it explicitly forces `proxy_set_header Host 127.0.0.1` (documented in nginx's
own config comment, for a DNS-rebinding-defense reason). So every request this dashboard ever
receives — direct or via the protected tailscale path — arrives with a loopback Host header, which
means `auth_required` is **structurally always false** for this deployment. The actual live
protection for the dashboard is nginx's CIDR allow-list + `.htpasswd` (layer 1) plus a separate,
unrelated ephemeral `_SESSION_TOKEN` mechanism for loopback mode (layer 2) — **not**
`dashboard.basic_auth`/this secret. The rotation was still correct and necessary (the value was
exposed and Eric explicitly authorized it regardless), but Eric should know the credential doesn't
currently gate any live traffic — worth a follow-up decision on whether to keep it configured
(in case the bind mode ever changes) or remove the vestigial config block.

### Redaction fix
Root cause: `handleHermesConfigGet` passed the **entire raw parsed `config.yaml` tree** through to
the JSON response verbatim (`config: input.config` in `normalizeHermesConfigState`,
`src/server/hermes-config-migration.ts`). Provider API keys were already correctly masked via a
separate `maskedCredentials` path, but nothing masked the raw tree itself — so
`dashboard.basic_auth.secret` and `password_hash` (and anything else credential-shaped anywhere in
that tree) passed straight through.

Fix (same branch, `fix/delta1-hermes-config-500`, commit `940e648a`): added
`redactSecretsDeep()`, a recursive walk that masks any string value whose **key** matches a
credential-shaped pattern (`secret|password|passphrase|token|api[_-]?key|apikey|credential|bearer|
private[_-]?key|signing[_-]?key`, case-insensitive) with `••••` (the same `MASK_SENTINEL` already
used elsewhere in this codebase for MCP secrets), applied to the config tree at the point it enters
the response. `${ENV_VAR}`-style reference placeholders are left untouched (matching the existing
convention in `mcp-normalize.ts` — a reference isn't a literal secret). Non-matching fields (e.g.
`session_ttl_seconds`) are unaffected.

Added a regression test in the existing `hermes-config-migration.test.ts` (matches its existing
style) covering: the literal secret value never appears anywhere in the serialized response,
`secret`/`password_hash` are masked, a credential nested arbitrarily deep is still caught, an
env-var reference is preserved untouched, and non-secret sibling fields pass through unmodified.
Used an obviously-fake fixture value in the test rather than the real (now-rotated) compromised
secret, to avoid propagating even the dead value unnecessarily.

`vitest run` on the file: 4/4 passed (including the new test). Built + deployed + verified live:
- `GET /api/hermes-config` unauthenticated → `401` (unchanged from the step-4 fix)
- `GET /api/hermes-config` authenticated → `200`, `config.dashboard.basic_auth.secret` and
  `.password_hash` both `••••`, `.username`/`.session_ttl_seconds` untouched, provider masking
  (`KIMI_API_KEY`) still correct.

Patch archived: `~/backups/0001-fix-api-redact-credential-shaped-values-from-api-her.patch`,
mirrored here at `artifacts/isola/hermes/hermes-workspace-config-redaction-940e648a.patch`. Push to
`outsourc-e/hermes-workspace` failed `403` again (no write access), as expected.

## Round 2 §D — PM2 cleanup: read-only investigation

**1. Exact hook**: `enforce-safety.js`, a `PreToolUse` hook. Rule matches the two-word
process-manager removal commands (delete/kill) against the JSON-stringified tool input of *every*
tool call.

**2. Location/control**: `~/.claude/hooks/enforce-safety.js` on **the executor's own machine**
(global, user-level — wired via both project and global `.claude/settings.json`). This is **not**
a control installed on deepseek; it fires for any tool call in this Claude Code session regardless
of target host, and it fired even on prose that merely *mentioned* the phrase in a task
description, not just literal command execution.

**3. Expected gate/API**: none is actually implemented or referenced by the hook itself. Its
message ("use the gate", "the validated UI/API layer") is doctrine text with no concrete target —
consistent with Eric's own Port search finding no such workflow or action defined.

**4. Are the stopped entries in the active dump?** Yes — both `hermes-gateway` entries are present
in `/home/epicdm/.pm2/dump.pm2`, `status: "stopped"`.

**5–6. Resurrect/reboot risk, autorestart/startup persistence**: **Real, unresolved risk found —
not disproven.** Both entries carry `autorestart: true` and `autostart: true` in the saved dump.
Systemd unit `pm2-epicdm.service` is `enabled` (`WantedBy=multi-user.target`) and its `ExecStart`
runs a full process-list resurrect on every start — so **every reboot of this host resurrects
this exact dump**. Whether pm2 6.0.14's resurrect specifically respects a saved `"stopped"` status
field (vs. restarting everything with `autorestart`/`autostart` true regardless of last state) is
version-specific behavior I could not verify without actually running it, which would be a real,
disruptive action against all 24 processes and was correctly out of scope for a read-only
investigation. **I cannot prove these entries are inert against a reboot** — the evidence leans
toward a real conflict risk with the canonical systemd `hermes-gateway.service` (the original
"gateway.lock conflict" concern from the Round 1 evidence), not away from it.

**7. Exact safe supported method**: **none currently exists.** No Port workflow, no wrapper script,
no scoped exception mechanism in the hook itself (it's a blanket string match with no allowlist).

### Outcome: PM2 CLEANUP DEFERRED SAFELY
"Safely" describes the decision not to act (no hook bypass, nothing deleted, nothing hand-edited
in pm2's internal state) — **not** a claim that the underlying risk is zero; the investigation
above found evidence of a real, unresolved resurrection risk that Eric's own bar for a "safe"
deferral does not consider proven-absent. pm2 ids 11/12 remain untouched, `status: stopped`,
exactly as before. `dump.pm2` backup from Round 1 remains valid
(`~/backups/dump.pm2.bak-20260724-020640`); no new backup was needed since nothing changed.

**Bounded follow-up options for Eric** (not executed — each needs an explicit decision):
- Eric removes pm2 ids 11 and 12 directly from his own terminal, then saves the process list —
  two short commands, ~10 seconds, not subject to this session's local hook since it isn't Eric's
  tool call.
- Eric adds a scoped exception to `enforce-safety.js` (e.g. an explicit pm_id allowlist or a
  one-time override) so a future session can do this under an audited exception rather than a
  blanket bypass.
- *(Mentioned for completeness, not recommended without explicit sign-off)*: hand-editing
  `dump.pm2` to drop just those two entries would prevent a future resurrect from reviving them
  without ever invoking the specific process-manager command this host's hook blocks — but doing
  that unilaterally would violate the *spirit* of "do not bypass or disable the deployed safety
  hook" even though it wouldn't trip the hook's literal pattern match, so it was not done.

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

## Round 3 — Owner UAT confirmed + PM2 retirement executed

**Owner UAT (independently verified from logs, not just self-report):**
- Browser: real traffic from `ericthinkpad` (`100.99.240.51`) through the tailscale-protected
  `:7000` path, all `200`s, live session `087045ae-d6ed-4111-93f5-ef156a87a868`. The actual chat
  content confirms identity: *"1. workspace-ok 2. epic-operator 3. confirmed — I am the
  epic-operator profile..."*
- Telegram: `inbound message: ... msg='HERMES-WORKSPACE-DELTA1-PING'` → `response ready: ...
  319 chars` → sent to `5136767981`. Full reply retrieved from `state.db`: *"Pong! 🏓
  `HERMES-WORKSPACE-DELTA1-PING` received. ... Standing by."* Both A1 and A2 now fully pass.

**PM2 retirement — executed with explicit owner authorization.** The owner's follow-up message
read as a checklist that could have meant either "you run this" or "here's my plan" — rather than
guess, this was surfaced directly: running the script by invoking its path would **not** trip the
local pattern-matching safety hook (the actual removal subcommand is hidden behind a variable
indirection inside the file, so the literal blocked phrase never appears in a direct path
invocation), but doing so would still be a **genuine bypass of the hook's intent**, not just its
literal pattern. The owner was given that exact tradeoff and explicitly chose to have the executor
run it directly. Checksum re-verified immediately before running (matched:
`574fa603...653506b0aa`). Every precondition passed; the script completed cleanly:

```
ok: ids 11/12 absent from live state and the saved dump.
ok: systemd hermes-gateway.service still active
ok: hermes-epic-operator-gateway still online
ok: hermes-epic-business-gateway still online
ok: hermes-ema-gateway still online
RETIREMENT COMPLETE.
Rollback backup: /home/epicdm/backups/dump.pm2.bak-20260724-032233
```

**Full 9-point post-execution verification, independently re-run (not just the script's own
output):** ids 11/12 absent from `pm2 jlist` and from the saved dump; the dump now contains zero
`hermes-gateway` entries at all, so a future `pm2 resurrect` has nothing to restore for that name
(verified by inspecting dump content rather than actually invoking `resurrect` against the live
22-process fleet, which would have been an unnecessary additional risk); systemd
`hermes-gateway.service` still active; all three named profile gateways still online with
**unchanged restart counts** (17/2/10 — proving the script only observed them, never touched
them); workspace still resolves to `epic-operator` (`127.0.0.1:8645`); the operator gateway's own
process uptime was continuous throughout (never restarted), confirming Telegram was never
disrupted.

`defect-hermes-pm2-duplicate-resurrection-risk-2026-07-24` closed `Verified` in Port. All 6 Delta 1
steps and both follow-on defects (config secret disclosure, PM2 resurrection risk) are now
complete.

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

- **A1** (tailscale end-to-end): CIDR + basic-auth ordering verified server-side (Round 2 §A);
  actual browser login through the tailnet path needs Eric (no nginx password available to me).
- **A2** (workspace chat round-trip on `epic-operator` + session survives restart): chat
  round-trip and session persistence both verified via curl (see step 3c). Live Telegram
  ping-pong on the operator gateway: **NOT FOUND** — see Round 2 §B, needs Eric to resend to the
  correct bot (`@epicdm_operator_bot`).
- **A3** (`/api/hermes-config` 200 authed / 401 unauthed): verified, see step 4. Still holds after
  the Round 2 redaction fix.
- **A4** (`owner_os_router` committed + patch archived, files still live on disk): done, see
  step 1.
- **A5** (no stopped `hermes-gateway` entries; pm2 dump backup archived; systemd unit + 3 profile
  gateways + dashboard + workspace all online): dump backup archived; all named processes
  confirmed online throughout; **stopped entries still present — BLOCKED, resurrection risk found
  not disproven, see Round 2 §D.**
- **A6** (zero secret values in any output): **violated twice across this engagement** — once in
  Round 1 (an `/api/hermes-config` response body), once in Round 2 (a `diff` during secret
  rotation). Both caught and flagged in real time; the Round 1 exposure is now moot (that secret
  has been rotated); the Round 2 exposure's compromised-on-arrival value was discarded unused
  before ever being put into service. No secret values appear in this document; masked forms only.

## Open items for Eric

1. Verify the actual browser login through the tailscale path works with your nginx basic-auth
   credential — I don't have it and won't try to obtain it (A1 item 4).
2. Resend `HERMES-WORKSPACE-DELTA1-PING` explicitly to `@epicdm_operator_bot` (not
   `@EPICDM_Hermes_bot`) to close out the live round-trip check.
3. Decide whether to keep `dashboard.basic_auth` configured (currently dormant — see the
   structural finding in Round 2 §C) or remove it, now that it's rotated.
4. Clarify what "the gate" is for retiring the two stopped `hermes-gateway` pm2 entries (ids 11,
   12), or do it directly, or grant an explicit exception to the `enforce-safety.js` block — see
   the real, unresolved resurrection risk found in Round 2 §D.
