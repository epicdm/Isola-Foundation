// READ-ONLY verification of the owner's new line in Magnus (user 617, sip 793, DID 551 ...5102): registration fields, offerUse pool, credit, ALL call rows for the user, the servers list, plus a positive control (owner's previous user 613 call row of 2026-10-11). Credentials parsed in-process, never printed; phones masked to last 4.
const crypto = require('crypto'), fs = require('fs'), dotenv = require('dotenv'); const cur = dotenv.parse(fs.readFileSync('/app/.env.cur'));
const URLB = cur.MAGNUS_URL || 'https://voice00.epic.dm/mbilling', KEY = cur.MAGNUS_API_KEY || '', SEC = cur.MAGNUS_API_SECRET || '';
const enc = (s) => encodeURIComponent(String(s)).replace(/%20/g, '+').replace(/!/g, '%21').replace(/~/g, '%7E').replace(/\*/g, '%2A').replace(/'/g, '%27').replace(/\(/g, '%28').replace(/\)/g, '%29');
async function read(module, filters, limit = 50, sort, dir) {
  const mt = process.hrtime(); const nonce = mt[0].toString() + String(mt[1]).padStart(9, '0').slice(0, 6);
  const params = { page: '1', start: '0', limit: String(limit), filter: JSON.stringify(filters) }; if (sort) { params.sort = sort; params.dir = dir || 'DESC'; }
  const post = Object.entries({ module, action: 'read', nonce, ...params }).map(([k, v]) => enc(k) + '=' + enc(v)).join('&');
  const sig = crypto.createHmac('sha512', SEC).update(post).digest('hex');
  const r = await fetch(`${URLB}/index.php/${module}/read`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Key: KEY, Sign: sig }, body: post, signal: AbortSignal.timeout(20000) });
  const t = await r.text(); try { return JSON.parse(t); } catch { return { rows: [] }; }
}
const f = (field, value) => [{ type: 'numeric', field, value: String(value), comparison: 'eq' }];
const HIDE = /secret|pass|md5|key|token|hash|pin/i;
const tail = (v) => (v === null || v === undefined || v === '' ? v : /\d{6,}/.test(String(v)) ? '...' + String(v).replace(/\D/g, '').slice(-4) : v);
const pick = (o, keys) => { const r = {}; for (const k of keys) if (o[k] !== undefined && !HIDE.test(k)) r[k] = /^(callerid|did|name|username|calledstation|src|dst|callerid|called|number)$/i.test(k) ? tail(o[k]) : o[k]; return r; };
(async () => {
  const U = ((await read('user', f('id', 617))).rows || []).find((x) => x.id == 617);
  console.log('USER 617:', JSON.stringify(pick(U || {}, ['id', 'active', 'credit', 'id_plan', 'id_offer', 'lastuse', 'creationdate'])));
  const S = ((await read('sip', f('id_user', 617))).rows || []).filter((x) => x.id_user == 617);
  S.forEach((x) => console.log('SIP:', JSON.stringify(pick(x, ['id', 'host', 'lineStatus', 'ipaddr', 'port', 'regseconds', 'lastms', 'useragent', 'status', 'fullcontact', 'regserver', 'id_server']))));
  const O = ((await read('offerUse', f('id_user', 617))).rows || []).filter((x) => x.id_user == 617);
  O.forEach((x) => console.log('OFFERUSE:', JSON.stringify(x)));
  const of3 = ((await read('offer', f('id', 3))).rows || []).find((x) => x.id == 3); console.log('OFFER 3:', JSON.stringify(pick(of3 || {}, ['id', 'label', 'packagetype', 'freetimetocall', 'billingtype', 'price'])));
  const C = ((await read('call', f('id_user', 617), 50, 'starttime', 'ASC')).rows || []).filter((x) => x.id_user == 617);
  console.log('CALL rows for user 617:', C.length);
  C.forEach((x) => console.log(' CALL', JSON.stringify(pick(x, ['id', 'starttime', 'sessiontime', 'real_sessiontime', 'sessionbill', 'buycost', 'terminatecauseid', 'calledstation', 'callerid', 'id_prefix', 'id_offer', 'id_did', 'sipiax', 'uniqueid', 'src', 'dnid']))));
  // Control: the owner's PREVIOUS line (user 613) had one 60 s call on 2026-10-11 and must still read.
  const C13 = ((await read('call', f('id_user', 613), 5, 'starttime', 'DESC')).rows || []).filter((x) => x.id_user == 613);
  console.log('CONTROL previous owner user 613 call rows readable:', C13.length);
  const SV = (await read('servers', [], 10)).rows || []; console.log('SERVERS:', SV.length, JSON.stringify(SV.map((x) => pick(x, ['id', 'name', 'host', 'type', 'status', 'last_call', 'sip_port']))).slice(0, 400));
  const DID = ((await read('did', f('id', 551))).rows || []).find((x) => x.id == 551); console.log('DID 551:', JSON.stringify(pick(DID || {}, ['id', 'did', 'id_user', 'activated', 'reserved', 'billingtype', 'fixrate', 'connection_charge'])));
})().catch((e) => console.log('ERR', e.message));
