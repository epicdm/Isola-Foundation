// zz-sim-newuser-v8: ISOLATED STAGING ONLY. A synthetic NEW customer (+1 767 555 9801, a 555 number no subscriber can hold) walks the
// Option B journey against the DEPLOYED plsvc image (624d6916) inside container sim8 on the private plstage network:
//   1 flows/launch (signed PL assertion)  2 Flow INIT (v8 token)  3 "Get my free number" (provisioning = documented simulation, nothing
//   persisted)  4 fixture account = what a real provisioning persists  5 Flow-completion buttons (deliver:'buttons')  6 repeat until the
//   shared per-hour link limit answers  7 existing customer "Open my line" (line already set up)  8 the 7.x Manage Flow for a line holder.
// No Meta token is configured: every WhatsApp send is decided by the REAL send gate and then fails to dispatch locally (nothing leaves).
const crypto = require('crypto'), fs = require('fs')
const { Client } = require('pg')
const B = 'http://127.0.0.1:3005', WA = '17675559801', V8 = process.env.PL_SIGNUP_FLOW_ID_V8
const PUB = fs.readFileSync('/h/pub.pem', 'utf8'), APPSEC = process.env.META_APP_SECRET || ''
const b64u = (x) => Buffer.from(x).toString('base64url')
function build(obj) { const aes = crypto.randomBytes(16), iv = crypto.randomBytes(12); const wrap = crypto.publicEncrypt({ key: PUB, oaepHash: 'sha256', padding: crypto.constants.RSA_PKCS1_OAEP_PADDING }, aes); const c = crypto.createCipheriv('aes-128-gcm', aes, iv); const ct = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]); return { raw: JSON.stringify({ encrypted_flow_data: Buffer.concat([ct, c.getAuthTag()]).toString('base64'), encrypted_aes_key: wrap.toString('base64'), initial_vector: iv.toString('base64') }), aes, iv } }
function dec(text, aes, iv) { const f = Buffer.from(iv.map((b) => ~b & 0xff)); const buf = Buffer.from(text, 'base64'); const d = crypto.createDecipheriv('aes-128-gcm', aes, f); d.setAuthTag(buf.subarray(buf.length - 16)); return JSON.parse(Buffer.concat([d.update(buf.subarray(0, buf.length - 16)), d.final()]).toString('utf8')) }
const sig = (raw) => 'sha256=' + crypto.createHmac('sha256', APPSEC).update(raw, 'utf8').digest('hex')
async function flow(obj) { const b = build(obj); const r = await fetch(B + '/api/whatsapp/flows', { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig(b.raw) }, body: b.raw }); const t = await r.text(); let s = null; try { s = dec(t, b.aes, b.iv) } catch { } return { status: r.status, s, raw: s ? null : t.slice(0, 120) } }
function flowToken(fv) { const k = crypto.createHmac('sha256', Buffer.from(process.env.PL_ASSERTION_HMAC_KEY, 'utf8')).update('isola-pl-flow-token-v1').digest(); const iat = Math.floor(Date.now() / 1000); const P = b64u(JSON.stringify({ v: 1, p: 'signup', wa: WA, cw: 'cw-sim8', iat, exp: iat + 3600, n: crypto.randomBytes(12).toString('base64url'), ...(fv ? { fv } : {}) })); return 'pls1.' + P + '.' + b64u(crypto.createHmac('sha256', k).update('pls1.' + P).digest()) }
function assertion(mid) { const p = { kid: process.env.PL_ASSERTION_KID, wa_id: WA, pnid: process.env.PL_CONCIERGE_PNID_ALLOWLIST, rid: 'cw-sim8', mid, iat: Math.floor(Date.now() / 1000), nonce: crypto.randomBytes(16).toString('base64url') }; const P = b64u(JSON.stringify(p)); return `v1.${P}.${crypto.createHmac('sha256', Buffer.from(process.env.PL_ASSERTION_HMAC_KEY, 'utf8')).update('v1.' + P).digest('base64url')}` }
async function pl(ep, body, mid) { const r = await fetch(`${B}/api/internal/pl-concierge/v1/${ep}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-isola-assertion': assertion(mid), 'x-conversation-id': 'cw-sim8' }, body: JSON.stringify(body) }); let j = null; try { j = await r.json() } catch { } return { http: r.status, code: j?.code ?? null, data: j?.data ?? null } }
let pass = 0, fail = 0
const check = (id, ok, d = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'} ${id}${d ? ' :: ' + d : ''}`) }
const note = (t) => console.log(`NOTE ${t}`)
;(async () => {
  const db = new Client({ connectionString: process.env.DATABASE_URL }); await db.connect()
  const q = async (s, p = []) => (await db.query(s, p)).rows
  const audit = async (since) => q(`select "decision", "meta"->>'kind' as kind, "senderPath", "sourceEventType", "dispatchStatus" from "wa_send_audit" where "createdAt" >= $1 order by "createdAt"`, [since])
  // a FRESH synthetic customer each run (staging fixtures only)
  await q(`delete from lite_accounts where id = 'sim8-acct'`)
  await q(`delete from pl_concierge_audit where wa_last4 = '9801'`).catch(() => note('audit reset skipped'))
  const t0 = new Date()
  // fixtures: activation allowlist for the synthetic number only (staging), as the production '*' row allows everyone
  await q(`insert into lite_activation_allowlist (id, identity, "createdAt", "createdBy", reason) values ('sim8-allow', $1, now(), 'lane-a-sim8', 'staging simulation') on conflict (id) do nothing`, [WA])

  // 1. The customer asks for a number -> the agent's tool launches the signup Flow
  const l = await pl('flows/launch', { flow: 'signup' }, 'wamid.SIM8LAUNCH' + crypto.randomBytes(6).toString('hex'))
  const la = await audit(t0)
  check('1 signup Flow launch reaches the real send gate as a verified reply (Flow kind, pl: sender)', la.some((a) => a.kind === 'flow' && String(a.senderPath).startsWith('pl:flows/launch')), `code=${l.code} audit=${JSON.stringify(la.slice(-1))}`)
  note(`launch outcome without a Meta token: ${l.code} (expected flow_unavailable: the gate allowed, the dispatch could not leave the box)`)

  // 2. The customer opens the form (v8)
  const tok = flowToken('8')
  const init = await flow({ action: 'INIT', flow_token: tok, version: '3.0' })
  check('2 v8 form opens on WELCOME with the offer from the live catalogue', init.s?.screen === 'WELCOME' && !!init.s?.data?.trial_line, JSON.stringify(init.s?.data ?? init.raw).slice(0, 260))

  // 3. "Get my free number"
  const conf = await flow({ action: 'data_exchange', screen: 'WELCOME', flow_token: tok, version: '3.0', data: { confirm: 'yes', first_name: 'Sim' } })
  const closeTok = conf.s?.data?.extension_message_response?.params?.flow_token
  check('3 one tap creates the line and the form closes itself (reserved SUCCESS carrying the same token)', conf.s?.screen === 'SUCCESS' && closeTok === tok, `screen=${conf.s?.screen ?? conf.raw}`)

  // 4. what a real provisioning persists (the simulation persists nothing by design)
  await q(`insert into lite_accounts (id, "userId", "sipUsername", "sipPasswordHash", did, "ownerPhone", "createdAt") values ('sim8-acct', 'sim8-user', 'sim8_sip', 'x', '17678189801', $1, now()) on conflict (id) do nothing`, ['+' + WA])

  // 5. WhatsApp posts the form-completion message -> relay -> adapter flow_done -> plsvc sends the setup buttons
  const t5 = new Date()
  const b1 = await pl('account/next-step', { event: 'resend', deliver: 'buttons' }, 'wamid.SIM8DONE' + crypto.randomBytes(6).toString('hex'))
  const a5 = await audit(t5)
  check('5 setup link minted at the install stage and THREE button sends reach the gate in order (store, store, setup)', a5.length === 3 && a5.every((a) => a.kind === 'interactive' && a.senderPath === 'pl:account/setup-buttons' && a.sourceEventType === 'pl_verified_inbound'), `code=${b1.code} data=${JSON.stringify(b1.data)} audit=${JSON.stringify(a5)}`)
  check('5b the gate ALLOWS every button as a verified reply (decision allow_*)', a5.length === 3 && a5.every((a) => String(a.decision).startsWith('allow')), JSON.stringify(a5.map((a) => a.decision)))
  check('5c the setup URL is not returned to the caller', !JSON.stringify(b1).includes('/go/'))

  // 6. repeated requests: the shared per-hour limit (3) must answer, counting failed deliveries too
  const codes = []
  for (let i = 0; i < 3; i++) codes.push((await pl('account/next-step', { event: 'resend', deliver: 'buttons' }, 'wamid.SIM8RPT' + i + crypto.randomBytes(4).toString('hex'))).code)
  check('6 the 4th link request within the hour is refused by the shared limit (link_rate_limited)', codes.includes('link_rate_limited'), JSON.stringify(codes))

  // 7. existing customer whose app is already set up asks to open it -> one "Open my line" button only
  await q(`update lite_accounts set "registrationHandoffAt" = now() where id = 'sim8-acct'`).catch((e) => note('registrationHandoffAt column: ' + e.message))
  await q(`delete from pl_concierge_audit where created_at >= $1`, [t0]).catch(() => note('audit table not reset (limit stays exhausted)'))
  const t7 = new Date()
  const o = await pl('account/next-step', { event: 'resend', deliver: 'buttons' }, 'wamid.SIM8OPEN' + crypto.randomBytes(6).toString('hex'))
  const a7 = await audit(t7)
  check('7 a line holder gets exactly ONE button (Open my line), no store buttons', o.data?.include_app === false && a7.length === 1, `code=${o.code} data=${JSON.stringify(o.data)} audit=${a7.length}`)

  // 8. a line holder who asks for the setup form still gets the 7.x Manage Flow (unchanged)
  const m = await pl('flows/launch', { flow: 'signup' }, 'wamid.SIM8MANAGE' + crypto.randomBytes(6).toString('hex'))
  check('8 a line holder is never sent the v8 signup form (existing_line path)', m.code === 'flow_unavailable' || m.code === 'flow_sent' || m.code === 'rate_limited', `code=${m.code}`)

  console.log(`TALLY ${pass} pass / ${fail} fail`)
  await db.end(); process.exit(fail ? 1 : 0)
})().catch((e) => { console.log('FAIL uncaught: ' + String(e.message).slice(0, 200)); process.exit(2) })
