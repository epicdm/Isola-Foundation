# Subscriber account slice 2a — status (Lane A, 2026-10-11T19:31Z)

Design: `subscriber-account-slice-v1.md`. Events contract: `pl-journey-events-contract-v1.md`.
Evidence files: `../evidence/slice-2a-staging-2026-10-11/`. Port: `ev-lane-a-account-slice-staging-2026-10-11`.

## Built
| Repo / branch | Commits | PR |
|---|---|---|
| isolav2 `ops/plsvc-account-summary-2026-10-11` (base rc15 `16cefa3c`) | `df5a08aa`, `e30327df`, `4c6f6939`, `521e25cd` | epicdm/isolav2#288 (draft) |
| isola-seldonframe `epic/personal-line-account-slice-2a-2026-10-11` (base `da08b734`) | `a283afd8`, `481e2e3a`, `7feab80b` | epicdm/isola-seldonframe#12 (draft) |

- **plsvc**: `GET /api/internal/pl-concierge/v1/account/summary?account=` — HMAC over `pl-sf-summary-v1.<ts>.<account>`,
  ±300 s, dedicated key `PL_SF_SUMMARY_KEY(_FILE)`; reuses `lineStatusOf`/`balanceOf` (no re-derivation); echoes `account`.
- **Fork, as a native workspace integration**: `integrations.personalLine` (non-secret) + keys in `workspace_secrets`
  (`personal-line-events`, `personal-line-summary`); "Personal Line" card + Test Connection on settings/integrations;
  `external_identities` (0080); ONE ingress `POST /api/webhooks/personal-line/[orgId]` → `integration_event_inbox` /
  `integration_subject_facts` (0081) → native activity + `emitSeldonEvent(pl.*)`; portal Home card (server-side only).
- `signup-flow.ts` / `whatsapp.ts` untouched (rc16 lane).

## Tests
plsvc 108/108 (5 pl-concierge suites incl. new). Fork: slice spec 17/17, public-pilot-lane-a 6/6, `tsc --noEmit` 0, journal check OK.

## Staging proof (host03, synthetic only, no email/WhatsApp sent)
- plsvc as its own service `plstg_web_acctsum` (image `plsvc-staging-synthetic:acctsum-521e25cd`, side-effect flags off).
  Probe 8/8: unsigned 401 · signed A 200 · signed B 200 · A's signature re-aimed at B 401 · wrong key 401 · expired 401 ·
  via proxy 403 · unknown account 404.
- Fork as its own service `uplinkstg_app_acctslice` (image `lane-a-uplink-app:acctslice-7feab80b`, SMTP2GO/Resend env
  removed). Integration connected through the app's own `storeSecret` + `writePersonalLineRecord` (fingerprints only logged).
  Webhook probe 10/10: unsigned/old/wrong key 401 · another workspace's path 503 · type with no valid source 422 ·
  `pl.line_created` A/B 200 (creates the trusted links) · replay = duplicate · v5 applied · late v4 kept stale, not announced.
- DB readback: 2 identity rows; the pre-existing self-entered contact with A's phone + an email = **0 links**; inbox 4 rows;
  facts A v5 registered; 4 native activities; 3 `pl.*` rows in `workflow_event_log` (stale v4 absent).
- Portal (screenshots): A sees +1 767 818 5046, B sees +1 767 818 5045, C (self-entered, same phone as A) sees **no card**.
  Minutes/wallet show "Not available" and setup "We can't check your connection right now" because staging's mock Magnus
  and AMI listener return no reading for these fixtures — the engine's honest nulls, never a guessed figure.

## Deviations / incidents (recorded honestly)
- **plstg_web collision**: my first deploy replaced the rc16 lane's `plsvc-staging-synthetic:rc16-9c5d8439` on
  `plstg_web` (deployed ~40 s earlier). Rolled back with `docker service rollback` within ~1 min; slice 2a then ran on its
  own service. rc16 lane should re-check any staging run that overlapped 19:08–19:10Z.
- Staging fixture workspace: the staging "Personal Line" workspaces have no owner/user (storeSecret and activities need
  one), so the proof used synthetic workspace `syntheticsignup235033s-workspace-6521` (plan set to `growth` on staging to
  pass the portal tier gate, mirroring the prod portal-entitlement correction).
- Portal login used the app's portal session format minted server-side (no email). The real `/magic` route was verified
  by HTTP (302 + Set-Cookie); the browser used a 127.0.0.1 origin because localhost's shared cookie jar interfered.
- Leftover staging resources: services `plstg_web_acctsum`, `uplinkstg_app_acctslice`; loopback-only proxies
  `zzl-acctslice-tun` (127.0.0.1:18093, removal blocked by the safety hook) and `zzl-acctslice-tun2` (127.0.0.1:18094);
  completed one-shot `zzl_acctslice_*` services; staging secrets `plstg_sf_summary_key_v1`, `uplinkstg_pl_sf_events_key_v1`.

## Production (owner) — NOT done
1. plsvc: Swarm secret for `PL_SF_SUMMARY_KEY_FILE` + promote isolav2#288.
2. Fork: migrations 0080 + 0081 on the prod DB (repo migrate path), promote isola-seldonframe#12, then connect the
   EPIC Personal Line workspace's integration on settings/integrations (keys pasted once; never env).
3. The PL production workspace needs the card to be visible only after (1)+(2); until then no card renders anywhere.

## R1 release-candidate source (2026-10-11, deepseek runner) - see Port `ev-lane-a-r1-account-release-candidate-source-2026-10-11`
- S-a fork `d0c76582` (three more event types accepted) · S-c fork `57db5107` (portal-link mint + wa-link redemption, no migration) ·
  real-Postgres harness `e85c8aa5` · plsvc isolav2#291 `ops/plsvc-portal-link-2026-10-11` (`6fbe4407`, `d887aa0e`) on #290 on #288 on rc15 ·
  adapter rc13i (`PL_MY_ACCOUNT_LINK=1`, dark by default).

## Next iteration (as of the original slice; items done in R1 are listed above)
plsvc outbox (`sf_event_outbox`, same transaction) + emitter + backfill replay (links existing lines); WhatsApp
`portal-link` magic link (contacts have no email — session needs an email-less form); "Send me a fresh setup link";
forward-only deal stage projection (not probability); trial events; settings card browser walk with an operator login.
