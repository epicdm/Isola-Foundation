// zz-fx-reset.js - runs INSIDE the production plsvc (docker exec -i -w /app <plsvc> node - with MODE=dry|real). The supported fixture-reset route for the ratified synthetic fixture 17675550911 ONLY (the route itself refuses any other number).
// Internal secret read in-process from /app/.env.cur, never printed. dry = preview + receipt (kept in /tmp/fx-receipt.txt inside the container); real = deactivate with that receipt.
const fs = require('fs'), dotenv = require('dotenv');
const cur = dotenv.parse(fs.readFileSync('/app/.env.cur'));
const MODE = process.env.MODE, PHONE = process.env.TARGET || '17675550911';
if (PHONE !== '17675550911' && PHONE !== process.env.ALLOW_OTHER) { console.log('REFUSED: this script only handles the fixture 17675550911'); process.exit(3); }
(async () => {
  const body = { targetPhone: PHONE, dryRun: MODE !== 'real', magnusUser: 'deactivate' };
  if (MODE === 'real') { body.actor = 'lane-a-owner-authorized-fixture-run'; body.operatorReason = 'Owner-authorized bounded fixture test O1-O9 on the synthetic fixture 17675550911 (PM relay 2026-10-13); ' + (process.env.REASON || 'reset'); body.previewReceipt = fs.readFileSync('/tmp/fx-receipt.txt', 'utf8').trim(); }
  const r = await fetch('http://127.0.0.1:3005/api/internal/personal-line/fixture-reset', { method: 'POST', headers: { 'content-type': 'application/json', 'x-internal-secret': cur.INTERNAL_SECRET }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  console.log(MODE.toUpperCase(), 'HTTP', r.status, '| ok:', j.ok, '| error:', j.error || '-', '| dryRun:', j.dryRun, '| magnusUser:', j.magnusUser || j.mode || '-');
  for (const s of (j.steps || [])) console.log('  -', String(s.step).padEnd(34), String(s.status).padEnd(8), String(s.detail || '').replace(/(secret|password|passwd)[^,;}\s]*/gi, '[redacted-field]').slice(0, 170));
  if (MODE !== 'real' && j.previewReceipt) { fs.writeFileSync('/tmp/fx-receipt.txt', j.previewReceipt, { mode: 0o600 }); console.log('previewReceipt stored in the container (length ' + j.previewReceipt.length + ', not printed)'); }
  if (MODE !== 'real' && !j.previewReceipt) console.log('NO previewReceipt in the response; keys:', Object.keys(j).join(','));
})().catch((e) => { console.log('ERR', e.message); process.exit(2); });
