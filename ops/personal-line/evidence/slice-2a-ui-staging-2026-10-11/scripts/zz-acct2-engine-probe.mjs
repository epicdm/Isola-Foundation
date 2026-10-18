// zz-acct2 engine reference probe. Runs INSIDE the plstg_zzacct2_web container (loopback, so the engine's own source gate admits it).
// It calls the EXISTING concierge endpoints (account/line-status, account/balance, account/journey) with a freshly minted assertion,
// and the signed account/summary read, then prints the non-secret readings. Keys are read in-process for signing ONLY and never printed.
import { createHmac, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

const cfgText = readFileSync('/app/.env', 'utf8');
const envGet = (name) => {
  for (const line of cfgText.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m && m[1] === name) return m[2].trim().replace(/^["']|["']$/g, '');
  }
  return process.env[name] ?? '';
};
const kid = envGet('PL_ASSERTION_KID');
const akey = envGet('PL_ASSERTION_HMAC_KEY');
const pnid = envGet('PL_CONCIERGE_PNID_ALLOWLIST').split(',')[0].trim();
const skey = (await new Promise((r) => { let b = ''; process.stdin.on('data', (c) => { b += c; }); process.stdin.on('end', () => r(b.trim())); }));
if (!kid || akey.length < 32 || !pnid || skey.length < 32) { console.log(JSON.stringify({ abort: 'config_missing', kid: !!kid, akey: akey.length >= 32, pnid: !!pnid, skey: skey.length >= 32 })); process.exit(2); }

const b64u = (b) => Buffer.from(b).toString('base64url');
const mint = (wa) => {
  const rid = 'zzacct2-' + randomBytes(6).toString('hex');
  const payload = { kid, wa_id: wa, pnid, rid, mid: 'zzacct2-' + randomBytes(4).toString('hex'), iat: Math.floor(Date.now() / 1000), nonce: b64u(randomBytes(16)) };
  const p = b64u(JSON.stringify(payload));
  const sig = createHmac('sha256', Buffer.from(akey, 'utf8')).update('v1.' + p, 'utf8').digest('base64url');
  return { rid, header: `v1.${p}.${sig}` };
};
const base = 'http://127.0.0.1:3005/api/internal/pl-concierge/v1';
const post = async (ep, wa) => {
  const a = mint(wa);
  const r = await fetch(`${base}/${ep}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-isola-assertion': a.header, 'x-conversation-id': a.rid }, body: '{}' });
  let j = null; try { j = await r.json(); } catch {}
  return { http: r.status, body: j };
};
const sign = (ts, account) => createHmac('sha256', Buffer.from(skey, 'utf8')).update(`pl-sf-summary-v1.${ts}.${account}`, 'utf8').digest('base64url');
const summary = async (account) => {
  const ts = Math.floor(Date.now() / 1000);
  const r = await fetch(`${base}/account/summary?account=${account}`, { headers: { 'x-pl-sf-kid': envGet('PL_SF_SUMMARY_KID') || 'sf1', 'x-pl-sf-ts': String(ts), 'x-pl-sf-sig': sign(ts, account) } });
  let j = null; try { j = await r.json(); } catch {}
  return { http: r.status, body: j };
};

const targets = JSON.parse(process.argv[2]);   // [{name, wa, account}]
const out = {};
for (const t of targets) {
  const [ls, bal, jr, sm] = [await post('account/line-status', t.wa), await post('account/balance', t.wa), await post('account/journey', t.wa), await summary(t.account)];
  const d = (x) => x.body?.data ?? null;
  out[t.name] = {
    engine_line_status: { http: ls.http, code: ls.body?.code, registration: d(ls)?.registration, listener_connected: d(ls)?.listener_connected, plan: d(ls)?.plan, plan_expires_at: d(ls)?.plan_expires_at, did_pretty: d(ls)?.did_pretty },
    engine_balance: { http: bal.http, code: bal.body?.code, known: d(bal)?.known, kind: d(bal)?.kind, plan: d(bal)?.plan, minutes_included: d(bal)?.minutes_included, minutes_remaining: d(bal)?.minutes_remaining, wallet_xcd: d(bal)?.wallet_xcd, expires_at: d(bal)?.expires_at },
    engine_journey: { http: jr.http, state: d(jr)?.state, registration: d(jr)?.facts?.registration, minutes_remaining: d(jr)?.facts?.minutes_remaining, wallet_xcd: d(jr)?.facts?.wallet_xcd },
    signed_summary: { http: sm.http, code: sm.body?.code, data: d(sm) },
  };
}
console.log(JSON.stringify(out, null, 1));
