// zz-doors-harness.js - ISOLATED STAGING ONLY (never production). Runs INSIDE a staging plsvc container built from the admission candidate image. ALL REQUESTS ARE SYNTHETIC: encrypted to a TEST RSA key and signed with a TEST app secret,
// signed with TEST internal/assertion keys, for 555-exchange phone numbers that no real subscriber can hold. Provisioning is the app's documented SIMULATION boundary (PREVIEW_SIMULATE_PROVISIONING): nothing reaches Magnus or a customer.
// One door per invocation (DOOR=1..5) so the caller can count the simulation log line per door.
//  1 legacy Flow WELCOME (data_exchange, bare-phone token)         2 PL signup Flow v7.1 CONFIRM (signed pls1 token)         3 POST /api/lite/provision (internal-secret door)
//  4 POST /api/internal/personal-line/operator-provision            5 POST /api/internal/pl-concierge/v1/lines/provision (signed PL assertion)
const crypto = require('crypto'), fs = require('fs');
const { Client } = require('pg');
const DOOR = Number(process.env.DOOR), PHONE = process.env.PHONE;   // digits, 1767555xxxx
const B = 'http://127.0.0.1:3005';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PUB = fs.readFileSync('/h/pub.pem', 'utf8'), APPSEC = process.env.META_APP_SECRET || '';
function build(obj) { const aes = crypto.randomBytes(16), iv = crypto.randomBytes(12); const wrap = crypto.publicEncrypt({ key: PUB, oaepHash: 'sha256', padding: crypto.constants.RSA_PKCS1_OAEP_PADDING }, aes); const c = crypto.createCipheriv('aes-128-gcm', aes, iv); const ct = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]); return { raw: JSON.stringify({ encrypted_flow_data: Buffer.concat([ct, c.getAuthTag()]).toString('base64'), encrypted_aes_key: wrap.toString('base64'), initial_vector: iv.toString('base64') }), aes, iv }; }
function dec(text, aes, iv) { const f = Buffer.from(iv.map((b) => ~b & 0xff)); const buf = Buffer.from(text, 'base64'); const d = crypto.createDecipheriv('aes-128-gcm', aes, f); d.setAuthTag(buf.subarray(buf.length - 16)); return JSON.parse(Buffer.concat([d.update(buf.subarray(0, buf.length - 16)), d.final()]).toString('utf8')); }
const sig = (raw) => 'sha256=' + crypto.createHmac('sha256', APPSEC).update(raw, 'utf8').digest('hex');
async function flow(obj) { const b = build(obj); const r = await fetch(B + '/api/whatsapp/flows', { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig(b.raw) }, body: b.raw }); const t = await r.text(); let s = null; try { s = dec(t, b.aes, b.iv); } catch { } return { status: r.status, screen: s?.screen, text: s ? JSON.stringify(s.data || {}).slice(0, 110) : t.slice(0, 80) }; }
const b64u = (x) => Buffer.from(x).toString('base64url');
function flowToken(wa) { const k = crypto.createHmac('sha256', Buffer.from(process.env.PL_ASSERTION_HMAC_KEY, 'utf8')).update('isola-pl-flow-token-v1').digest(); const iat = Math.floor(Date.now() / 1000); const P = b64u(JSON.stringify({ v: 1, p: 'signup', wa, cw: 'door2-' + crypto.randomBytes(4).toString('hex'), iat, exp: iat + 3600, n: crypto.randomBytes(12).toString('base64url') })); return 'pls1.' + P + '.' + b64u(crypto.createHmac('sha256', k).update('pls1.' + P).digest()); }
function assertion(wa) { const rid = 'cw-door5-' + crypto.randomBytes(4).toString('hex'); const p = { kid: process.env.PL_ASSERTION_KID, wa_id: wa, pnid: process.env.PL_CONCIERGE_PNID_ALLOWLIST, act: 'pl.confirm_signup', act_src: 'button', rid, mid: 'wamid.DOOR5' + crypto.randomBytes(8).toString('hex'), iat: Math.floor(Date.now() / 1000), nonce: crypto.randomBytes(16).toString('base64url') }; const P = b64u(JSON.stringify(p)); return { h: `v1.${P}.${crypto.createHmac('sha256', Buffer.from(process.env.PL_ASSERTION_HMAC_KEY, 'utf8')).update('v1.' + P).digest('base64url')}`, rid }; }
const j = async (r) => { const t = await r.text(); let o = null; try { o = JSON.parse(t); } catch { } return { status: r.status, body: o, text: t.slice(0, 120) }; };
(async () => {
  const db = new Client({ connectionString: process.env.DATABASE_URL }); await db.connect();
  const cnt = async (t) => Number((await db.query(`select count(*)::int n from ${t}`)).rows[0].n);
  const before = { acc: await cnt('lite_accounts'), att: await cnt('lite_provision_attempts'), q: await cnt('lite_admission_queue') };
  let res;
  if (DOOR === 1) res = await flow({ action: 'data_exchange', screen: 'WELCOME', flow_token: '+' + PHONE, version: '3.0', data: { first_name: 'Synthetic' } });
  if (DOOR === 2) res = await flow({ action: 'data_exchange', screen: 'CONFIRM', flow_token: flowToken(PHONE), version: '3.0', data: { confirm: 'yes' } });
  if (DOOR === 3) res = await j(await fetch(B + '/api/lite/provision', { method: 'POST', headers: { 'content-type': 'application/json', 'x-internal-secret': process.env.INTERNAL_SECRET }, body: JSON.stringify({ userId: 'synthetic-door3-' + PHONE, ownerPhone: '+' + PHONE, verificationRef: 'synthetic-verification-' + PHONE }) }));
  if (DOOR === 4) res = await j(await fetch(B + '/api/internal/personal-line/operator-provision', { method: 'POST', headers: { 'content-type': 'application/json', 'x-internal-secret': process.env.INTERNAL_SECRET }, body: JSON.stringify({ targetPhone: '+' + PHONE, verification: { type: 'owner_override', reference: 'synthetic-override-' + PHONE }, overrideJustification: 'synthetic staging test of the admission gate', operatorReason: 'synthetic staging test', actor: 'synthetic-harness', idempotencyKey: 'synthetic-door4-' + PHONE + '-' + crypto.randomBytes(3).toString('hex') }) }));
  if (DOOR === 5) { const a = assertion(PHONE); res = await j(await fetch(B + '/api/internal/pl-concierge/v1/lines/provision', { method: 'POST', headers: { 'content-type': 'application/json', 'x-isola-assertion': a.h, 'x-conversation-id': a.rid }, body: '{}' })); }
  await sleep(2500);
  const after = { acc: await cnt('lite_accounts'), att: await cnt('lite_provision_attempts'), q: await cnt('lite_admission_queue') };
  const lg = (await db.query("select decision || ':' || reason || ':' || door || coalesce(':paused=' || (detail->>'paused'), '') as r from lite_admission_log where sender_phone = $1 order by created_at", [PHONE])).rows.map((x) => x.r);
  console.log(JSON.stringify({ door: DOOR, response: { status: res?.status, screen: res?.screen, code: res?.body?.code ?? res?.body?.error ?? res?.body?.admission ?? null, msg: (res?.text || '').slice(0, 90) }, accounts_delta: after.acc - before.acc, attempts_delta: after.att - before.att, queue_delta: after.q - before.q, admission_log: lg }));
  await db.end();
})().catch((e) => { console.log(JSON.stringify({ door: DOOR, error: String(e.message).slice(0, 160) })); process.exit(2); });
