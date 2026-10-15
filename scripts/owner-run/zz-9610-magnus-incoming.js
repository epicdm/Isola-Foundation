// READ-ONLY: look for the owner's INCOMING call to DID ...5102 in Magnus: didUse, callFailed, and any call row whose calledstation/dnid is the DID; plus the DID row usage fields and a positive control on didUse (any row readable). Credentials in-process; phones masked.
const crypto = require('crypto'), fs = require('fs'), dotenv = require('dotenv'); const cur = dotenv.parse(fs.readFileSync('/app/.env.cur'));
const URLB = cur.MAGNUS_URL || 'https://voice00.epic.dm/mbilling', KEY = cur.MAGNUS_API_KEY || '', SEC = cur.MAGNUS_API_SECRET || '';
const enc = (s) => encodeURIComponent(String(s)).replace(/%20/g, '+').replace(/!/g, '%21').replace(/~/g, '%7E').replace(/\*/g, '%2A').replace(/'/g, '%27').replace(/\(/g, '%28').replace(/\)/g, '%29');
async function read(module, filters, limit = 20, sort, dir) {
  const mt = process.hrtime(); const nonce = mt[0].toString() + String(mt[1]).padStart(9, '0').slice(0, 6);
  const params = { page: '1', start: '0', limit: String(limit), filter: JSON.stringify(filters) }; if (sort) { params.sort = sort; params.dir = dir || 'DESC'; }
  const post = Object.entries({ module, action: 'read', nonce, ...params }).map(([k, v]) => enc(k) + '=' + enc(v)).join('&');
  const sig = crypto.createHmac('sha512', SEC).update(post).digest('hex');
  const r = await fetch(`${URLB}/index.php/${module}/read`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Key: KEY, Sign: sig }, body: post, signal: AbortSignal.timeout(20000) });
  const t = await r.text(); try { return JSON.parse(t); } catch { return { rows: [], err: t.slice(0, 80) }; }
}
const num = (field, value) => [{ type: 'numeric', field, value: String(value), comparison: 'eq' }];
const HIDE = /secret|pass|md5|key|token|hash|pin/i;
const tail = (v) => (v === null || v === undefined || v === '' ? v : /\d{6,}/.test(String(v)) ? '...' + String(v).replace(/\D/g, '').slice(-4) : v);
const show = (o) => { const r = {}; for (const [k, v] of Object.entries(o)) if (!HIDE.test(k) && v !== null && v !== '' && v !== 0 && v !== '0' && v !== '0.00000' && v !== '0.000') r[k] = /^(callerid|did|calledstation|src|dnid|number|called)$/i.test(k) ? tail(v) : v; return r; };
(async () => {
  for (const [mod, filt] of [['didUse', num('id_did', 551)], ['didUse', []], ['callFailed', num('id_user', 617)], ['callFailed', []]]) {
    const r = await read(mod, filt, 6, 'id', 'DESC'); const rows = r.rows || [];
    console.log(`${mod}${filt.length ? ' id filter' : ' (no filter, control)'}: ${rows.length} rows${r.err ? ' err=' + r.err : ''}`);
    rows.slice(0, 3).forEach((x) => console.log('   ', JSON.stringify(show(x)).slice(0, 300)));
  }
  const all = (await read('call', [], 15, 'starttime', 'DESC')).rows || [];
  const mine = all.filter((x) => String(x.dnid || x.calledstation || '').endsWith('5102') || String(x.callerid || '').endsWith('5102') || x.id_user == 617);
  console.log('recent global call rows read:', all.length, '| of which touching ...5102 / user 617:', mine.length);
  mine.forEach((x) => console.log('   CALL', JSON.stringify(show(x)).slice(0, 380)));
  const d = ((await read('did', num('id', 551))).rows || []).find((x) => x.id == 551); console.log('DID 551 usage fields:', JSON.stringify(show(d || {})).slice(0, 360));
})().catch((e) => console.log('ERR', e.message));
