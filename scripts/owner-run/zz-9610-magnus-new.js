// READ-ONLY: Magnus state of the owner's NEW line (user 617, sip 793, did id by lookup): lineStatus, ipaddr presence, credit, offerUse, last CDRs. Credentials parsed in-process, never printed; secret-like keys hidden; phones masked.
const crypto = require('crypto'), fs = require('fs'), dotenv = require('dotenv'); const cur = dotenv.parse(fs.readFileSync('/app/.env.cur'));
const URLB = cur.MAGNUS_URL || 'https://voice00.epic.dm/mbilling', KEY = cur.MAGNUS_API_KEY || '', SEC = cur.MAGNUS_API_SECRET || '';
const enc = (s) => encodeURIComponent(String(s)).replace(/%20/g, '+').replace(/!/g, '%21').replace(/~/g, '%7E').replace(/\*/g, '%2A').replace(/'/g, '%27').replace(/\(/g, '%28').replace(/\)/g, '%29');
async function read(module, filters, limit = 20, sort, dir) {
  const mt = process.hrtime(); const nonce = mt[0].toString() + String(mt[1]).padStart(9, '0').slice(0, 6);
  const params = { page: '1', start: '0', limit: String(limit), filter: JSON.stringify(filters) }; if (sort) { params.sort = sort; params.dir = dir || 'DESC'; }
  const post = Object.entries({ module, action: 'read', nonce, ...params }).map(([k, v]) => enc(k) + '=' + enc(v)).join('&');
  const sig = crypto.createHmac('sha512', SEC).update(post).digest('hex');
  const r = await fetch(`${URLB}/index.php/${module}/read`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Key: KEY, Sign: sig }, body: post, signal: AbortSignal.timeout(20000) });
  const t = await r.text(); try { return JSON.parse(t); } catch { return { rows: [] }; }
}
const f = (field, value) => [{ type: 'numeric', field, value: String(value), comparison: 'eq' }];
const pick = (rows, o, keys) => { const r = {}; for (const k of keys) { if (o[k] !== undefined) r[k] = (/^(callerid|did|name|username)$/.test(k) && /\d{6,}/.test(String(o[k]))) ? '...' + String(o[k]).slice(-4) : o[k]; } return r; };
(async () => {
  const u = ((await read('user', f('id', 617))).rows || []).find((x) => x.id == 617);
  console.log('user 617:', u ? JSON.stringify(pick(0, u, ['id', 'username', 'active', 'credit', 'id_plan', 'id_offer', 'lastuse', 'creationdate'])) : 'NOT FOUND');
  const s = ((await read('sip', f('id_user', 617))).rows || []).filter((x) => x.id_user == 617);
  s.forEach((x) => console.log('sip:', JSON.stringify(pick(0, x, ['id', 'name', 'host', 'lineStatus', 'ipaddr', 'regseconds', 'lastms', 'useragent', 'status']))));
  const o = ((await read('offerUse', f('id_user', 617))).rows || []).filter((x) => x.id_user == 617);
  o.forEach((x) => console.log('offerUse:', JSON.stringify(pick(0, x, ['id', 'id_offer', 'status', 'reservationdate']))));
  const d = ((await read('did', f('id_user', 617))).rows || []).filter((x) => x.id_user == 617);
  d.forEach((x) => console.log('did:', JSON.stringify(pick(0, x, ['id', 'did', 'activated', 'reserved']))));
  const c = ((await read('call', f('id_user', 617), 10, 'starttime', 'DESC')).rows || []).filter((x) => x.id_user == 617);
  console.log('CDR rows for user 617:', c.length); c.slice(0, 5).forEach((x) => console.log('  ', x.starttime, x.sessiontime, x.terminatecauseid, '...' + String(x.calledstation).slice(-4)));
  const ctrl = ((await read('user', f('id', 101))).rows || []).find((x) => x.id == 101); console.log('control (tester user 101) readable:', Boolean(ctrl));
})().catch((e) => console.log('ERR', e.message));
