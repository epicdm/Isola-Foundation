#!/bin/bash
# O7 / O8 for the owner-authorized synthetic fixture 17675550911 ONLY. Usage: zz-fx-sip.sh register | call
# SIP credentials are read from the plsvc database into shell variables and handed to a throwaway container (docker run --rm: removed on exit) by NAME; they are never printed or written to disk.
set -u
MODE=${1:-register}; PH=17675550911
C=$(docker ps -q -f name=uplink_plsub_restore_db | head -1); P=$(docker ps -q -f name=uplink_plsvc-app -f status=running | head -1)
export SIPUSER=$(docker exec -i $C psql -U postgres -d isolav2_prod -X -At -c "select \"sipUsername\" from lite_accounts where \"ownerPhone\" = '$PH'" </dev/null)
export SIPPASS=$(docker exec -i $C psql -U postgres -d isolav2_prod -X -At -c "select \"sipPassword\" from lite_accounts where \"ownerPhone\" = '$PH'" </dev/null)
[ -n "$SIPUSER" ] && [ -n "$SIPPASS" ] || { echo "ABORT: fixture line credentials not found"; exit 9; }
echo "user name length ${#SIPUSER}, credential present; target voice03.epic.dm:5060 (UDP); mode $MODE"
if [ "$MODE" = register ]; then
  ( sleep 9; echo "--- server-side registration read while the UA is registered (signed line-status for ***0911):"; docker exec -i -w /app $P node - <<'JS'
const crypto = require('crypto'), fs = require('fs'); const KEY = fs.readFileSync('/app/.plkey', 'utf8').trim(); const b64u = (x) => Buffer.from(x).toString('base64url');
(async () => { const p = { kid: 'pl2', wa_id: '17675550911', pnid: '1023804347491554', rid: 'cw-fixture-o7-' + crypto.randomBytes(4).toString('hex'), mid: 'wamid.FIXTUREO7' + crypto.randomBytes(8).toString('hex'), iat: Math.floor(Date.now() / 1000), nonce: crypto.randomBytes(16).toString('base64url') }; const P = b64u(JSON.stringify(p)); const S = crypto.createHmac('sha256', Buffer.from(KEY, 'utf8')).update('v1.' + P).digest('base64url');
  const r = await fetch('http://127.0.0.1:3005/api/internal/pl-concierge/v1/account/line-status', { method: 'POST', headers: { 'content-type': 'application/json', 'x-isola-assertion': `v1.${P}.${S}`, 'x-conversation-id': p.rid }, body: '{}' }); const j = await r.json().catch(() => ({})); const d = j.data || {};
  console.log('line-status HTTP', r.status, 'code', j.code, '| registration:', d.registration, '| listener_connected:', d.listener_connected, '| softphone_activated:', d.softphone_activated, '| first_call_done:', d.first_call_done); })();
JS
  ) &
  docker run --rm -e SIPUSER -e SIPPASS -e SIP_HOST=voice03.epic.dm -e SIP_PORT=5060 -e MODE=register -e REG_HOLD_S=22 -v /tmp/zz-sip-ua.js:/s.js:ro node:22-slim node /s.js
  wait
else
  docker run --rm -e SIPUSER -e SIPPASS -e SIP_HOST=voice03.epic.dm -e SIP_PORT=5060 -e MODE=call -e DEST=17678182203 -e HOLD_S=30 -v /tmp/zz-sip-ua.js:/s.js:ro node:22-slim node /s.js
fi
