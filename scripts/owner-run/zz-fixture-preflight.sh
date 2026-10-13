#!/bin/bash
# FIXTURE PRE-FLIGHT (read-only): what the in-process operations will need exists (booleans/names only), the baseline still equals the snapshots, and the guardrail hashes are recorded.
set -u
P=$(docker ps -q -f name=uplink_plsvc-app -f status=running | head -1); C=$(docker ps -q -f name=uplink_plsub_restore_db | head -1)
q() { docker exec -i $C psql -U postgres -d isolav2_prod -X -At -c "$1" </dev/null; }
cat > /tmp/pf.js <<'JS'
const fs = require('fs'), dotenv = require('dotenv');
const cur = dotenv.parse(fs.readFileSync('/app/.env.cur'));
const want = ['INTERNAL_SECRET', 'ISOLA_INTERNAL_SECRET', 'PL_OPERATOR_WRITE_TOKEN', 'PL_ASSERTION_HMAC_KEY', 'PL_ASSERTION_KID', 'META_APP_SECRET', 'FLOW_PRIVATE_KEY_B64', 'MAGNUS_URL', 'MAGNUS_API_KEY', 'MAGNUS_API_SECRET', 'MAGNUS_SIP_SERVER', 'PL_CONCIERGE_PNID_ALLOWLIST', 'WHATSAPP_TOKEN', 'PL_SIGNUP_FLOW_ID'];
console.log('present in /app/.env.cur (booleans):', JSON.stringify(Object.fromEntries(want.map((k) => [k, Boolean(cur[k])]))));
console.log('process.env also has (booleans):', JSON.stringify(Object.fromEntries(['INTERNAL_SECRET', 'PL_OPERATOR_WRITE_TOKEN', 'PL_ASSERTION_HMAC_KEY'].map((k) => [k, Boolean(process.env[k])]))));
const u = cur.MAGNUS_SIP_SERVER || ''; console.log('MAGNUS_SIP_SERVER host:', u.replace(/^sip:/, '').split(':')[0], '| MAGNUS_URL host:', (() => { try { return new URL(cur.MAGNUS_URL).host } catch { return '?' } })());
JS
docker exec -i -w /app $P node - < /tmp/pf.js
echo "-- flags == pre-release snapshot: $( [ "$(sha256sum /home/epicadmin/plprod/runtime-flags.json | cut -c1-64)" = "$(cut -c1-64 /var/backups/admission-release-20261013/runtime-flags.sha256)" ] && echo IDENTICAL || echo DIFFERENT )"
echo "-- fixture snapshot files still present: $(ls /var/backups/fixture-17675550911-20261013 | tr '\n' ' ')"
echo "-- fixture row now (id, did, magnus ids, retired?): $(q "select id||' | '||did||' | '||\"magnusUserId\"||','||\"magnusSipId\"||','||\"magnusDidId\"||','||\"magnusDiddestinationId\"||' | '||(\"ownerPhone\" like '%retired%') from lite_accounts where \"ownerPhone\" like '%7675550911%'")"
echo "-- DID pool free count (spare) not read here; wa_send_audit baseline for the fixture: $(q "select count(*) from wa_send_audit where phone like '%7675550911%'")"
echo "-- sip client image available locally?"; docker images --format '{{.Repository}}:{{.Tag}}' | grep -E "^python:|^node:22-slim" | head -3
echo "-- outbound UDP 5060 route check (no packets sent): $(getent hosts voice03.epic.dm | head -1)  $(getent hosts voice00.epic.dm | head -1)"
