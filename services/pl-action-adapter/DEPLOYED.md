# pl-action-adapter — what runs in production

MCP tool server for the Personal Line concierge agent (Uplink agent `28a55c69`): pl_journey, pl_guide, pl_present_offer,
pl_next_step, pl_provision, pl_balance, pl_recent_calls, pl_status, deterministic taps/STOP/START, proactive messages.
Talks to the Personal Line service (plsvc) and Chatwoot; called by the relay and by Uplink over MCP.

> **2026-10-18 lineage (commit what runs):** production now runs the adapter on **host04** (`uplink_pl-action-adapter`, bind-mounted
> `/home/epicadmin/pladapter/pl-action-adapter.mjs`), file sha256 **`77fa62cd`** = the optional-contact guard release deployed 2026-10-17
> 06:01Z (Port `ev-laneA-optional-contact-guard-DEPLOYED-adapter-and-plsvc-probes-pass-two-ticks-verified-2026-10-17`). This commit
> records that file byte-for-byte; the table below is the 2026-10-11 history and is kept as written.

| | Value (2026-10-11) |
|---|---|
| Service | `pl-action-adapter` (Swarm, host03; image `node:22-slim` pinned by digest) |
| Code | bind-mounted file `/home/epicadmin/pladapter/pl-action-adapter.mjs` → `/adapter/pl-action-adapter.mjs` |
| File hash | PRODUCTION runs rc13f sha256 `bfd6a3dc` (deployed 2026-10-11 ~16:33Z; rollback `.rc13e.bak` = 83f0be53). This directory holds **rc13h sha256 `b04ccf50` (built, tested, staged on `plstg_zzrc16g_adapter`, NOT deployed to production)** = rc13g (launch-scope wording, commit dd77102, `008c7845`) + `POST /v1/eligibility`. Deploy only with the rest of the rc16 release, and **BEFORE plsvc rc16g** (plsvc rc16g refuses every store button, fail closed, while the adapter lacks this endpoint). |
| Tests | `node test/rc13_test.mjs <abs path to pl-action-adapter.mjs>` → 198/198 (fixtures: `fixtures/plfix.mjs`, `fixtures/mock-ext-rc13.mjs`) |
| Env | `PL_DETERMINISTIC_TAPS=0` (taps go to the agent) |

## Releases
- **recovery-1** (built 2026-10-18, NOT deployed; file sha256 `dc979d15` (was `f791e482`) on top of running `77fa62cd`; Codex-reviewed). Everything new is OFF by default.
  (1) `POST /v1/staff` (signed, purpose `pl-staff-v1`): private stall card / mirror note in the customer's Chatwoot conversation; idempotent per ref;
  ambiguous posts keep their claim; labels re-read before the replace-only write. (2) Agent-led activation recovery (owner correction 2026-10-18):
  `RECOVERY_PLAYBOOKS` + MCP tools `pl_recovery`, `pl_recovery_act`, `pl_recovery_pause`, `pl_recovery_resume`, `pl_escalate`, listed ONLY with
  `PL_RECOVERY_TOOLS=1` (the working concierge never sees them; for the Clawith runtime at cutover). Every act reuses an existing deterministic sender
  (one send per customer message, only while Chatwoot status is pending, identity from the signed relay context). `pl_escalate` = private package
  (stage, evidence, actions attempted, remaining blocker, next human action) + status open, read back + the relay's own handoff line. Optional
  `PL_RECOVERY_ESCALATION_TEAM_ID`. (3) `/v1/proactive`: a customer pause holds `stalled:*` reminders (unreadable pause read = held). (4) composeJourney:
  stage-aware wording only for verified progress. Tests: `node test/recovery_acceptance_test.mjs` -> 64/64 (FICTIONAL, MESSAGE-DRIVEN recovery), `node test/staff_route_test.mjs` -> 78/78.
  `node test/rc13_test.mjs`: its fake DB now knows the pause SELECT; 153 pass / 12 fail on BOTH the running 77fa62cd and this file, identical failure
  sets (the 12 are stale copy assertions that pre-date this work). Release gates (2026-10-18): escalation is recorded as REQUESTED/OPEN
  (`escalation_open`) until a person accepts - never reported as accepted; file sha256 `dc979d15`.
- **rc13i** (built 2026-10-11, NOT deployed; file sha256 `d44533da`; = rc13h `b04ccf50` + ONE change, R1 slice S-c): the `My account` menu button. Behind `PL_MY_ACCOUNT_LINK=1` (default OFF: with it unset the menu and every action are byte-for-byte rc13h behaviour). When ON, a line holder's menu is `Manage my line / My account / Talk to a person` (My account replaces How it works; still exactly 3 reply buttons) and the tap (menu values are always deterministic) runs `my_account`: (1) a line is required (else the no-line menu); (2) at most 3 links per customer per 10 minutes; (3) the SAME gates as `/v1/eligibility` are run first - Chatwoot ownership (pending only), STOP, the 23.5 h window, estate consent - and the conversation must be the sender's own (`conversation_id` equal), any unreadable source = nothing is minted and nothing is posted; (4) only then `account/portal-link` is asked of the PL service (body: none; identity is the signed assertion for the verified sender - never a typed phone/email), and the returned https URL is posted ONLY into that conversation as its own message (one per customer message: a replayed tap re-sends nothing and mints nothing); (5) any failure (service down, flag off at plsvc, malformed URL) posts one honest "I can't open your account page right now" message - never a guessed link, never "it's on its way". No MCP tool was added: the model cannot request a link. Tests: `node test/rc13_test.mjs <abs path>` -> 224/224 (the 198 rc13h tests unchanged + 26 rc13i). Deploy only together with fork S-c and plsvc portal-link (both flags on); rolling back = unset `PL_MY_ACCOUNT_LINK` or restore rc13h. Residual: the link text is stored in the Chatwoot conversation, so a Chatwoot agent can see an unexpired link for up to 10 minutes (single use, bound to that customer).
- **rc13h** (built 2026-10-11, not deployed): `POST /v1/eligibility` - send-eligibility for the PL service's WhatsApp store button (plsvc rc16g). Answers `{eligible, reason}` and sends/writes nothing. Reasons: `ok`, `human_owned` (Chatwoot status not `pending`; re-read last), `stopped` (adapter STOP preference, or estate STOP via the journey consent read), `window_closed` (last Chatwoot customer message older than 23.5 h), `window_unknown` (no customer message readable), `consent_unknown`, `no_conversation`, `unavailable` (any source unreadable). Auth: HMAC with the PL key under purpose `pl-eligibility-v1` (header `x-pl-eligibility-signature`), `iat` +-120 s, single-use `nonce` (replay -> 409, in-memory, single replica); the bearer alone does not authenticate it. The conversation is found by the exact numeric `wa_id` (never a caller-supplied conversation id). Its consent read is made with `rid elig-<conv>` so plsvc does not count it as a customer message. Flow-launch is NOT routed through it (see the Port evidence ev-lane-a-plsvc-rc16g-adapter-eligibility-store-button-staging-2026-10-11).
- **rc13g** (built 2026-10-11, not deployed): connected-stage text and the app facts handed to the agent say "Make calls from the free Cloud Softphone app. This launch offer covers outgoing calling." instead of asserting incoming calls are unavailable; EPIC brand in the first-call and install (flag-on) text.
- **rc13f** (2026-10-11, DEPLOYED): contextual WhatsApp menu (menu -> Get my number / Manage my line / How it works / Talk to a person; Flow launch via the existing signup Flow).
- **rc13e** (2026-10-11): outbound-only launch scope — app facts and empty call-history copy no longer imply receiving calls.
- rc13d: masked line in facts, Flow CTA names, consent hold for proactive messages.

## Deploy / rollback
Copy the file to the bind-mount path (keep the previous as `.rcNN.bak`), `sudo -n docker service update --force pl-action-adapter`,
read back the container file hash. Rollback = restore the `.bak` file + `--force`.
