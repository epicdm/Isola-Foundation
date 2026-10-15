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
const ct = (field, value) => [{ type: 'string', field, value: String(value), comparison: 'ct' }];
(async () => {
  // CONTROL: are inbound DID calls recorded at all? Any call row whose calledstation is one of OUR DIDs (1767818...) in the last rows.
  const c = await read('call', ct('calledstation', '1767818'), 10, 'starttime', 'DESC'); const rows = c.rows || [];
  console.log('CONTROL inbound-style rows (calledstation contains 1767818xxxx): returned', rows.length);
  rows.slice(0, 4).forEach((x) => console.log('   ', JSON.stringify(show(x)).slice(0, 300)));
  const c2 = await read('call', ct('calledstation', '1767818'), 3, 'starttime', 'DESC'); void c2;
  const d = await read('callFailed', ct('calledstation', '1767818'), 5, 'starttime', 'DESC'); console.log('CONTROL failed inbound-style rows:', (d.rows || []).length);
  const e = await read('call', ct('calledstation', '5102'), 10, 'starttime', 'DESC'); console.log('calledstation contains 5102 (any):', (e.rows || []).length);
  const g = await read('call', ct('calledstation', '8382'), 10, 'starttime', 'DESC'); console.log('calls to ...8382 completed rows:', (g.rows || []).length); (g.rows || []).slice(0, 3).forEach((x) => console.log('   ', JSON.stringify(show(x)).slice(0, 300)));
})().catch((e) => console.log('ERR', e.message));
