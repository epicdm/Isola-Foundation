#!/bin/bash
# ISOLATED adapter acceptance for the app-links delta: old (deployed) vs new adapter x 4 journey states. --internal network: no route to the internet, Meta, the estate's Chatwoot or any customer.
set -eu
R=/var/tmp/plstage-n; N=plj-net2
RELAY=localhost:5000/pl/sf-relay-ctx@sha256:636a0af88cdc0db223925b708de342174b98ee9f32098af1261e41a6dc3adde5
for n in pgn world-n; do docker ps -aq -f name=^$n$ | grep -q . && { echo "$n exists - run h-down.sh first"; exit 2; }; done
docker network ls --format '{{.Name}}' | grep -q "^$N$" || docker network create --internal --subnet 10.78.0.0/24 $N >/dev/null
mkdir -p $R && chmod 700 $R
gen() { sh -c "head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' > $R/$1"; }
for k in adapter_bearer ctx_key pl_key cw_token; do gen $k; done
printf 'postgresql://postgres:acceptpw@pgn:5432/postgres' > $R/dburl
cp /tmp/h-world.js $R/world.js; cp /tmp/h-plstub.mjs $R/plstub.mjs; cp /tmp/adapter-old.mjs $R/adapter-old.mjs; cp /tmp/adapter-new.mjs $R/adapter-new.mjs; cp /tmp/h-driver.mjs $R/driver.mjs
echo "old sha8 $(sha256sum $R/adapter-old.mjs | cut -c1-8) (expect 5c441a26) | new sha8 $(sha256sum $R/adapter-new.mjs | cut -c1-8)"
WS=2a62ca68-5d6b-41bd-aea5-28a0aaba7fc8; AG=28a55c69-ef04-416f-9c91-7d72e9e21345; SLUG=acceptance-workspace--personal-line-whatsapp-concierge
docker run -d --name pgn --network $N -e POSTGRES_PASSWORD=acceptpw -m 256m postgres:18 >/dev/null
docker run -d --name world-n --network $N --cpus 0.2 -m 128m -e WORLD_GOOD_WST=wst_unused -v $R/world.js:/s.js:ro node:22-slim node /s.js >/dev/null
for st in active registered_no_call setup_not_activated no_line; do
  docker run -d --name plstub-$st --network $N --cpus 0.1 -m 96m -e PL_STATE=$st -v $R/plstub.mjs:/s.mjs:ro node:22-slim node /s.mjs >/dev/null
done
sleep 6
adapter() { # name file state
  docker run -d --name $1 --network $N --user root --cpus 0.2 -m 160m \
  -e PORT=9101 -e ADAPTER_BEARER_FILE=/s/adapter_bearer -e RELAY_CONTEXT_KEY_ID=ctx1 -e RELAY_CONTEXT_KEY_FILE=/s/ctx_key -e PL_BASE_URL=http://plstub-$3:3300 -e PL_KID=pl2 -e PL_KEY_FILE=/s/pl_key -e PL_PNID=1023804347491554 \
  -e CHATWOOT_BASE_URL=http://world-n:3000 -e CHATWOOT_ACCOUNT_ID=2 -e CHATWOOT_INBOX_ID=11 -e CHATWOOT_API_TOKEN_FILE=/s/cw_token -e EXPECTED_WORKSPACE_ID=$WS -e EXPECTED_AGENT_ID=$AG -e EXPECTED_AGENT_SLUG=$SLUG \
  -e DB_URL_FILE=/s/dburl -e ADAPTER_SOURCE_CIDRS=10.78.0.0/24 -e PL_DETERMINISTIC_TAPS=1 -e PL_ACCOUNT_TOOLS=1 -e ADAPTER_DEBUG=1 -e PG_RESOLVE_FROM=/app \
  -v $R/$2:/adapter/pl-action-adapter.mjs:ro -v /home/epicadmin/pladapter/app:/app:ro \
  -v $R/adapter_bearer:/s/adapter_bearer:ro -v $R/ctx_key:/s/ctx_key:ro -v $R/pl_key:/s/pl_key:ro -v $R/cw_token:/s/cw_token:ro -v $R/dburl:/s/dburl:ro \
  node:22-slim node /adapter/pl-action-adapter.mjs >/dev/null
}
adapter ad-old-active adapter-old.mjs active; adapter ad-new-active adapter-new.mjs active
adapter ad-old-regnc adapter-old.mjs registered_no_call; adapter ad-new-regnc adapter-new.mjs registered_no_call
adapter ad-old-setup adapter-old.mjs setup_not_activated; adapter ad-new-setup adapter-new.mjs setup_not_activated
adapter ad-old-noline adapter-old.mjs no_line; adapter ad-new-noline adapter-new.mjs no_line
sleep 10
docker ps --format '{{.Names}} {{.Status}}' | grep -E "^(pgn|world-n|plstub-|ad-)" | sort
for a in ad-new-active ad-old-noline; do echo "$a: $(docker logs $a 2>&1 | tail -1 | cut -c1-120)"; done
