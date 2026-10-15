// READ-ONLY: count spare DIDs in the Magnus pool the way admission sees "spareDids" (DID rows with reserved=0 and no owner). Runs inside plsvc; credentials parsed in-process, never printed.
const crypto = require('crypto'), fs = require('fs'), dotenv = require('dotenv'); const cur = dotenv.parse(fs.readFileSync('/app/.env.cur'));
const URLB = cur.MAGNUS_URL || 'https://voice00.epic.dm/mbilling', KEY = cur.MAGNUS_API_KEY || '', SEC = cur.MAGNUS_API_SECRET || '';
const enc = (s) => encodeURIComponent(String(s)).replace(/%20/g, '+').replace(/!/g, '%21').replace(/~/g, '%7E').replace(/\*/g, '%2A').replace(/'/g, '%27').replace(/\(/g, '%28').replace(/\)/g, '%29');
async function read(module, filters, limit = 500) {
  const mt = process.hrtime(); const nonce = mt[0].toString() + String(mt[1]).padStart(9, '0').slice(0, 6);
  const post = Object.entries({ module, action: 'read', nonce, page: '1', start: '0', limit: String(limit), filter: JSON.stringify(filters) }).map(([k, v]) => enc(k) + '=' + enc(v)).join('&');
  const sig = crypto.createHmac('sha512', SEC).update(post).digest('hex');
  const r = await fetch(`${URLB}/index.php/${module}/read`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Key: KEY, Sign: sig }, body: post, signal: AbortSignal.timeout(20000) });
  const t = await r.text(); try { return JSON.parse(t); } catch { return { rows: [], error: 'non-json' }; }
}
(async () => {
  const all = await read('did', [{ type: 'numeric', field: 'reserved', value: '0', comparison: 'eq' }]);
  const rows = (all.rows || []).filter((x) => String(x.reserved) === '0');
  const withOwner = rows.filter((x) => x.id_user && Number(x.id_user) > 0).length;
  console.log('Magnus DID rows with reserved=0:', rows.length, '| of which with an owner:', withOwner, '| spare (reserved=0, no owner):', rows.length - withOwner, '| total field present:', all.total ?? 'n/a');
  const f547 = await read('did', [{ type: 'numeric', field: 'id', value: '547', comparison: 'eq' }]);
  const d = (f547.rows || []).find((x) => String(x.id) === '547');
  console.log('DID 547 (...5098) after reset: ', d ? JSON.stringify({ reserved: d.reserved, id_user: d.id_user, activated: d.activated }) : 'not found');
})().catch((e) => console.log('ERR', e.message));
