// zz-acct2: send SIGNED pl.* events to the staging app's ONE ingress (as plsvc would). Runs INSIDE uplinkstg_zzacct2_app.
// stdin = the staging events key (never printed). argv[2] = org id, argv[3] = JSON array of {type, version, pl_account_id, wa_id, facts}.
import { createHmac, randomUUID } from 'node:crypto';
const key = await new Promise((r) => { let b = ''; process.stdin.on('data', (c) => { b += c; }); process.stdin.on('end', () => r(b.trim())); });
if (key.length < 32) { console.log('abort: key'); process.exit(2); }
const org = process.argv[2];
const evs = JSON.parse(process.argv[3]);
for (const e of evs) {
  const body = JSON.stringify({ event_id: e.event_id || randomUUID(), type: e.type, occurred_at: new Date().toISOString(), version: e.version, pl_account_id: e.pl_account_id, wa_id: e.wa_id, facts: e.facts || {} });
  const ts = Math.floor(Date.now() / 1000);
  const sig = createHmac('sha256', Buffer.from(key, 'utf8')).update(`${ts}.${body}`, 'utf8').digest('base64url');
  const r = await fetch(`http://127.0.0.1:3000/api/webhooks/personal-line/${org}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-pl-sf-kid': 'ev1', 'x-pl-sf-ts': String(ts), 'x-pl-sf-sig': sig }, body });
  console.log(e.type, e.pl_account_id.slice(-6), 'wa...' + e.wa_id.slice(-4), '->', r.status, (await r.text()).slice(0, 160));
}
