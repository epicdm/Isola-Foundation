#!/bin/bash
# host03 STAGING ONLY (rc16g): three NEW, uniquely named services; nothing existing is modified.
#   plstg_zzrc16g_cw       mock Chatwoot (cwmock.mjs)          alias zzrc16g-cw       :9300
#   plstg_zzrc16g_adapter  the rc13h adapter FILE under test   alias zzrc16g-adapter  :9100  (plain http; same secrets/DB as the shared staging adapter, READ-ONLY use of the secrets)
#   plstg_zzrc16g_web      plsvc rc16g image                   alias web-rc16g        :3005  (clone of plstg_zzrc16_web's runtime + PL_ADAPTER_URL)
# The store-button recorder is the existing graph.facebook.com stand-in plstg_zzrc16_metamock (read /__sent, POST /__reset only).
# NOT touched: plstg_web, plstg_adapter, plstg_zzrc16_web, plstg_mock-ext, plstg_plfix, production, uplinkstg_*.
set -u
D="sudo -n docker"; Z=/home/epicadmin/zz-lanea-rc16-20261011; H=$Z/h
WEB_IMG=${WEB_IMG:?WEB_IMG e.g. plsvc-staging-synthetic:rc16g-xxxxxxxx}
ADAPTER_IMG=plsvc-staging-synthetic:d736dbf3     # same image the shared staging adapter runs (carries pg + node_modules); only the mounted FILE differs
for s in plstg_zzrc16g_cw plstg_zzrc16g_adapter plstg_zzrc16g_web; do $D service inspect $s >/dev/null 2>&1 && { echo "$s exists - stop"; exit 1; }; done
[ "$($D service inspect plstg_zzrc16_metamock --format '{{range .Endpoint.VirtualIPs}}{{.Addr}}{{end}}')" = "10.77.0.16/24" ] || { echo "metamock VIP changed - stop"; exit 1; }
mkdir -p $H/adapter-rc13h && cp $Z/pl-action-adapter.mjs $H/adapter-rc13h/pl-action-adapter.mjs && chmod 0755 $H/adapter-rc13h && chmod 0644 $H/adapter-rc13h/pl-action-adapter.mjs
echo "adapter file sha256 prefix: $(sha256sum $H/adapter-rc13h/pl-action-adapter.mjs | cut -c1-8)"
wait_running() { local s=$1 st; for i in $(seq 1 60); do st=$($D service ps $s --filter desired-state=running --format '{{.CurrentState}} {{.Image}}' | head -1); case "$st" in Running*) break;; esac; sleep 3; done; echo "$s: $st"; }

# 1) mock Chatwoot
$D service create --detach --name plstg_zzrc16g_cw --network name=plstg_net,alias=zzrc16g-cw --restart-condition any \
  --mount type=bind,src=$H,dst=/h,readonly node:22-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 node /h/cwmock.mjs >/dev/null || { echo "cw create failed"; exit 1; }
wait_running plstg_zzrc16g_cw

# 2) adapter under test: env = the shared staging adapter's env (values copied, never printed) with 4 overrides; no TLS
ENVARGS=()
while IFS= read -r kv; do
  k=${kv%%=*}
  case "$k" in CHATWOOT_BASE_URL|PL_BASE_URL|TLS_KEY_FILE|TLS_CERT_FILE|ADAPTER_SOURCE_CIDRS|ADAPTER_DEBUG) continue;; esac
  [ -n "$kv" ] && ENVARGS+=(--env "$kv")
done < <($D service inspect plstg_adapter --format '{{range .Spec.TaskTemplate.ContainerSpec.Env}}{{println .}}{{end}}')
ENVARGS+=(--env CHATWOOT_BASE_URL=http://zzrc16g-cw:9300 --env PL_BASE_URL=http://web-rc16g:3005 --env ADAPTER_SOURCE_CIDRS=10.77.0.0/24 --env ADAPTER_DEBUG=1)
$D service create --detach --name plstg_zzrc16g_adapter --network name=plstg_net,alias=zzrc16g-adapter --restart-condition any --no-resolve-image --no-healthcheck \
  --secret source=plstg_adapter_bearer_v1,target=adapter_bearer --secret source=plstg_adapter_cw_token_v1,target=cw_token \
  --secret source=plstg_adapter_db_url_v1,target=adapter_db_url --secret source=plstg_pl_hmac_key_v2,target=pl_hmac_key \
  --secret source=plstg_relay_ctx_key_v1,target=relay_ctx_key \
  --mount type=bind,src=$H/adapter-rc13h,dst=/adapter,readonly "${ENVARGS[@]}" \
  $ADAPTER_IMG node /adapter/pl-action-adapter.mjs >/dev/null || { echo "adapter create failed"; exit 1; }
unset ENVARGS
wait_running plstg_zzrc16g_adapter

# 3) plsvc rc16g web = plstg_zzrc16_web's runtime recipe + PL_ADAPTER_URL
FKB64=$(base64 -w0 < $H/flowkey/flow_private.pem); DUMMY=$(openssl rand -hex 24)
$D service create --detach --name plstg_zzrc16g_web --network name=plstg_net,alias=web-rc16g --restart-condition any --no-resolve-image \
  --secret source=plstg_app_env_v3,target=/app/.env,mode=0400 \
  --mount type=bind,src=/home/epicadmin/zz-lanea-plsvc-20261009/data,dst=/app/data,readonly \
  --mount type=bind,src=$H,dst=/zzrc16,readonly --host graph.facebook.com:10.77.0.16 \
  --env LITE_ACTIVATION_ENABLED=true --env 'LITE_ACTIVATION_ALLOWLIST=*' \
  --env ISOLA_RUNTIME_ENV=staging --env STAGING_WA_ALLOWLIST_FILE=/zzrc16/allow.json \
  --env PL_FLOW_SENDER_PHONE_ID=100000000000099 --env WHATSAPP_TOKEN=$DUMMY \
  --env NODE_EXTRA_CA_CERTS=/zzrc16/tls/ca.pem --env FLOW_PRIVATE_KEY_B64=$FKB64 \
  --env PL_ADAPTER_URL=http://zzrc16g-adapter:9100 \
  $WEB_IMG >/dev/null || { echo "web create failed"; exit 1; }
unset FKB64 DUMMY
wait_running plstg_zzrc16g_web
for i in $(seq 1 30); do $D service logs plstg_zzrc16g_web 2>&1 | grep -q "Ready in" && break; sleep 2; done
echo "--- readiness"
$D service logs plstg_zzrc16g_web 2>&1 | grep -E "Ready in|rror" | tail -2 | cut -c1-160
$D service logs plstg_zzrc16g_adapter 2>&1 | grep -E "listening|rror" | tail -2 | cut -c1-160
$D service logs plstg_zzrc16g_cw 2>&1 | grep -E "listening" | tail -1 | cut -c1-120
for s in web adapter; do C=$($D ps -q -f name=plstg_zzrc16g_$s | head -1); echo "$s task image id: $($D inspect $C --format '{{.Image}}' | cut -c1-19)"; done
C=$($D ps -q -f name=plstg_zzrc16g_adapter | head -1); echo "adapter in-container file sha256 prefix: $($D exec $C sha256sum /adapter/pl-action-adapter.mjs | cut -c1-8)"
echo "web env names: $($D service inspect plstg_zzrc16g_web --format '{{range .Spec.TaskTemplate.ContainerSpec.Env}}{{println .}}{{end}}' | cut -d= -f1 | tr '\n' ' ')"
