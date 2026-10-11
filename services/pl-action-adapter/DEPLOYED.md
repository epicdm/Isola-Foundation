# pl-action-adapter — what runs in production

MCP tool server for the Personal Line concierge agent (Uplink agent `28a55c69`): pl_journey, pl_guide, pl_present_offer,
pl_next_step, pl_provision, pl_balance, pl_recent_calls, pl_status, deterministic taps/STOP/START, proactive messages.
Talks to the Personal Line service (plsvc) and Chatwoot; called by the relay and by Uplink over MCP.

| | Value (2026-10-11) |
|---|---|
| Service | `pl-action-adapter` (Swarm, host03; image `node:22-slim` pinned by digest) |
| Code | bind-mounted file `/home/epicadmin/pladapter/pl-action-adapter.mjs` → `/adapter/pl-action-adapter.mjs` |
| File hash | PRODUCTION runs rc13f sha256 `bfd6a3dc` (deployed 2026-10-11 ~16:33Z; rollback `.rc13e.bak` = 83f0be53). This directory holds **rc13h sha256 `b04ccf50` (built, tested, staged on `plstg_zzrc16g_adapter`, NOT deployed to production)** = rc13g (launch-scope wording, commit dd77102, `008c7845`) + `POST /v1/eligibility`. Deploy only with the rest of the rc16 release, and **BEFORE plsvc rc16g** (plsvc rc16g refuses every store button, fail closed, while the adapter lacks this endpoint). |
| Tests | `node test/rc13_test.mjs <abs path to pl-action-adapter.mjs>` → 198/198 (fixtures: `fixtures/plfix.mjs`, `fixtures/mock-ext-rc13.mjs`) |
| Env | `PL_DETERMINISTIC_TAPS=0` (taps go to the agent) |

## Releases
- **rc13h** (built 2026-10-11, not deployed): `POST /v1/eligibility` - send-eligibility for the PL service's WhatsApp store button (plsvc rc16g). Answers `{eligible, reason}` and sends/writes nothing. Reasons: `ok`, `human_owned` (Chatwoot status not `pending`; re-read last), `stopped` (adapter STOP preference, or estate STOP via the journey consent read), `window_closed` (last Chatwoot customer message older than 23.5 h), `window_unknown` (no customer message readable), `consent_unknown`, `no_conversation`, `unavailable` (any source unreadable). Auth: HMAC with the PL key under purpose `pl-eligibility-v1` (header `x-pl-eligibility-signature`), `iat` +-120 s, single-use `nonce` (replay -> 409, in-memory, single replica); the bearer alone does not authenticate it. The conversation is found by the exact numeric `wa_id` (never a caller-supplied conversation id). Its consent read is made with `rid elig-<conv>` so plsvc does not count it as a customer message. Flow-launch is NOT routed through it (see the Port evidence ev-lane-a-plsvc-rc16g-adapter-eligibility-store-button-staging-2026-10-11).
- **rc13g** (built 2026-10-11, not deployed): connected-stage text and the app facts handed to the agent say "Make calls from the free Cloud Softphone app. This launch offer covers outgoing calling." instead of asserting incoming calls are unavailable; EPIC brand in the first-call and install (flag-on) text.
- **rc13f** (2026-10-11, DEPLOYED): contextual WhatsApp menu (menu -> Get my number / Manage my line / How it works / Talk to a person; Flow launch via the existing signup Flow).
- **rc13e** (2026-10-11): outbound-only launch scope — app facts and empty call-history copy no longer imply receiving calls.
- rc13d: masked line in facts, Flow CTA names, consent hold for proactive messages.

## Deploy / rollback
Copy the file to the bind-mount path (keep the previous as `.rcNN.bak`), `sudo -n docker service update --force pl-action-adapter`,
read back the container file hash. Rollback = restore the `.bak` file + `--force`.
