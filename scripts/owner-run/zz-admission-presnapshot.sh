#!/bin/bash
# PRE-DEPLOY SNAPSHOT for the admission release (run on host04 as root). Read-only except for the backup files it writes under /var/backups/admission-release-20261013/.
set -u
B=/var/backups/admission-release-20261013; mkdir -p $B; chmod 700 $B
F=/home/epicadmin/plprod/runtime-flags.json
cp -p $F $B/runtime-flags.json.pre-release; sha256sum $F | tee $B/runtime-flags.sha256 | cut -c1-80
echo "stat: $(stat -c '%a %U:%G %s bytes mtime %y' $F)"
echo "-- admission state (counts/booleans only):"; python3 -c "import json;d=json.load(open('$F'));print({k:(len(v) if isinstance(v,list) else v) for k,v in d.items() if k.startswith('LITE_ADMISSION') or k.startswith('PL_CONCIERGE_SVC_PROV') or k in ('LITE_SELF_SERVE_ENABLED','LITE_INBOUND_REACHABLE')}); print('LITE_ADMISSION_PAUSED key present:', 'LITE_ADMISSION_PAUSED' in d)"
C=$(docker ps -q -f name=uplink_plsub_restore_db | head -1)
q() { docker exec -i $C psql -U postgres -d isolav2_prod -X -At -c "$1" </dev/null; }
echo "-- protected rows (hash of non-secret columns), lines ...5098 (owner 9610) and ...5099 (8440):"
q "select md5(string_agg(t::text, '|' order by id)) , count(*) from (select id, \"userId\", did, \"magnusUserId\", \"magnusSipId\", \"magnusDidId\", \"magnusDiddestinationId\", \"ownerPhone\", \"registrationState\", \"registeredAt\", \"createdAt\" from lite_accounts where \"ownerPhone\" like '%2859610' and \"ownerPhone\" not like '%retired%' or \"ownerPhone\" like '%4158408440' and \"ownerPhone\" not like '%retired%') t" | tee $B/protected-lite-accounts.md5
q "select count(*) from lite_accounts" | tee $B/lite_accounts.count >/dev/null; echo "lite_accounts total: $(cat $B/lite_accounts.count)"
echo "-- Magnus user 614 + the 9610 line's user (module read, safe fields hash):"
P=$(docker ps -q -f name=uplink_plsvc-app -f status=running | head -1)
cat > /tmp/mg-prot.js <<'JS'
const fs = require('fs'), crypto = require('crypto');
const env = {}; for (const l of fs.readFileSync('/app/.env.cur', 'utf8').split('\n')) { const i = l.indexOf('='); if (i > 0) env[l.slice(0, i)] = l.slice(i + 1).replace(/^["']|["']$/g, ''); }
const enc = (s) => encodeURIComponent(s).replace(/%20/g, '+').replace(/!/g, '%21').replace(/~/g, '%7E').replace(/\*/g, '%2A').replace(/'/g, '%27').replace(/\(/g, '%28').replace(/\)/g, '%29');
async function mg(module, action, data) { const mt = process.hrtime(); const nonce = mt[0].toString() + String(mt[1]).padStart(9, '0').slice(0, 6); const body = Object.entries({ module, action, nonce, ...data }).map(([k, v]) => enc(k) + '=' + enc(String(v))).join('&'); const sign = crypto.createHmac('sha512', env.MAGNUS_API_SECRET).update(body).digest('hex'); const r = await fetch(`${env.MAGNUS_URL.replace(/\/+$/, '')}/index.php/${module}/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Key: env.MAGNUS_API_KEY, Sign: sign }, body, signal: AbortSignal.timeout(25000) }); return JSON.parse(await r.text()); }
const f = (field, value) => JSON.stringify([{ type: 'numeric', field, value: String(value), comparison: 'eq' }]);
const SAFE = ['id', 'active', 'credit', 'id_plan', 'id_offer', 'did', 'activated', 'host', 'callerid', 'status', 'creationdate', 'lastuse'];
(async () => {
  const ids = (process.argv[2] || '').split(',').filter(Boolean); const out = [];
  for (const uid of ids) for (const [mod, fld] of [['user', 'id'], ['sip', 'id_user'], ['did', 'id_user'], ['diddestination', 'id_user']]) {
    const j = await mg(mod, 'read', { page: '1', start: '0', limit: '20', filter: f(fld, uid) }); for (const r of (j.rows || [])) out.push(mod + ':' + JSON.stringify(Object.fromEntries(SAFE.filter((k) => k in r).map((k) => [k, r[k]]))));
  }
  console.log(crypto.createHash('md5').update(out.sort().join('\n')).digest('hex'), out.length + ' objects');
})().catch((e) => console.log('ERR', e.message));
JS
UIDS=$(q "select string_agg(\"magnusUserId\", ',') from lite_accounts where (\"ownerPhone\" like '%2859610' or \"ownerPhone\" like '%4158408440') and \"ownerPhone\" not like '%retired%'")
echo "protected Magnus user ids: $UIDS"
docker cp /tmp/mg-prot.js $P:/tmp/mg-prot.js >/dev/null && docker exec $P node /tmp/mg-prot.js "$UIDS" </dev/null | tee $B/protected-magnus.md5
echo "-- pl-watch state/timer:"; cat /var/lib/pl-watch/state.json; echo; systemctl list-timers pl-watch.timer --no-pager | sed -n 2p
echo "-- running plsvc image before: $(docker ps --format '{{.Image}}' -f id=$P)  container started: $(docker ps --format '{{.Status}}' -f id=$P)"
