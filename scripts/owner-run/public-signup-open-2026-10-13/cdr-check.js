// cdr-check.js v2 - read-only Magnus CDR probe for pl-watch (runs inside plsvc: docker exec -i <plsvc> sh -c 'cd /app && node - [--control]').
// ALARM KEYS ON (and only on): a plan-18 call in the last 24 h that was BILLED (sessionbill > 0) although the PL_TRIAL entitlement says it is COVERED, i.e.
//   (1) the call's prefix is a bundle prefix for plan 18 (rate.package_offer = 1; Dominica prefixes, not US/Canada), AND
//   (2) the user has an active PL_TRIAL offer-use (id_offer 3, status 1), AND
//   (3) the trial seconds consumed BEFORE this call (sum of offerCdr used_secondes dated before the call's end) were < 3600 (bundle minutes remained).
// A legitimate out-of-bundle wallet charge (bundle exhausted, or a non-bundle prefix such as US/Canada, or no active trial) is SILENT.
// --control: no alarm is raised for real data; prints the classifier results on SYNTHETIC cases and on one REAL read-only CDR (27058, a covered call billed 0) plus an IN-MEMORY mutated copy of it (sessionbill forced > 0): nothing is written anywhere.
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
const cond = (f, v) => ({ type: 'numeric', field: f, value: String(v), comparison: 'eq' });
const rd = async (m, conds, limit = 100) => { const j = await mg(m, 'read', { page: '1', start: '0', limit: String(limit), sort: 'id', dir: 'DESC', filter: JSON.stringify(conds) }); return Array.isArray(j.rows) ? j.rows : []; };
const BUNDLE_S = 3600;
// PURE classifier: returns 'ALARM' only for a billed call that the trial entitlement says is covered.
function classify({ sessionbill, packageOffer, trialActive, usedBeforeS }) {
  if (!(Number(sessionbill) > 0)) return 'silent';
  if (Number(packageOffer) !== 1) return 'silent';         // not a bundle prefix (e.g. US/Canada): a wallet charge is legitimate
  if (!trialActive) return 'silent';                       // no active trial entitlement
  if (Number(usedBeforeS) >= BUNDLE_S) return 'silent';    // bundle exhausted: out-of-bundle wallet charge is legitimate
  return 'ALARM';
}
const ts = (r) => Date.parse(String(r.starttime).replace(' ', 'T') + 'Z') + Number(r.sessiontime || 0) * 1000;
async function facts(r) {
  const rate = await rd('rate', [cond('id_plan', 18), cond('id_prefix', r.id_prefix)], 1);
  const ou = await rd('offerUse', [cond('id_user', r.id_user)], 5);
  const oc = await rd('offerCdr', [cond('id_user', r.id_user)], 200);
  const end = ts(r);
  const usedBefore = oc.filter((x) => Date.parse(String(x.date_consumption).replace(' ', 'T') + 'Z') < end - 1000).reduce((a, x) => a + Number(x.used_secondes || 0), 0);
  return { packageOffer: rate[0] ? rate[0].package_offer : 0, trialActive: ou.some((x) => Number(x.id_offer) === 3 && Number(x.status) === 1), usedBeforeS: usedBefore };
}
(async () => {
  if (process.argv.includes('--control')) {
    const syn = [
      ['A covered call billed (must ALARM)', { sessionbill: 0.135, packageOffer: 1, trialActive: true, usedBeforeS: 600 }],
      ['B out-of-bundle charge, bundle exhausted (must be silent)', { sessionbill: 0.135, packageOffer: 1, trialActive: true, usedBeforeS: 3600 }],
      ['C US/Canada non-bundle prefix charged (must be silent)', { sessionbill: 1.49, packageOffer: 0, trialActive: true, usedBeforeS: 0 }],
      ['D covered call billed 0 (must be silent)', { sessionbill: 0, packageOffer: 1, trialActive: true, usedBeforeS: 0 }],
    ];
    for (const [n, c] of syn) console.log(`CASE ${n}: ${classify(c)}`);
    const real = (await rd('call', [cond('id', 27058)], 1))[0];
    if (!real) { console.log('CASE real CDR 27058: NOT FOUND'); return; }
    const f = await facts(real);
    console.log(`CASE real read-only CDR 27058 as recorded (covered, billed ${real.sessionbill}; facts package_offer=${f.packageOffer} trialActive=${f.trialActive} usedBeforeS=${f.usedBeforeS}): ${classify({ sessionbill: real.sessionbill, ...f })}`);
    console.log(`CASE real CDR 27058 with IN-MEMORY sessionbill forced to 0.135 (must ALARM; nothing written): ${classify({ sessionbill: 0.135, ...f })}`);
    return;
  }
  const rows = (await rd('call', [cond('id_plan', 18)], 100)).filter((r) => Date.parse(String(r.starttime).replace(' ', 'T') + 'Z') >= Date.now() - 86400e3 && Number(r.sessionbill) > 0);
  let n = 0;
  for (const r of rows) { const f = await facts(r); if (classify({ sessionbill: r.sessionbill, ...f }) === 'ALARM') n++; }
  console.log(`CDR_CHECK n=${n} mode=normal billed_rows=${rows.length}`);
})().catch((e) => { console.log('CDR_CHECK_ERROR ' + String(e.message).slice(0, 80)); process.exit(0); });
