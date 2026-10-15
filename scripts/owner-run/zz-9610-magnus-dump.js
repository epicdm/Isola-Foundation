// READ-ONLY: dump the raw Magnus objects of the owner's fixture line 9610 (user 613, sip 789, did 547, diddestination 421, offerUse 37) to /tmp/9610-magnus-before.json INSIDE the plsvc container (0600). Nothing is printed except object counts. Credentials parsed in-process from /app/.env.cur.
const crypto = require('crypto'), fs = require('fs'), dotenv = require('dotenv'); const cur = dotenv.parse(fs.readFileSync('/app/.env.cur'));
const URLB = cur.MAGNUS_URL || 'https://voice00.epic.dm/mbilling', KEY = cur.MAGNUS_API_KEY || '', SEC = cur.MAGNUS_API_SECRET || '';
const enc = (s) => encodeURIComponent(String(s)).replace(/%20/g, '+').replace(/!/g, '%21').replace(/~/g, '%7E').replace(/\*/g, '%2A').replace(/'/g, '%27').replace(/\(/g, '%28').replace(/\)/g, '%29');
async function read(module, filters, limit = 50) {
  const mt = process.hrtime(); const nonce = mt[0].toString() + String(mt[1]).padStart(9, '0').slice(0, 6);
  const params = { page: '1', start: '0', limit: String(limit), filter: JSON.stringify(filters) };
  const post = Object.entries({ module, action: 'read', nonce, ...params }).map(([k, v]) => enc(k) + '=' + enc(v)).join('&');
  const sig = crypto.createHmac('sha512', SEC).update(post).digest('hex');
  const r = await fetch(`${URLB}/index.php/${module}/read`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Key: KEY, Sign: sig }, body: post, signal: AbortSignal.timeout(20000) });
  const t = await r.text(); try { return JSON.parse(t); } catch { return { rows: [] }; }
}
const f = (field, value) => [{ type: 'numeric', field, value: String(value), comparison: 'eq' }];
(async () => {
  const out = {};
  const pick = (r, key, val) => (r.rows || []).filter((x) => String(x[key]) === String(val));
  out.user = pick(await read('user', f('id', 613)), 'id', 613);
  out.sip = pick(await read('sip', f('id_user', 613)), 'id_user', 613);
  out.did = pick(await read('did', f('id_user', 613)), 'id_user', 613);
  out.diddestination = pick(await read('diddestination', f('id_user', 613)), 'id_user', 613);
  out.offerUse = pick(await read('offerUse', f('id_user', 613)), 'id_user', 613);
  out.callerid = pick(await read('callerid', f('id_user', 613)), 'id_user', 613);
  out.calls = pick(await read('call', f('id_user', 613), 100), 'id_user', 613);
  fs.writeFileSync('/tmp/9610-magnus-before.json', JSON.stringify(out, null, 1), { mode: 0o600 });
  console.log('dumped counts:', Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.length])));
})().catch((e) => { console.log('ERR', e.message); process.exit(2); });
