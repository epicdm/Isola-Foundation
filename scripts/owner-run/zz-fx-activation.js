// zz-fx-activation.js - runs INSIDE the production plsvc (docker exec -i -w /app <plsvc> node -). O6 for the authorized synthetic fixture 17675550911 ONLY: mint the activation link (signed concierge call), GET the landing on the public go host, read the STRUCTURE of what comes back.
// No credential, nonce or link value is printed; booleans, host, status and sizes only.
const crypto = require('crypto'), fs = require('fs');
const KEY = fs.readFileSync('/app/.plkey', 'utf8').trim(); const b64u = (x) => Buffer.from(x).toString('base64url');
const WA = '17675550911';
(async () => {
  const p = { kid: 'pl2', wa_id: WA, pnid: '1023804347491554', rid: 'cw-fixture-o6-' + crypto.randomBytes(4).toString('hex'), mid: 'wamid.FIXTUREO6' + crypto.randomBytes(8).toString('hex'), iat: Math.floor(Date.now() / 1000), nonce: crypto.randomBytes(16).toString('base64url') };
  const P = b64u(JSON.stringify(p)); const S = crypto.createHmac('sha256', Buffer.from(KEY, 'utf8')).update('v1.' + P).digest('base64url');
  const r = await fetch('http://127.0.0.1:3005/api/internal/pl-concierge/v1/links/activation', { method: 'POST', headers: { 'content-type': 'application/json', 'x-isola-assertion': `v1.${P}.${S}`, 'x-conversation-id': p.rid }, body: JSON.stringify({ kind: 'softphone_activation', reason: 'initial' }) });
  const j = await r.json().catch(() => ({})); const d = j.data || {};
  console.log('O6 mint: HTTP', r.status, '| code:', j.code, '| status:', j.status, '| data keys:', Object.keys(d).join(','), '| expires_in_min:', d.expires_in_min ?? '-');
  const url = d.url || d.activation_url || '';
  if (!url) { console.log('no link returned (reported as a finding, nothing worked around)'); return; }
  const u = new URL(url); console.log('link host:', u.host, '| path shape:', u.pathname.replace(/[A-Za-z0-9_-]{8,}/g, '<token>'), '| https:', u.protocol === 'https:');
  const g = await fetch(url, { redirect: 'manual', headers: { 'user-agent': 'Mozilla/5.0 (synthetic fixture check)' } }); const html = await g.text();
  console.log('O6 landing GET: HTTP', g.status, '| content-type:', g.headers.get('content-type'), '| bytes:', html.length, '| title:', (/<title>([^<]{0,80})/i.exec(html) || [])[1] || '-');
  console.log('landing structure (booleans): mentions Cloud Softphone:', /cloud softphone/i.test(html), '| has csc/cloudsoftphone deep link:', /csc:|cloudsoftphone:|acrobits/i.test(html), '| mentions Isola brand:', /isola/i.test(html), '| contains a SIP password-looking field:', /sip_?pass|password/i.test(html), '| redirect location host:', g.headers.get('location') ? new URL(g.headers.get('location'), url).host : '-');
})().catch((e) => { console.log('ERR', e.message); process.exit(2); });
