#!/bin/bash
# sf-relay-pl-prod RE-CREATION - current as of 2026-10-11 06:3xZ (rc10h + WhatsApp read/typing presence).
# Generated from the LIVE Swarm spec (relay_recreate_gen.py); secrets are referenced by NAME only, never read; env values are
# configuration (URLs, ids, file paths) - no credential values. Use ONLY if the service was removed. Normal changes:
# `docker service update` (the Swarm spec is the deploy record).
# SUPERSEDES scratchpad f3_relay_create.sh (stale: rc6 image, WEBSITE agent a5e7235d, 2 of 8 secrets, no presence).
# Presence is optional: if pl_relay_wa_presence_token_20261011_v2 is missing or malformed, rc10h boots with presence disabled.
D="sudo -n docker"; N=sf-relay-pl-prod
$D service inspect $N >/dev/null 2>&1 && { echo "$N exists - refusing (use service update)"; exit 2; }
$D service create --name $N --replicas 1 --no-resolve-image \
  --network easypanel \
  --secret source=pl_relay_cw_bot_secret_prod_20261010,target=/relay/cw_bot_secret,mode=0400 \
  --secret source=pl_chatwoot_agent_token_prod_20261010,target=/relay/cw_agent_token,mode=0400 \
  --secret source=pl_relay_state_key_prod_20261010,target=/relay/state_key,mode=0400 \
  --secret source=pl_adapter_pl_key_prod_v1,target=/relay/pl_assertion_key,mode=0400 \
  --secret source=pl_adapter_relay_ctx_key_prod_v1,target=/relay/pl_context_key,mode=0400 \
  --secret source=pl_relay_sf_token_prod_20261010_r2,target=/relay/sf_token,mode=0400 \
  --secret source=pl_adapter_bearer_prod_v4,target=/relay/adapter_bearer,mode=0444 \
  --secret source=pl_relay_wa_presence_token_20261011_v2,target=wa_presence,mode=0444 \
  --env NODE_ENV=production \
  --env PORT=3000 \
  --env CHATWOOT_BASE_URL=https://inbox.epic.dm \
  --env CHATWOOT_ACCOUNT_ID=2 \
  --env CHATWOOT_INBOX_ID=11 \
  --env CHATWOOT_ESCALATION_TEAM_ID=8 \
  --env CHATWOOT_BOT_SECRET_FILE=/relay/cw_bot_secret \
  --env CHATWOOT_BOT_TOKEN_FILE=/relay/cw_agent_token \
  --env SF_BASE_URL=http://uplink_uplink-app-prod:3000 \
  --env SF_WORKSPACE_ID=2a62ca68-5d6b-41bd-aea5-28a0aaba7fc8 \
  --env SF_AGENT_ID=28a55c69-ef04-416f-9c91-7d72e9e21345 \
  --env SF_AGENT_SLUG=uplinks-workspace-4816--personal-line-whatsapp-concierge \
  --env SF_TOKEN_FILE=/relay/sf_token \
  --env SF_REQUIRE_CONVERSATION_CAPABILITY=1 \
  --env SF_CONVERSATION_STATE_KEY_FILE=/relay/state_key \
  --env SF_ESCALATION_READBACK_ENABLED=1 \
  --env PL_CONCIERGE_ASSERTIONS_ENABLED=1 \
  --env PL_CONCIERGE_ASSERTION_KID=pl1 \
  --env PL_CONCIERGE_ASSERTION_KEY_FILE=/relay/pl_assertion_key \
  --env PL_CONCIERGE_CONTEXT_KID=ctx1 \
  --env PL_CONCIERGE_CONTEXT_KEY_FILE=/relay/pl_context_key \
  --env PL_CONCIERGE_PHONE_NUMBER_ID=1023804347491554 \
  --env PL_ADAPTER_URL=http://pl-action-adapter:9100 \
  --env PL_ADAPTER_BEARER_FILE=/relay/adapter_bearer \
  --env WA_PRESENCE_TOKEN_FILE=/run/secrets/wa_presence \
  --env WA_PRESENCE_PHONE_NUMBER_ID=1023804347491554 \
  --detach=true sf-relay-ctx:rc10h-presence-cbf1d10c
