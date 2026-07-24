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
