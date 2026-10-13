#!/bin/bash
# ISOLATED joint acceptance of relay rc10m vs the deployed rc10l. --internal network: no route to the internet, Meta, the estate's Chatwoot, any customer. Every key is generated for this run.
set -eu
R=/var/tmp/plstage-m; N=plj-net3
OLD=localhost:5000/pl/sf-relay-ctx@sha256:636a0af88cdc0db223925b708de342174b98ee9f32098af1261e41a6dc3adde5
NEWI=localhost:5000/pl/sf-relay-ctx@sha256:8d473255793411062d1e8eacfd5d9c5a8e3ce5e94e8d03e968c2486990051538
for n in pgm world-m plstub-m adapter-m engine-m relay-old relay-new; do docker ps -aq -f name=^$n$ | grep -q . && { echo "$n exists - run m-down.sh first"; exit 2; }; done
docker network ls --format '{{.Name}}' | grep -q "^$N$" || docker network create --internal --subnet 10.79.0.0/24 $N >/dev/null
mkdir -p $R && chmod 700 $R
gen() { sh -c "head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' > $R/$1"; }
for k in adapter_bearer ctx_key pl_key state_key cw_token cw_bot_secret; do gen $k; done
printf 'wst_%s' "$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')" > $R/sf_token
printf 'postgresql://postgres:acceptpw@pgm:5432/postgres' > $R/dburl
cp /tmp/m-world.js $R/world.js; cp /tmp/m-engine.mjs $R/engine.mjs; cp /tmp/m-plstub.mjs $R/plstub.mjs; cp /tmp/m-driver.mjs $R/driver.mjs; cp /tmp/adapter-new.mjs $R/adapter.mjs
# the real Uplink relay-context verifier (current source from the running Uplink container, copied byte-for-byte)
A=$(docker ps -q -f name=uplink_uplink-app-prod | head -1); docker cp $A:/app/packages/crm/src/lib/agents/mcp/relay-context.ts $R/relay-context.ts
echo "adapter sha8 $(sha256sum $R/adapter.mjs | cut -c1-8) (expect 796f0286) | verifier sha8 $(sha256sum $R/relay-context.ts | cut -c1-8)"
WS=2a62ca68-5d6b-41bd-aea5-28a0aaba7fc8; AG=28a55c69-ef04-416f-9c91-7d72e9e21345; SLUG=acceptance-workspace--personal-line-whatsapp-concierge
docker run -d --name pgm --network $N -e POSTGRES_PASSWORD=acceptpw -m 256m postgres:18 >/dev/null
docker run -d --name world-m --network $N --cpus 0.2 -m 128m -e WORLD_GOOD_WST=$(cat $R/sf_token) -v $R/world.js:/s.js:ro node:22-slim node /s.js >/dev/null
docker run -d --name plstub-m --network $N --cpus 0.1 -m 96m -e PL_STATE=active -v $R/plstub.mjs:/s.mjs:ro node:22-slim node /s.mjs >/dev/null
sleep 6
docker run -d --name adapter-m --network $N --user root --cpus 0.3 -m 192m \
  -e PORT=9101 -e ADAPTER_BEARER_FILE=/s/adapter_bearer -e RELAY_CONTEXT_KEY_ID=ctx1 -e RELAY_CONTEXT_KEY_FILE=/s/ctx_key -e PL_BASE_URL=http://plstub-m:3300 -e PL_KID=pl2 -e PL_KEY_FILE=/s/pl_key -e PL_PNID=1023804347491554 \
  -e CHATWOOT_BASE_URL=http://world-m:3000 -e CHATWOOT_ACCOUNT_ID=2 -e CHATWOOT_INBOX_ID=11 -e CHATWOOT_API_TOKEN_FILE=/s/cw_token -e EXPECTED_WORKSPACE_ID=$WS -e EXPECTED_AGENT_ID=$AG -e EXPECTED_AGENT_SLUG=$SLUG \
  -e DB_URL_FILE=/s/dburl -e ADAPTER_SOURCE_CIDRS=10.79.0.0/24 -e PL_DETERMINISTIC_TAPS=0 -e PL_ACCOUNT_TOOLS=1 -e ADAPTER_DEBUG=1 -e PG_RESOLVE_FROM=/app \
  -v $R/adapter.mjs:/adapter/pl-action-adapter.mjs:ro -v /home/epicadmin/pladapter/app:/app:ro \
  -v $R/adapter_bearer:/s/adapter_bearer:ro -v $R/ctx_key:/s/ctx_key:ro -v $R/pl_key:/s/pl_key:ro -v $R/cw_token:/s/cw_token:ro -v $R/dburl:/s/dburl:ro \
  node:22-slim node /adapter/pl-action-adapter.mjs >/dev/null
docker run -d --name engine-m --network $N --cpus 0.3 -m 160m -e CTX_KEY_FILE=/s/ctx_key -e ADAPTER_URL=http://adapter-m:9101 -e ADAPTER_BEARER_FILE=/s/adapter_bearer -e WORKSPACE_ID=$WS -e AGENT_ID=$AG \
  -v $R:/s:ro -v $R/engine.mjs:/e/engine.mjs:ro -v $R/relay-context.ts:/e/relay-context.ts:ro node:22-slim node --experimental-strip-types /e/engine.mjs >/dev/null
relay() { # name image
  docker run -d --name $1 --network $N --user root --cpus 0.5 -m 192m -e NODE_ENV=production -e PORT=3020 -e CHATWOOT_BASE_URL=http://world-m:3000 -e CHATWOOT_ACCOUNT_ID=2 -e CHATWOOT_INBOX_ID=11 -e CHATWOOT_ESCALATION_TEAM_ID=8 \
    -e CHATWOOT_BOT_SECRET_FILE=/relay/cw_bot_secret -e CHATWOOT_BOT_TOKEN_FILE=/relay/cw_agent_token -e SF_BASE_URL=http://engine-m:3000 -e SF_WORKSPACE_ID=$WS -e SF_AGENT_ID=$AG -e SF_AGENT_SLUG=$SLUG -e SF_TOKEN_FILE=/relay/sf_token \
    -e SF_REQUIRE_CONVERSATION_CAPABILITY=1 -e SF_CONVERSATION_STATE_KEY_FILE=/relay/state_key -e SF_ESCALATION_READBACK_ENABLED=1 \
    -e PL_CONCIERGE_ASSERTIONS_ENABLED=1 -e PL_CONCIERGE_ASSERTION_KID=pl2 -e PL_CONCIERGE_ASSERTION_KEY_FILE=/relay/pl_assertion_key -e PL_CONCIERGE_CONTEXT_KID=ctx1 -e PL_CONCIERGE_CONTEXT_KEY_FILE=/relay/pl_context_key \
    -e PL_CONCIERGE_PHONE_NUMBER_ID=1023804347491554 -e PL_ADAPTER_URL=http://adapter-m:9101 -e PL_ADAPTER_BEARER_FILE=/relay/adapter_bearer \
    -v $R/cw_bot_secret:/relay/cw_bot_secret:ro -v $R/cw_token:/relay/cw_agent_token:ro -v $R/state_key:/relay/state_key:ro -v $R/sf_token:/relay/sf_token:ro \
    -v $R/pl_key:/relay/pl_assertion_key:ro -v $R/ctx_key:/relay/pl_context_key:ro -v $R/adapter_bearer:/relay/adapter_bearer:ro -v $R/driver.mjs:/d/driver.mjs:ro $2 >/dev/null
}
relay relay-old $OLD; relay relay-new $NEWI
sleep 9
for n in pgm world-m plstub-m adapter-m engine-m relay-old relay-new; do echo "$n: $(docker ps --format '{{.Status}}' -f name=^$n$) | $(docker logs $n 2>&1 | tail -1 | cut -c1-110)"; done
echo "relay-old image relay.js sha12: $(docker exec relay-old sha256sum /app/src/relay.js | cut -c1-12) (rc10l 32dda8c9695a) | relay-new: $(docker exec relay-new sha256sum /app/src/relay.js | cut -c1-12) (rc10m 079150e40e5a)"
