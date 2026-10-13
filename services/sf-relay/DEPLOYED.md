# sf-relay — what runs in production

Chatwoot (inbox 11, account 2, WhatsApp +1 767 818 0001) ⇄ Uplink (SeldonFrame) public agent turn route. Interim bridge
until SeldonFrame has a native WhatsApp/Chatwoot channel (Track 2 P4/P5); retired only on demonstrated parity.

| | Value (2026-10-11) |
|---|---|
| Service | `sf-relay-pl-prod` (plain Swarm service on host03, network `easypanel`) |
| Image | `sf-relay-ctx:rc10h-presence-cbf1d10c` (built on host03: `FROM sf-relay-ctx:rc10f-facts-cbf1d10c` + `COPY relay.js clients.js server.js /app/src/`) |
| File hashes (sha256, first 8) | `relay.js` 67a546d7 · `clients.js` f50c9ab3 · `server.js` 2abec84b · `conversation-binding.js` 60064d84 · `pl-concierge-assertion.js` 0f33e627 — identical to this directory |
| Tests | `node --test test/*.test.js` → 100/100 |
| Re-create | `deploy/relay-prod-recreate-rc10h.sh` (generated from the live spec by `deploy/relay_recreate_gen.py`; secrets by NAME only) |
| Staging twin | `uplinkstg_relay` (same image; dummy presence token `plstg_wa_presence_dummy_v1`) |

## Releases
- **rc10h** (2026-10-11): WhatsApp read receipt + typing ("presence") via one Meta status call per ACCEPTED message
  (after the live pending check and the durable-duplicate check); optional at boot — a missing/malformed token disables
  presence and never stops the relay (regression control: malformed staging secret → `presence_config enabled:false
  reason:token_file_malformed`, relay healthy). Confirmed on a real 0001 message 2026-10-11 06:27Z.
- rc10g: first presence build — boot-fatal on a malformed optional secret (caused a ~1.5 min outage, 0 customer
  messages affected) — superseded by rc10h.
- rc10f and earlier: see README.md / RELEASE-AND-REVIEW.md.

## Rollback
- Presence only: `sudo docker service update --secret-rm pl_relay_wa_presence_token_20261011_v2 --env-rm WA_PRESENCE_TOKEN_FILE sf-relay-pl-prod` (alone, as the guard requires).
- Whole relay: `--image sf-relay-ctx:rc10f-facts-cbf1d10c` (behaves as rc10h with presence off).

## Credentials (names only)
Chatwoot bot HMAC secret and agent token, conversation state key, PL assertion + context keys, Uplink SF token,
adapter bearer, WhatsApp channel token copy (`pl_relay_wa_presence_token_20261011_v2` — paired with Chatwoot's channel
record: rotate together).
