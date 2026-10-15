// Owner-authorized prep for the 9610 new-customer test (coordinator relay 2026-10-14): resolve the stale relay conversation 521 (DB id 599) (inbox 11, contact = 9610) so the owner's next message forms a FRESH conversation and a fresh Uplink conversation.
// Runs INSIDE the relay container with the relay's own bot token read in-process (never printed). Only conversation 521 (DB id 599) is touched; the id is hard-coded.
const fs = require('fs');
const base = process.env.CHATWOOT_BASE_URL, acct = process.env.CHATWOOT_ACCOUNT_ID, inbox = process.env.CHATWOOT_INBOX_ID;
const tok = fs.readFileSync(process.env.CHATWOOT_BOT_TOKEN_FILE, 'utf8').trim();
(async () => {
  console.log('config present:', Boolean(base && acct && tok), '| account', acct, '| inbox', inbox);
  const get = await fetch(`${base}/api/v1/accounts/${acct}/conversations/521`, { headers: { api_access_token: tok } });
  const g = await get.json().catch(() => ({}));
  console.log('GET 521 ->', get.status, '| status', g.status, '| inbox_id', g.inbox_id, '| contact has phone ending 9610:', String(g.meta?.sender?.phone_number || '').endsWith('9610'));
  if (get.status !== 200 || String(g.inbox_id) !== '11' || !String(g.meta?.sender?.phone_number || '').endsWith('9610')) { console.log('REFUSED: not the expected conversation; no write'); process.exit(3); }
  const r = await fetch(`${base}/api/v1/accounts/${acct}/conversations/521/toggle_status`, { method: 'POST', headers: { api_access_token: tok, 'content-type': 'application/json' }, body: JSON.stringify({ status: 'resolved' }) });
  console.log('toggle_status resolved ->', r.status, JSON.stringify(await r.json().catch(() => ({}))).slice(0, 160));
})().catch((e) => { console.log('ERR', e.message); process.exit(2); });
