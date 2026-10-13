// zz-pause-prod-probe.js - runs INSIDE the production plsvc (docker exec -i <plsvc> sh -c 'cd /app && node -' with PHONE=<digits>). SYNTHETIC: one validly signed, encrypted legacy-Flow WELCOME for a 555-exchange number that no real subscriber can hold,
// signed with the production app secret IN-PROCESS (SIMULATED PROTOCOL CONTROL: not Meta-originated, not a customer confirmation). Admission is closed, so the request can only be queued; the test reads what the gate decided from the audit log.
const crypto = require('crypto'), fs = require('fs'), dotenv = require('dotenv');
const cur = dotenv.parse(fs.readFileSync('/app/.env.cur'));
const pem = Buffer.from(cur.FLOW_PRIVATE_KEY_B64 || '', 'base64').toString('utf8'), SECRET = cur.META_APP_SECRET || '';
const pub = crypto.createPublicKey(crypto.createPrivateKey(pem));
const PHONE = process.env.PHONE;
if (!/^1767555\d{4}$/.test(PHONE || '')) { console.log('REFUSED: PHONE must be a 1767555xxxx synthetic number'); process.exit(3); }
function build(obj) { const aes = crypto.randomBytes(16), iv = crypto.randomBytes(12); const wrap = crypto.publicEncrypt({ key: pub, oaepHash: 'sha256', padding: crypto.constants.RSA_PKCS1_OAEP_PADDING }, aes); const c = crypto.createCipheriv('aes-128-gcm', aes, iv); const ct = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]); return { raw: JSON.stringify({ encrypted_flow_data: Buffer.concat([ct, c.getAuthTag()]).toString('base64'), encrypted_aes_key: wrap.toString('base64'), initial_vector: iv.toString('base64') }), aes, iv }; }
function dec(text, aes, iv) { const f = Buffer.from(iv.map((b) => ~b & 0xff)); const buf = Buffer.from(text, 'base64'); const d = crypto.createDecipheriv('aes-128-gcm', aes, f); d.setAuthTag(buf.subarray(buf.length - 16)); return JSON.parse(Buffer.concat([d.update(buf.subarray(0, buf.length - 16)), d.final()]).toString('utf8')); }
(async () => {
  const b = build({ action: 'data_exchange', screen: 'WELCOME', flow_token: '+' + PHONE, version: '3.0', data: { first_name: 'Synthetic' } });
  const r = await fetch('http://127.0.0.1:3005/api/whatsapp/flows', { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=' + crypto.createHmac('sha256', SECRET).update(b.raw, 'utf8').digest('hex') }, body: b.raw });
  const t = await r.text(); let s = null; try { s = dec(t, b.aes, b.iv); } catch { }
  console.log('SYNTHETIC request for ***' + PHONE.slice(-4) + ': HTTP', r.status, '| screen', s && s.screen, '|', s ? JSON.stringify(s.data || {}).slice(0, 100) : t.slice(0, 60));
})().catch((e) => { console.log('ERROR', e.message); process.exit(2); });
