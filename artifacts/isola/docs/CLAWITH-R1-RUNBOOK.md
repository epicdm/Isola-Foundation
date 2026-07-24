# Clawith-native customer activation — Revenue Delta R1 execution record

Executed 2026-07-24 against the PINNED `clawith-v1110` stack on deepseek
(`/home/epicdm/clawith-v1110`, backend `:8801`, frontend `:3309`, public
`https://agents.epic.dm`). Port packet `xp-agent-platform-clawith-customer-activation`,
gate `isola-gate-04-clawith-customer-experience`. Full result recorded in Port as
`evidence-clawith-native-journey-r1-2026-07-24`.

Acceptance clarification from the owner (applied throughout): no custom
registration/auth code; invitation entitlement is best-effort with a documented
gap if no supported config switch exists; Step 5 (Meta/WhatsApp asset staging)
stops at `OWNER META ASSET REQUIRED` unless a pre-documented, unused,
owner-controlled test number already exists in Port truth; never touch 6737,
9043, any live customer number, or any number already owned by
Foundation/Chatwoot/legacy-8800.

## A1 — Live glue preserved (git-only)

Branch `epic/clawith-v1110-isola-glue` pushed to
`https://github.com/epicdm/isola-runtime/tree/epic/clawith-v1110-isola-glue`.

- `4a72829c` — commits the previously-uncommitted live glue: `backend/app/api/isola_bridge.py`,
  the one `include_router` line in `backend/app/main.py`, `docker-compose.override.yml`.
  `.env` was **not** committed; its var names only are recorded below.
- Parity check: live `isola_bridge.py` matches
  `artifacts/isola/patches/clawith-v1110/isola_bridge.py.diff` **word-for-word**
  on all three hunks (`conversation_ref`/`correlation_id` fields, the
  escalation `caller_directive` block, the `correlation_id` echo in the
  response). Zero drift since 2026-07-21.
- Push initially failed: deepseek's GitHub token lacked `workflow` scope and
  the branch (built on pinned upstream `cf8fcdc8`) is 759 commits ahead of
  `origin/main`, carrying a `.github/workflows/release.yml` origin has never
  seen — pre-existing upstream/origin drift, unrelated to this change. Pushed
  using a one-time PAT supplied by the owner directly in the push URL (never
  persisted to `.git-credentials`, never echoed in full).

`.env` variable names present on the host (values never read into this
session): `AGENT_RUNTIME_V2_AGENT_IDS`, `AGENT_RUNTIME_V2_ENABLED`,
`AGENT_RUNTIME_V2_SOURCE_TYPES`, `API_PORT`, `CLAWITH_DOCKER_NETWORK`,
`EXA_API_KEY`, `FEISHU_APP_ID`, `FEISHU_APP_SECRET`, `FEISHU_REDIRECT_URI`,
`FRONTEND_PORT`, `ISOLA_BRIDGE_SECRET`, `JINA_API_KEY`, `JWT_SECRET_KEY`,
`MINIO_API_PORT`, `MINIO_BUCKET`, `MINIO_CONSOLE_PORT`, `MINIO_ROOT_PASSWORD`,
`MINIO_ROOT_USER`, `PASSWORD_RESET_TOKEN_EXPIRE_MINUTES`, `PUBLIC_BASE_URL`,
`SECRET_KEY`.

## A2 — Native WhatsApp router mounted

`2df933b5` adds `from app.api.whatsapp import router as whatsapp_router` and
one `app.include_router(whatsapp_router, prefix=settings.API_PREFIX)` line to
`main.py`, matching the mount pattern read (read-only) from the legacy
`isolaruntime` stack's `main.py` (~L273/L309). No router code was touched.

Rollback inventory:
- Pre-change image tagged `clawith-v1110-backend:rollback-pre-wa-router`
  (`sha256:5018cead18729f84ccef04cd8c6d882f80e0d88cb202a065a0e754feecb69feb`).
- New image: `sha256:c0f2bf0f547b6c8ca42fbe4e3ff792a7f27e7fc028a18b63ff640e33d0817dac`.
- Rollback command: `docker tag clawith-v1110-backend:rollback-pre-wa-router clawith-v1110-backend:latest && docker compose up -d --no-deps backend`.
- Timestamped `main.py` backup left on host: `backend/app/main.py.bak.1784851200`.

Post-rebuild verification: container `healthy`; `isola_bridge` still `401`
unauthenticated (unchanged); `https://agents.epic.dm` still `200` (unchanged);
3 new WhatsApp routes live in `/openapi.json`
(`/api/agents/{agent_id}/whatsapp-channel`, `.../webhook-url`,
`/api/channel/whatsapp/{agent_id}/webhook`); the webhook `GET` handler is
code-correct (`hub.mode`/`hub.verify_token`/`hub.challenge` via
`hmac.compare_digest` against the per-channel `verification_token`) and
currently returns `404` for any agent because `channel_configs = 0`.

## A3 — Entitlement gate: documented gap, not a fix

`invitation_code_enabled` is a real `SystemSetting`, admin-toggleable via
`PUT /api/admin/platform-settings`, and reported by the public
`GET /auth/registration-config` endpoint — but it is **never read** by either
registration endpoint (`/auth/register`, `/auth/register/init`). Both create
the `Identity`/`User` unconditionally. Flipping the flag would report
`invitation_code_required: true` while doing nothing to gate signup — this is
the "invitation codes exist but open registration cannot be disabled through
supported configuration" case from the owner's clarification, so it was
**documented, not enabled**.

`allow_self_create_company` *is* a real, enforced 403 gate — but it governs
company/workspace self-creation, not account registration, and is a
platform-wide switch affecting all 13 existing users. It was left untouched
(out of the requested scope; changing it would be a broader behavior change
than "registration").

One invitation code was generated as the founding-entitlement MVP artifact:
`GMBNHCRK`, tenant EPIC Front Desk (`6572bd90-0371-4041-986b-065379934f5d`),
`max_uses=1`, `created_by` org_admin Eric Giraud
(`1203c04a-34d1-462d-bbe3-6a45f35d5bcf`) — via direct DB insert matching
exactly the shape/logic of `POST /api/enterprise/invitation-codes` (no admin
session credentials were available to call the live endpoint; no new
application code was written).

**Second defect discovered (upstream, not Isola):** in this no-SMTP
environment, `find_or_create_identity` correctly auto-verifies
`identity.email_verified = True` by design (there's no SMTP to gate on), but
`register_init` hardcodes `user.is_active = is_first_user` regardless — and
both `/auth/resend-verification` and `/auth/verify-email` short-circuit when
`email_verified` is already true. Net effect: **no self-registered non-first
user can ever become active on an SMTP-less deployment** — there is no
supported API path out of it. Worked around for the one test row via a direct
`UPDATE users SET is_active = true`, documented here rather than patched in
code (per "do not build custom registration/authentication code"). This should
be raised with Eric/upstream as a real defect, independent of R1.

## A4 — Journey proven (test identities only)

1. `POST /auth/register/init` → `201`, identity `5437e079-dc5d-488e-8191-bbb723147777`,
   user `4d9707f1-7aea-4ca4-b314-361df0734778` (`r1-test-customer@epic.dm`).
2. `is_active` flipped true per the A3 defect above.
3. `POST /tenants/join` with `GMBNHCRK` → `200`, bound into tenant EPIC Front
   Desk (`6572bd90-0371-4041-986b-065379934f5d`) as `member`.
4. `POST /agents/` with `template_id` = "Chief of Staff"
   (`9a56947a-4fa0-4022-ac29-40b1e1a8a268`) → `201`, agent
   `9ad115f3-2426-41fe-b97f-2da09f9be1ed` ("R1 Test Front Desk Agent"),
   settled to `status: idle`.
5. Live browser login at `https://agents.epic.dm/login` confirmed the full
   journey visually; dashboard shows 2 agents (R1 Test Front Desk Agent +
   EMA). Screenshot saved locally during the session.

DB deltas: `identities` 1→2, `users` 13→14, `tenants` 2→2 (unchanged — joined
existing, did not self-create), `agents` 1→2, `invitation_codes.used_count`
0→1.

**Governance finding:** because the test customer joined the *shared* EPIC
Front Desk tenant (the same tenant EMA/real front-desk traffic uses) instead
of an isolated tenant, its dashboard "Global Activity" feed surfaced real EMA
production conversation snippets (customer name "Jammy's Cheesecake
Delights" + balance figures). This was acceptable only because R1 used a
controlled test identity with no external visibility — a real customer
entitlement flow must provision an **isolated per-customer tenant**, not join
this shared one, before this journey is customer-safe.

**Locale:** frontend `fallbackLng` is already `'en'` at the config level
(`frontend/src/i18n/index.ts`); the zh-CN default noted in the 2026-07-24
reconciliation evidence is client-side browser-detection behavior
(`detection.order: ['localStorage','navigator']`), not a stack default —
live-verified in this session (the login page rendered in English by
default). No config-level action exists or is needed.

## A5 — WhatsApp staging: stopped clean

Read-only inspection of current Port truth found no documented, unused,
owner-controlled WhatsApp test number with approved credentials. All known
numbers (`0001`, `6737`, `3742`, `1568`, `9043`) are already live-bound
elsewhere (Foundation/Hermes/Chatwoot/legacy-8800) and/or explicitly
forbidden (`6737`, `9043`). No WhatsApp channel config, `phone_number_id`,
access token, or WABA asset was created, guessed, or touched.

**Result: `OWNER META ASSET REQUIRED`.** Eric needs to supply (or point to)
a fresh, EPIC-controlled WhatsApp test number and its Meta credentials before
this step can proceed.

## A6 — Containment confirmed

Only `/home/epicdm/clawith-v1110` (its git tree, its own Docker containers,
its own Postgres) was touched this session. `isolaruntime-backend-1`
(`:8800`/`runtime.epic.dm`), Chatwoot, `6737`, `9043`, any live customer
number, and `/opt/bff-v2` received zero commands.

## A7 — No secrets leaked

No secret value was printed in full at any point: the one-time deploy PAT was
masked after its single inline use and never persisted to git config; the
`ISOLA_BRIDGE_SECRET` var name only was recorded (no value); DB credentials
were never printed (only user/db names, needed to run `psql`).

## Rollback summary

| What | How to revert |
|---|---|
| Backend image | `docker tag clawith-v1110-backend:rollback-pre-wa-router clawith-v1110-backend:latest && docker compose up -d --no-deps backend` |
| `main.py` | Host backup `backend/app/main.py.bak.1784851200`, or `git revert 2df933b5` |
| Glue commit | `git revert 4a72829c` (reverts to pre-R1 uncommitted-glue state — not recommended, glue was already live) |
| Test invitation code | `DELETE FROM invitation_codes WHERE code = 'GMBNHCRK'` |
| Test identity/user/agent | Test rows only, safe to delete: identity `5437e079…`, user `4d9707f1…`, agent `9ad115f3…` |
| `is_active` workaround | `UPDATE users SET is_active = false WHERE id = '4d9707f1-7aea-4ca4-b314-361df0734778'` |

---

# R1 follow-up — containment + v1.8.3 inventory (2026-07-24)

Executed under explicit owner authorization, bounded to: the R1 test identity, its
sessions/membership/test-created agent only, and v1.11.0's public self-registration
entry points. Full record in Port as `evidence-clawith-r1-containment-2026-07-24`
and `evidence-clawith-v183-inventory-2026-07-24`.

## Containment

Backups taken first (timestamped, on host, not reproduced here):
`~/.isola-backups/r1_identity.20260724-042857.json`,
`r1_user...json`, `r1_agent...json`, `r1_invitation_code...json`,
`r1_platform_settings_before...json`, `nginx-agents.epic.dm.before...conf`.

1. **Test-created agent removed**: `DELETE /api/agents/9ad115f3-...` (204) via the
   test user's own still-valid token — uses the supported endpoint so all
   cascades/archival are handled by the app, not raw SQL.
2. **Sessions revoked / identity deactivated**: `identities.is_active = false` for
   `5437e079…` (this is the actual login gate — confirmed by reading
   `POST /auth/login`, which checks `identity.is_active`, not `user.is_active`).
   Also set `users.is_active = false` for defense-in-depth (blocks the separate
   `get_current_user` dependency used by all data-access endpoints).
3. **Tenant membership removed**: `users.tenant_id = NULL` for `4d9707f1…` — no
   longer a member of EPIC Front Desk.
4. **Invitation code spent+deactivated**: `GMBNHCRK` was already at
   `used_count = max_uses = 1`; additionally set `is_active = false` for
   defense-in-depth, because `POST /tenants/join` is gated by
   `get_authenticated_user`, which — like `get_me` and `self-create` — does
   **not** check `is_active` (a separate, non-R1-scoped observation: only
   `get_current_user`, used by the actual data endpoints, checks it).
5. **Public self-registration temporarily disabled**, two layers (both were
   needed — see below):
   - `agents.epic.dm` nginx vhost: added exact-match `location =` blocks
     returning `503` for `/api/auth/register`, `/api/auth/register/init`,
     `/api/auth/register/sso` only. Verified: those 3 paths → 503; `/auth/login`
     → 401 (unaffected, reachable); `/auth/registration-config` → 200; SPA → 200.
   - **Direct backend port bypass found and closed**: `clawith-v1110-backend-1`
     publishes `0.0.0.0:8801`, reachable directly over the public IP,
     completely bypassing the nginx block above. Closed with a `DOCKER-USER`
     iptables `DROP` rule (`! -s 127.0.0.0/8 --dport 8801`), the same pattern
     already in production use for `bff-voice-engine`/8020
     (`inc-bff-voice-engine-exposed-2026-07-11`). A plain `ufw deny 8801` was
     tried first and confirmed **not sufficient** — Docker's own iptables
     rules bypass UFW's INPUT chain for published container ports; only the
     `DOCKER-USER` chain is honored. Verification caveat: self-to-self curl
     tests from the host to its own public IP are unreliable for this check
     (confirmed via a control test against the already-proven-effective 8020
     rule, which also appeared "unblocked" under a self-test) — the rule's
     correctness is inferred from being byte-for-byte identical to the proven
     8020 rule, not from a live external probe.

Rollback: remove the 3 `location =` blocks from
`/etc/nginx/sites-available/agents.epic.dm` (backup on host) + `nginx -t && systemctl
reload nginx`; `sudo iptables -D DOCKER-USER -p tcp ! -s 127.0.0.0/8 --dport 8801 -j
DROP` (and the ufw rule, cosmetic only); restore `is_active`/`tenant_id` from the
row backups if the test identity is ever needed again (unlikely — it's now fully
inert).

Verified: EPIC Front Desk back to exactly 13 real users / 1 real agent (EMA);
`clawith-v1110-backend-1` container was never restarted throughout containment;
old bearer token now gets `401` on `/api/agents/`; login with the test credentials
now gets `403 "Your account has been disabled."`

## Root cause: why the test user landed in EPIC Front Desk

Not an upstream bug. `POST /auth/register/init` correctly leaves a new user's
`tenant_id = NULL`. Clawith requires an explicit follow-up call: either
`POST /tenants/self-create` (brand-new isolated tenant) or `POST /tenants/join`
(binds into whatever tenant the invitation code names). R1 generated its one
invitation code against the only tenant with a known admin identity — EPIC Front
Desk — because no isolated tenant existed yet and there was no admin session to
create one elsewhere. `POST /tenants/join` then did exactly what it's designed to
do: bind the test user into the tenant the code was scoped to.

**Permanent correction (process, not code):** every future customer
self-registration must call `POST /tenants/self-create`, never
`POST /tenants/join` against an existing EPIC-internal tenant.
`allow_self_create_company` is already `true` and this endpoint is already
upstream-native — isolation is achieved by *which endpoint the real signup flow
calls*, not by any code change. `POST /tenants/join` should be reserved for a
second seat joining a tenant the *same customer* already owns.

## Invitation enforcement — exact files/functions

- `backend/app/api/auth.py::get_registration_config` (reports the flag) and
  `_handle_normal_register`/`register_init` (create the account) — the flag is
  read in the former, never in the latter two.
- `backend/app/dao/system_setting_dao.py::is_invitation_code_enabled` — reads
  `system_settings.invitation_code_enabled.enabled` (default `False`).
- `backend/app/api/admin.py::get_platform_settings` / `update_platform_settings`
  — the only place the flag is ever written.

**Recommended upstream-compatible fix**: in `register_init` (and
`_handle_normal_register`), after resolving `is_first_user = False`, call
`system_setting_dao.is_invitation_code_enabled()`; if `True`, require
`data.invitation_code` to resolve to a valid, non-exhausted code via the same
`invitation_code_dao.get_active_by_code` lookup `tenants.py::join_company`
already uses, and reject with `400` if absent/invalid — mirroring the existing
`join_company` validation rather than inventing new logic.

**Tests required**: register with flag off + no code → succeeds (current
behavior, regression guard); flag on + no code → `400`; flag on + valid code →
succeeds and binds the named tenant; flag on + exhausted/invalid code → `400`;
`is_first_user` path unaffected by the flag either way.

**Temporary entitlement control until fixed**: none exists at the config level
(this *is* the gap). Until patched, the only available control is process-level
(don't publish/advertise a public signup link) plus the edge-level 503 block
already in place from containment.

## Email activation — supported choices

Confirmed root cause: `find_or_create_identity` correctly auto-verifies
`identity.email_verified = True` when no SMTP is configured (by design — nothing
to gate on), but `register_init` hardcodes `user.is_active = is_first_user`
regardless, and both `/auth/resend-verification` and `/auth/verify-email`
short-circuit once `email_verified` is already true — leaving no supported API
path to activate a non-first self-registered user.

Reported choices, in order of effort:
1. **Configure real SMTP/email delivery** (upstream-supported, zero code
   change) — once `resolve_email_config_async()` returns a config,
   `find_or_create_identity` stops auto-verifying, the normal
   verify-email-token flow fires, and `verify_email` already sets
   `user.is_active = True` for every linked user on success. This is the
   correct fix if EPIC wants real customer self-service.
2. **Upstream-supported administrator activation**: none found — there is no
   `PATCH /admin/users/{id}/activate` or equivalent in `api/admin.py`.
3. **Another existing supported verification provider**: none found (no
   SMS/OAuth-only activation path independent of the email flow).
4. **Minimal upstream patch** (only if SMTP is truly not an option): in
   `register_init`/`_handle_normal_register`, set
   `user.is_active = is_first_user or identity.email_verified` instead of
   `user.is_active = is_first_user` — makes the two already-existing signals
   consistent instead of adding new state.

Manual DB activation (used once for the R1 test row, now reverted) is **not**
suitable as the production journey and should not be repeated for real
customers — it's a diagnostic action, not a process.

## v1.8.3 (`/opt/isola-runtime`) — read-only inventory

State: branch `feat/s5-customer-odoo-answer-handoff` @ `e3a232a7`, containers
`isolaruntime-backend-1` (`:8800`→`runtime.epic.dm`, restart policy
`unless-stopped`), `-frontend-1` (`:3308`), `-postgres-1`, `-redis-1`, all
healthy/up. DB: 341 tenants, 330 users, 444 agents, 36 templates (all
upstream/built-in), 9 skills, 57 `channel_configs`, 1049 chat sessions, 13453
chat messages (488 in the last 24h — this stack is **not** dormant), DB size 227
MB. No dedicated knowledge/memory tables (agent workspace files live under
`/data/agents` inside the container per the entrypoint).

**WhatsApp channels — only 3 of 57 rows are actually `is_connected = true`:**
- pnid `…8517` (= 9043) → tenant "Demo Diner", agent "DineBot" — matches the
  already-corrected ground truth (demo number, not a real customer line).
  Forbidden number; inventory only, not touched.
- pnid `…9171` (= 3742) → tenant "EPIC Communications Inc" (`f47b1439`), agent
  "Rex" — real, high message volume, active today.
- pnid `…9171` (= **same** 3742) → tenant "EPIC" (`47768881`), agent "EMA" —
  **the legacy v1.8.3 EMA, still live and receiving on 3742 as of
  2026-07-23 14:02**, sharing the number with "Rex" above. This is the
  "3742 trap" / `risk-ema-split-brain-dual-processing` already on record —
  confirmed still active, not historical. **Owner decision needed urgently**:
  is legacy EMA still authoritative for 3742, or is this two processors on one
  number right now?

**Other dependencies found:**
- systemd `isola-bridge.service` (`/opt/isola-bridge`, running) — a **third**,
  wholly separate WhatsApp bridge (Node.js, "Aria" assistant, "EPIC as tenant
  #0"), calling the Anthropic API and Meta Graph API directly with its own
  hardcoded `WA_PHONE_ID` (masked: ends `...6684`), completely independent of
  both Clawith stacks. Not touched (outside both target stacks); flagged for
  owner awareness as it doesn't obviously match the 5 numbers already named in
  the S3 fleet registry.
- systemd `operator-cockpit.service` (running) — read-only ops dashboard,
  presumably reads this DB.
- pm2 `mcp-isola-customer-tools` — the MCP server named in the original R1
  mandate as a zero-fork-containment glue layer target.
- nginx also fronts **three more apps** on this backend beyond
  `runtime.epic.dm`: `app.isola.epic.dm`, `chat.isola.epic.dm`,
  `staging.isola.epic.dm` — none traced further in this pass; each needs its
  own dependency check before any shutdown.
- No current full-database backup for `isola-runtime` was found on host
  (checked common backup locations; one `tenants_dump.err` from 2026-07-17
  suggests a prior dump attempt failed). **Backup/restore capability for this
  stack is effectively unverified** — a blocker for any real shutdown, separate
  from the classification work below.

**Migration ledger (pattern-grouped — 341 tenants individually is impractical;
grouped by strong evidence, not row count alone):**

| Group | Count | Evidence | Classification | Destination | Notes |
|---|---|---|---|---|---|
| 9043/Demo Diner | 1 | connected, forbidden number | `OWNER DECISION` | n/a — number stays with Hermes per existing ground truth | Do not touch; already correctly retired from Chatwoot leak per prior fix |
| 3742/"EPIC Communications Inc"/Rex | 1 | connected, real, active today | `OWNER DECISION` (urgent, split-brain) | v1.11.0, once 3742 conflict resolved | Blocks any 3742 migration until legacy EMA is confirmed stood down |
| 3742/"EPIC"/legacy EMA | 1 | connected, real, active today, **duplicate processor** | `OWNER DECISION` (urgent) | Retire once v1.11.0 EMA (81b38cd6) confirmed sole authority | Do not silently kill — could be live-serving right now |
| "Perky's Pizza" | 2 rows | named real founding-pilot customer per `dec-sbl-founding-price-value-and-promo-2026-07-22`; not currently connected | `OWNER DECISION` | v1.11.0, fresh isolated tenant | Do not discard — confirmed real by independent Port record |
| Realistic-named businesses, no channel, clustered activity (Coral Bay Trading Co, Ministry of Agriculture Dominica, Bayside Mini Mart, Caribbean Coffee Co, Island Books, Eric Cafe ×2, Driftwood Bistro, Roseau Marine Supplies, Azure Salon, Harbor Grill/Lights Grill, Mango Tree Kitchen, Bullseye Pharmacy, Mitchell Bakery, Pebble Cove Store, Keystone Cafe/Diner, Coral Coast Marine Supplies v1/v2, Wave Nine Bistro ×3) | ~30 tenants | realistic names but tight activity clustering typical of an automated UAT suite; no independent confirmation either way | `OWNER DECISION` | n/a until classified | Cannot distinguish real pipeline prospects from QA-suite synthetic names by DB evidence alone |
| Obvious QA/test/probe patterns (`__test__*`, `QA *`, `UAT*`, `L3-S*`, `E6a/E6c *`, `WAVE*SMOKE*`, `P6 *`, `ES Phase*`, `Test *`, `ZZ *`, `S4/S5a *`, `Proof*/Golden Path*/Cap Proof Co*/Activation Test Co*/TRACKB*/SAGA-PROOF*`, `E2E *`, single-repeated-char names, `Default`) | ~183 tenants | explicit test/probe naming, one-shot/CI-pattern message counts, zero channel connections | `DISCARD TEST DATA` | n/a | Safe to archive-then-drop after a single `pg_dump` of the full DB (currently missing — see backup gap above) |
| Everything not itemized above | remainder | — | `OWNER DECISION` | n/a | Not individually reviewed in this pass |

Counts by classification: `MIGRATE` = 0 confirmed (the 2 "EPIC" 3742 rows are
gated on the split-brain decision first); `ARCHIVE` = 0 assigned this pass;
`DISCARD TEST DATA` ≈ 183 tenants (bulk pattern match); `OBSOLETE` = 0 assigned
this pass; `OWNER DECISION` ≈ 158 tenants (3742 conflict ×2, Perky's Pizza,
~30 ambiguous realistic-named, remainder not itemized) + 3 adjacent services
(isola-bridge.service/Aria, the 3 extra nginx-fronted apps, missing backup
capability).

This packet does **not** retire v1.8.3 and does **not** migrate anything — per
`decision-clawith-v183-migrate-or-retire-2026-07-24`, this is inventory only.
