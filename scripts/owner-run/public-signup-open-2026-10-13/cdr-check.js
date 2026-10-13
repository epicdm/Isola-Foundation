// cdr-check.js - read-only Magnus CDR probe for pl-watch (runs inside plsvc: docker exec -i <plsvc> sh -c 'cd /app && node - [--control]').
// FALSE CHARGE = a plan-18 call in the last 24 h billed > 0 for a user on the PL_TRIAL offer whose trial seconds are not exhausted (trial calls must bill 0).
// --control: counts ALL plan-18 CDRs in the last 7 days instead (proves the instrument can see rows; expected >= 1 because CDR 27058 exists). Prints one line: CDR_CHECK n=<count> mode=<normal|control>.
const fs = require('fs'), crypto = require('crypto');
const env = {}; for (const l of fs.readFileSync('/app/.env.cur', 'utf8').split('\n')) { const i = l.indexOf('='); if (i > 0) env[l.slice(0, i)] = l.slice(i + 1).replace(/^["']|["']$/g, ''); }
const enc = (s) => encodeURIComponent(s).replace(/%20/g, '+').replace(/!/g, '%21').replace(/~/g, '%7E').replace(/\*/g, '%2A').replace(/'/g, '%27').replace(/\(/g, '%28').replace(/\)/g, '%29');
async function mg(module, action, data) {
  const mt = process.hrtime(); const nonce = mt[0].toString() + String(mt[1]).padStart(9, '0').slice(0, 6);
  const body = Object.entries({ module, action, nonce, ...data }).map(([k, v]) => enc(k) + '=' + enc(String(v))).join('&');
  const sign = crypto.createHmac('sha512', env.MAGNUS_API_SECRET).update(body).digest('hex');
  const r = await fetch(`${env.MAGNUS_URL.replace(/\/+$/, '')}/index.php/${module}/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Key: env.MAGNUS_API_KEY, Sign: sign }, body });
  return JSON.parse(await r.text());
}
const num = (f, v) => ({ type: 'numeric', field: f, value: String(v), comparison: 'eq' });
(async () => {
  const control = process.argv.includes('--control');
  const j = await mg('call', 'read', { page: '1', start: '0', limit: '100', sort: 'id', dir: 'DESC', filter: JSON.stringify([num('id_plan', 18)]) });
  const rows = Array.isArray(j.rows) ? j.rows : [];
  const since = Date.now() - (control ? 7 : 1) * 86400e3;
  const recent = rows.filter((r) => Date.parse(String(r.starttime).replace(' ', 'T') + 'Z') >= since);
  if (control) { console.log(`CDR_CHECK n=${recent.length} mode=control`); return; }
  let n = 0;
  for (const r of recent.filter((x) => Number(x.sessionbill) > 0)) {
    const u = await mg('user', 'read', { page: '1', start: '0', limit: '1', filter: JSON.stringify([num('id', r.id_user)]) });
    if (!u.rows || !u.rows[0] || Number(u.rows[0].id_offer) !== 3) continue;
    const oc = await mg('offerCdr', 'read', { page: '1', start: '0', limit: '200', filter: JSON.stringify([num('id_user', r.id_user)]) });
    const used = (oc.rows || []).reduce((a, x) => a + Number(x.used_secondes || 0), 0);
    if (used < 3600) n++;
  }
  console.log(`CDR_CHECK n=${n} mode=normal`);
})().catch((e) => { console.log('CDR_CHECK_ERROR ' + String(e.message).slice(0, 80)); process.exit(0); });
