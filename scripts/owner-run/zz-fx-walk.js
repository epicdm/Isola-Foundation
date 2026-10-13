// zz-fx-walk.js - runs INSIDE the production plsvc (docker exec -i -w /app <plsvc> node - with MODE=o4|o5|status). SYNTHETIC: signed, encrypted Flow requests for 555-exchange numbers (production secrets used in-process = SIMULATED PROTOCOL CONTROL,
// NOT Meta-originated and NOT a customer confirmation). Only the owner-authorized fixture 17675550911 (positive path) and 17675550912 (negative control) are accepted. Secrets are never printed.
const crypto = require('crypto'), fs = require('fs'), dotenv = require('dotenv');
const cur = dotenv.parse(fs.readFileSync('/app/.env.cur'));
const pem = Buffer.from(cur.FLOW_PRIVATE_KEY_B64 || '', 'base64').toString('utf8'), APPSEC = cur.META_APP_SECRET || '';
const pub = crypto.createPublicKey(crypto.createPrivateKey(pem));
const PLKEY = (process.env.PL_ASSERTION_HMAC_KEY || cur.PL_ASSERTION_HMAC_KEY || fs.readFileSync('/app/.plkey', 'utf8')).trim();
const MODE = process.env.MODE; const OK_PHONES = new Set(['17675550911', '17675550912']); const PHONE = process.env.PHONE;
if (!OK_PHONES.has(PHONE)) { console.log('REFUSED: only the authorized fixture numbers are accepted'); process.exit(3); }
const b64u = (x) => Buffer.from(x).toString('base64url'), sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function token(wa) { const k = crypto.createHmac('sha256', Buffer.from(PLKEY, 'utf8')).update('isola-pl-flow-token-v1').digest(); const iat = Math.floor(Date.now() / 1000); const P = b64u(JSON.stringify({ v: 1, p: 'signup', wa, cw: 'fixture-' + crypto.randomBytes(4).toString('hex'), iat, exp: iat + 3600, n: crypto.randomBytes(12).toString('base64url') })); return 'pls1.' + P + '.' + b64u(crypto.createHmac('sha256', k).update('pls1.' + P).digest()); }
function build(obj) { const aes = crypto.randomBytes(16), iv = crypto.randomBytes(12); const wrap = crypto.publicEncrypt({ key: pub, oaepHash: 'sha256', padding: crypto.constants.RSA_PKCS1_OAEP_PADDING }, aes); const c = crypto.createCipheriv('aes-128-gcm', aes, iv); const ct = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]); return { raw: JSON.stringify({ encrypted_flow_data: Buffer.concat([ct, c.getAuthTag()]).toString('base64'), encrypted_aes_key: wrap.toString('base64'), initial_vector: iv.toString('base64') }), aes, iv }; }
function dec(text, aes, iv) { const f = Buffer.from(iv.map((b) => ~b & 0xff)); const buf = Buffer.from(text, 'base64'); const d = crypto.createDecipheriv('aes-128-gcm', aes, f); d.setAuthTag(buf.subarray(buf.length - 16)); return JSON.parse(Buffer.concat([d.update(buf.subarray(0, buf.length - 16)), d.final()]).toString('utf8')); }
async function flow(obj, label) { const b = build(obj); const r = await fetch('http://127.0.0.1:3005/api/whatsapp/flows', { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=' + crypto.createHmac('sha256', APPSEC).update(b.raw, 'utf8').digest('hex') }, body: b.raw }); const t = await r.text(); let s = null; try { s = dec(t, b.aes, b.iv); } catch { } const out = { label, http: r.status, screen: s && s.screen, text: s ? JSON.stringify(s.data || {}).replace(/\d{4,}/g, (m) => '***' + m.slice(-4)).slice(0, 140) : t.slice(0, 60) }; console.log(JSON.stringify(out)); return out; }
(async () => {
  const tk = token(PHONE);
  if (MODE === 'o4') { await flow({ version: '3.0', action: 'data_exchange', screen: 'CONFIRM', flow_token: tk, data: { confirm: 'yes' } }, 'O4 CONFIRM (non-allowlisted synthetic number)'); return; }
  if (MODE === 'o5') {
    await flow({ version: '3.0', action: 'INIT', flow_token: tk }, 'O5 INIT');
    await flow({ version: '3.0', action: 'data_exchange', screen: 'WELCOME', flow_token: tk, data: { first_name: 'Synthetic' } }, 'O5 WELCOME');
    const [a, b] = await Promise.all([
      flow({ version: '3.0', action: 'data_exchange', screen: 'CONFIRM', flow_token: tk, data: { confirm: 'yes' } }, 'O5 CONFIRM #1 (concurrent)'),
      flow({ version: '3.0', action: 'data_exchange', screen: 'CONFIRM', flow_token: tk, data: { confirm: 'yes' } }, 'O5 CONFIRM #2 (concurrent)'),
    ]);
    await sleep(12000);
    await flow({ version: '3.0', action: 'data_exchange', screen: 'CONFIRM', flow_token: tk, data: { confirm: 'yes' } }, 'O5 CONFIRM #3 (sequential, after)');
    await flow({ version: '3.0', action: 'data_exchange', screen: 'PROVISIONING', flow_token: tk, data: {} }, 'O5 PROVISIONING poll');
  }
})().catch((e) => { console.log('ERR', e.message); process.exit(2); });
