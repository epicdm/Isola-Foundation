// pl-watch probe (READ-ONLY, run inside plsvc via `docker exec -i ... node -`): how many Personal Line numbers can Magnus still hand out?
// Same eligibility selector as isUnassignedDidCandidate in app/lib/magnus.ts (1767818xxxx, activated, no id_user, not reserved); upper bound - the forbidden list and the per-row diddestination check are not applied.
// Output (one line, counts only): DID_INVENTORY unassigned=N assigned=N total=N     On any failure: DID_CHECK_ERROR <reason>.  Credentials are read in-process from /app/.env.cur and never printed.
const fs = require('fs'), crypto = require('crypto'), dotenv = require('dotenv');
(async () => {
  const cur = dotenv.parse(fs.readFileSync('/app/.env.cur'));
  const URL_ = cur.MAGNUS_URL || 'https://voice00.epic.dm/mbilling', KEY = cur.MAGNUS_API_KEY, SEC = cur.MAGNUS_API_SECRET;
  if (!KEY || !SEC) { console.log('DID_CHECK_ERROR magnus credentials absent'); return; }
  const enc = (s) => encodeURIComponent(s).replace(/%20/g, '+').replace(/!/g, '%21').replace(/~/g, '%7E').replace(/\*/g, '%2A').replace(/'/g, '%27').replace(/\(/g, '%28').replace(/\)/g, '%29');
  const norm = (row) => { const d = String(row.did ?? '').replace(/\D/g, ''); return d.length === 10 ? '1' + d : d; };
  let unassigned = 0, assigned = 0, total = 0;
  for (let page = 1; page <= 30; page++) {
    const mt = process.hrtime(); const nonce = mt[0].toString() + String(mt[1]).padStart(9, '0').slice(0, 6);
    const post = Object.entries({ module: 'did', action: 'read', nonce, page: String(page), start: String((page - 1) * 100), limit: '100', sort: 'id', dir: 'DESC' }).map(([k, v]) => enc(k) + '=' + enc(v)).join('&');
    const sign = crypto.createHmac('sha512', SEC).update(post).digest('hex');
    const r = await fetch(`${URL_}/index.php/did/read`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Key: KEY, Sign: sign }, body: post, signal: AbortSignal.timeout(30000) });
    if (r.status !== 200) { console.log('DID_CHECK_ERROR magnus http ' + r.status); return; }
    const j = await r.json().catch(() => null);
    if (!j || !Array.isArray(j.rows)) { console.log('DID_CHECK_ERROR unexpected magnus response'); return; }
    if (page === 1) total = Number(j.count ?? 0);
    for (const row of j.rows) {
      const d = norm(row); if (!(d.length === 11 && d.startsWith('1767818'))) continue;
      const taken = row.id_user && row.id_user !== 0 && row.id_user !== '0';
      const reserved = row.reserved && row.reserved !== 0 && row.reserved !== '0';
      const activated = row.activated === 1 || row.activated === '1';
      if (taken) assigned++; else if (!reserved && activated) unassigned++;
    }
    if (j.rows.length < 100) break;
  }
  console.log(`DID_INVENTORY unassigned=${unassigned} assigned=${assigned} total=${total}`);
})().catch((e) => console.log('DID_CHECK_ERROR ' + String(e.message).slice(0, 100)));
