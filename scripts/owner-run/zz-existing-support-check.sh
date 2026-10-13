#!/bin/bash
# (b) Existing-customer support under the NEW image: three signed READ-ONLY concierge reads for the owner's own existing line (9610 -> line ...5098), through the running production plsvc.
# Nothing is written by these reads; the admission log and queue must be UNCHANGED around them (the gate is never called). POSITIVE CONTROL for "the log would move if the gate were called": see the staging doors run (zz-doors-stage.sh), where the same tables gain rows on a provisioning attempt.
set -u
C=$(docker ps -q -f name=uplink_plsub_restore_db | head -1); P=$(docker ps -q -f name=uplink_plsvc-app -f status=running | head -1)
q() { docker exec -i $C psql -U postgres -d isolav2_prod -X -At -c "$1" </dev/null; }
snap() { echo "log=$(q 'select count(*) from lite_admission_log') queue=$(q 'select count(*) from lite_admission_queue') attempts=$(q 'select count(*) from lite_provision_attempts') accounts=$(q 'select count(*) from lite_accounts')"; }
echo "BEFORE: $(snap)"
cat > /tmp/ex-support.js <<'JS'
const crypto = require('crypto'), fs = require('fs');
const KEY = fs.readFileSync('/app/.plkey', 'utf8').trim(); const b64u = (x) => Buffer.from(x).toString('base64url');
async function call(ep) {
  const p = { kid: 'pl2', wa_id: '17672859610', pnid: '1023804347491554', rid: 'cw-existing-support-' + crypto.randomBytes(4).toString('hex'), mid: 'wamid.EXISTING' + crypto.randomBytes(6).toString('hex'), iat: Math.floor(Date.now() / 1000), nonce: crypto.randomBytes(16).toString('base64url') };
  const P = b64u(JSON.stringify(p)); const S = crypto.createHmac('sha256', Buffer.from(KEY, 'utf8')).update('v1.' + P).digest('base64url');
  const r = await fetch('http://127.0.0.1:3005/api/internal/pl-concierge/v1/' + ep, { method: 'POST', headers: { 'content-type': 'application/json', 'x-isola-assertion': `v1.${P}.${S}`, 'x-conversation-id': p.rid }, body: '{}' });
  const j = await r.json().catch(() => ({})); const d = j.data || {};
  console.log(ep.padEnd(20), 'HTTP', r.status, 'code', j.code, '| state/plan facts present:', Object.keys(d.facts || d).slice(0, 6).join(','));
}
(async () => { for (const ep of ['account/journey', 'account/balance', 'account/line-status']) await call(ep); })().catch((e) => console.log('ERR', e.message));
JS
docker cp /tmp/ex-support.js $P:/tmp/ex-support.js >/dev/null && docker exec $P node /tmp/ex-support.js </dev/null
sleep 2
echo "AFTER:  $(snap)"
