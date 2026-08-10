# 3742 Truth-Proof (R1.6, 2026-07-24)

Per `decision-3742-authoritative-processor-hermes-2026-07-24` and
`xp-clawith-r16-canonicality-backup-ledger-close` step 3. **Read-only proof
only. Nothing in this document has been executed.** No processor was
disabled, no channel_configs row was modified, no Meta configuration was
changed.

## A. Meta webhook ownership — proven at both phone and WABA level

Read-only Graph API GETs, using the isola-bridge service's existing
`WA_TOKEN` (a SYSTEM_USER token under Meta app `EPIC_BFF`, app_id masked
`...4782`, scope includes `whatsapp_business_management`).

**Phone level** — `GET /{3742's phone_number_id, masked ...9171}?fields=webhook_configuration,display_phone_number,verified_name`:
```json
{
  "webhook_configuration": { "application": "https://bff.epic.dm/api/whatsapp/webhook" },
  "display_phone_number": "+1 7***42",
  "verified_name": "EPIC Communications Inc",
  "id": "...9171 (masked)"
}
```

**WABA level** — `GET /{WABA, masked ...9178}/subscribed_apps` (this WABA
is shared with the EMA sales number, masked +1 767***0001, per
`ev-s3-fleet-groundtruth-registry-2026-07-18` — the documented "3742 trap"):
```json
{
  "data": [
    { "whatsapp_business_api_data": { "name": "EPIC_BFF", "id": "...4782 (masked)" } },
    { "whatsapp_business_api_data": { "name": "EPIC_BFF_test", "id": "...0807 (masked)" } }
  ]
}
```

**Conclusion:** the WABA is subscribed to exactly two apps, both BFF-family
(`EPIC_BFF`, `EPIC_BFF_test`). Neither the v1.8.3 `isolaruntime-backend-1`
stack nor Clawith v1.11.0 is a subscribed app on this WABA. This means Meta
cannot deliver a 3742 webhook event to either old-stack processor
regardless of what credentials are stored in their `channel_configs` rows —
the delivery path is structurally exclusive to the BFF/Hermes app
registration proven above.

## B. Live customer-facing processor/route for 3742 (CORRECTED 2026-07-24)

**Correction to the original section B below:** `artifacts/isola/lib/brain-provider.ts`
and its `HERMES_ALLOWED_PHONE_NUMBER_IDS` gate exist only in this
Isola-Foundation repo as a design/reference file — verified via `find` and
`grep -r` across the entire live `/opt/bff-v2` deployment on deepseek: the
file does not exist there, and the string `HERMES_ALLOWED_PHONE_NUMBER_IDS`
appears nowhere in the deployed code. That mechanism is not what actually
routes 3742's live traffic. The corrected trace, read directly from the
deployed code and database, is:

- Per `decision-isola-whatsapp-number-role-map-2026-07-24`: 3742 is EPIC's
  single customer-facing "everything agent" — the front door for prospects,
  sales, product/marketing inquiries, onboarding, account support,
  collections, service and escalation, rather than a Hermes-branded routing
  layer.
- Inbound webhook: `app/api/whatsapp/webhook/route.ts` → session resolution
  in `app/lib/webhook/session-detector.ts` `detectSession()`.
- **Owner branch (narrow, not the customer path):** `detectSession()` only
  returns `kind: 'owner'` when the sender's phone exactly equals the
  resolved agent's `ownerPhone` column (for this agent, masked `...8382`),
  scoped to the same `waPhoneNumberId` being messaged. Only then does
  `dispatchMessage()` reach `handleHermesChat()` → `handleHermesQuery()`
  (`app/lib/hermes.ts`) — this is the one real, deployed "Hermes" call, and
  it is owner-only (business-mode Q&A, gated additionally on the tenant
  having Odoo configured), never reached by a normal customer message.
- **Customer branch (what a real prospect/customer hits):** for any other
  sender, `detectSession()` step 4 resolves the "dedicated agent" via
  `Agent.findFirst({ waPhoneNumberId: <3742's id, masked ...9171>, status:
  'active' })`. Verified live against `isolav2` (bff-v2's own Postgres,
  port 5433): exactly one agent row matches — id masked `...0a018`,
  name `EMA`, `waPhoneNumberId` = masked `...9171`, `status = 'active'`,
  `isActive = true`. No other row in this database claims the same
  `waPhoneNumberId`. `dispatchMessage()` then routes to `handleCustomer()`,
  which generates the reply natively (Anthropic Claude via `callLLM`) from
  this agent's own config (a rich B2B account-rep + onboarding + collections
  + folded-in SBL sales-funnel persona) and sends it back through
  `sendWhatsAppMessage()` — one send, no external Hermes-gateway hop for
  this path.

**Conclusion: the deployed customer-facing processor for 3742 is bff-v2's own
`EMA` agent (id masked `...8a018`), reached via `https://bff.epic.dm/api/whatsapp/webhook`
→ `session-detector` → `handleCustomer`, confirmed as the sole agent bound to
this phone_number_id in the live database. "Hermes" (`handleHermesQuery`) is a
real, deployed capability of this same agent, but is reachable only through
the narrow owner-phone branch, not the customer path this front door serves.**

## C. The two obsolete v1.8.3 processors — pinned to exact rows

Both queried live from `isolaruntime-postgres-1` (`isolaruntime` DB) on
2026-07-24, matching the just-taken backup snapshot exactly:

| Processor | channel_configs.id | agent_id | agent name | tenant_id | tenant name | is_connected | extra_config phone_number_id | extra_config waba_id | updated_at |
|---|---|---|---|---|---|---|---|---|---|
| Rex | `8e3a56fe-1c14-4118-8613-2d4e1d8326fc` | `aa18adaf-4448-4346-b18c-9b0381aa7edd` | Rex | `f47b1439-5580-4096-bd14-9e26dee77b38` | EPIC Communications Inc | true | ...9171 (masked) | ...9178 (masked) | 2026-05-10 11:56:59 UTC |
| legacy EMA | `2dc199f0-1748-486c-98ed-83efcc4d0d4f` | `8166ea11-8db0-4f26-879a-e2067be0a018` | EMA | `47768881-88a3-4f64-8e0f-5cdce0e7237b` | EPIC | true | ...9171 (masked) | ...9178 (masked) | 2026-04-26 13:28:48 UTC |

Both rows' `extra_config.phone_number_id` (masked `...9171`) and
`extra_config.waba_id` (masked `...9178`) exactly match 3742's real Meta
identifiers — confirming both are genuinely configured for this number, not
a coincidental name collision. The legacy EMA row additionally carries a
live Chatwoot binding (`chatwoot_account_id: 5`, `chatwoot_inbox_id: 18`) —
noted for completeness, not touched or investigated further this pass.

### 30-day traffic evidence — correction to prior record

`evidence-clawith-v183-inventory-2026-07-24` characterized both as "real,
active today" / "confirmed STILL LIVE ... as of 2026-07-23 14:02" based on
each row's `is_connected = true` flag. R1.6 checked actual traffic
directly and found **no corroborating evidence of real WhatsApp message
activity for either processor**:

- `chat_sessions` (full history, not just 30 days) shows: Rex has **zero**
  `whatsapp`-channel sessions ever. Legacy EMA has exactly **one**
  `whatsapp`-channel session, last message 2026-04-26 14:23 UTC — three
  months stale, not "today".
- `isolaruntime-backend-1` container logs (available retention ≈ 3 days,
  capped at `max-file:3 max-size:10m`): zero hits for 3742's phone_number_id
  (masked `...9171`) across full available log history; zero
  webhook/inbound-whatsapp log lines referencing either agent in the last
  72h. The only "whatsapp" log hits in that window are an unrelated
  agent's web-research heartbeat tasks (market research on WhatsApp booking
  systems), not message processing.
- This is consistent with, and explained by, part A above: the WABA is not
  subscribed to any app that could deliver to these processors, so there is
  no live delivery path for new messages to reach them regardless of their
  stored credentials.

**Correction:** `is_connected = true` reflects that each row's stored Meta
credentials still pass a connectivity/token check, not that the processor
is receiving live traffic. Per this packet's own doctrine ("row counts
alone are never proof"), the same applies to connection-flag booleans.
Recommend `evidence-clawith-v183-inventory-2026-07-24` be read alongside
this correction rather than at face value for urgency framing. The
underlying split-brain *configuration* is still real and should still be
cleaned up — the risk level is "dormant duplicate credential, safe
disable" rather than "urgent, could be live-serving right now".

## D. Prepared reversible disable method — NOT EXECUTED

Exact current values for both rows are preserved in this document (above)
and in the R1.6 encrypted backup (`channel_configs_export.json` inside
`v183-20260724-045902.tar.gpg`), sufficient to reconstruct either row byte
for byte if reversal is needed.

### Disable script (draft — do not run without explicit owner approval)

```sql
BEGIN;

-- Snapshot immediately before disabling, for the paper trail (belt-and-braces
-- alongside the encrypted backup already taken).
CREATE TABLE IF NOT EXISTS _r16_3742_disable_snapshot AS
SELECT * FROM channel_configs
WHERE id IN ('8e3a56fe-1c14-4118-8613-2d4e1d8326fc', '2dc199f0-1748-486c-98ed-83efcc4d0d4f')
AND false; -- structure only; populated by the INSERT below

INSERT INTO _r16_3742_disable_snapshot
SELECT * FROM channel_configs
WHERE id IN ('8e3a56fe-1c14-4118-8613-2d4e1d8326fc', '2dc199f0-1748-486c-98ed-83efcc4d0d4f');

-- Reversible disable: flip the connection/config flags off. Does not delete
-- the row or its extra_config (credentials remain intact but inert) so a
-- straight UPDATE back to true is sufficient to reverse.
UPDATE channel_configs
SET is_connected = false, is_configured = false, updated_at = now()
WHERE id IN ('8e3a56fe-1c14-4118-8613-2d4e1d8326fc', '2dc199f0-1748-486c-98ed-83efcc4d0d4f');

COMMIT;
```

### Reversal script

```sql
BEGIN;

UPDATE channel_configs cc
SET is_connected = snap.is_connected,
    is_configured = snap.is_configured,
    updated_at = now()
FROM _r16_3742_disable_snapshot snap
WHERE cc.id = snap.id
  AND cc.id IN ('8e3a56fe-1c14-4118-8613-2d4e1d8326fc', '2dc199f0-1748-486c-98ed-83efcc4d0d4f');

COMMIT;
```

### Verification steps (post-disable, for the future cutover packet)

1. `SELECT id, is_connected, is_configured FROM channel_configs WHERE id IN (...)` — expect both `false`.
2. Re-run the section-A Graph GETs — expect unchanged (disabling a DB row
   does not touch Meta; this step only proves the disable didn't
   accidentally trigger any Meta-side call, since none of this code path
   calls Meta on disable).
3. Confirm `isolaruntime-backend-1` still starts/serves normally for its
   other 55 channel_configs rows (no restart required for this change; a
   restart is optional confirmation only, not required by the change
   itself).
4. Watch `isolaruntime-backend-1` logs for 24h for any error referencing
   either row id — none expected, since no live traffic was reaching them
   per section C.

### Scope note

This script is an artifact for the owner-approved cutover packet only. It
is **not** part of R1.6 execution. R1.6 leaves both rows exactly as found
(`is_connected = true` on both, unchanged).
