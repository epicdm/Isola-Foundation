// host03 STAGING ONLY one-shot harness: drives the REAL signup-Flow endpoint of plstg_web (http://web:3005/api/whatsapp/flows) the way
// Meta does - encrypted data_exchange requests with a SERVER-signed flow_token - for a SYNTHETIC sender, and reads the store-button
// sends that reached the graph.facebook.com stand-in (metamock). Secrets are read in-process from the mounted staging env and never printed.
// Phones are printed masked (last 4).
import crypto from 'node:crypto'
import { readFileSync } from 'node:fs'
import pg from 'pg'

const env = {}
for (const raw of readFileSync('/run/secrets/plenv', 'utf8').split(/\r?\n/)) {
  const l = raw.trim(); if (!l || l.startsWith('#') || !l.includes('=')) continue
  const i = l.indexOf('='); env[l.slice(0, i).replace(/^export\s+/, '').trim()] = l.slice(i + 1).trim().replace(/^['"]|['"]$/g, '')
}
const PUB = readFileSync('/app/zzh/flowkey/flow_public.pem', 'utf8')
const WEB = 'http://web-rc16:3005/api/whatsapp/flows'
const MOCK = 'http://metamock:9001'
const mask = (p) => `***${String(p).slice(-4)}`

function mint(wa, rid = 'stg-rc16') {
  const key = crypto.createHmac('sha256', Buffer.from(env.PL_ASSERTION_HMAC_KEY, 'utf8')).update('isola-pl-flow-token-v1').digest()
  const iat = Math.floor(Date.now() / 1000)
  const P = Buffer.from(JSON.stringify({ v: 1, p: 'signup', wa, cw: rid, iat, exp: iat + 3600, n: crypto.randomBytes(12).toString('base64url') })).toString('base64url')
  return `pls1.${P}.${crypto.createHmac('sha256', key).update('pls1.' + P).digest().toString('base64url')}`
}
async function flow(token, action, screen, data) {
  const aes = crypto.randomBytes(16), iv = crypto.randomBytes(16)
  const c = crypto.createCipheriv('aes-128-gcm', aes, iv)
  const enc = Buffer.concat([c.update(JSON.stringify({ version: '3.0', action, screen, data, flow_token: token })), c.final(), c.getAuthTag()])
  const body = JSON.stringify({ encrypted_flow_data: enc.toString('base64'), encrypted_aes_key: crypto.publicEncrypt({ key: PUB, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, aes).toString('base64'), initial_vector: iv.toString('base64') })
  const t0 = Date.now()
  const r = await fetch(WEB, { method: 'POST', headers: { 'content-type': 'application/json' }, body })
  const ms = Date.now() - t0
  const txt = await r.text()
  if (r.status !== 200) return { http: r.status, ms, raw: txt.slice(0, 120) }
  const buf = Buffer.from(txt, 'base64'); const fiv = Buffer.from(iv.map((b) => ~b & 0xff))
  const d = crypto.createDecipheriv('aes-128-gcm', aes, fiv); d.setAuthTag(buf.subarray(-16))
  const out = JSON.parse(Buffer.concat([d.update(buf.subarray(0, -16)), d.final()]).toString('utf8'))
  return { http: 200, ms, screen: out.screen, data: out.data }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const sentTo = async (wa) => { const j = await (await fetch(`${MOCK}/__sent`)).json(); return j.sent.filter((s) => s.to === wa) }
const short = (r) => `${r.http} ${r.screen ?? r.raw} ${r.ms}ms`

const db = new pg.Client({ connectionString: env.DATABASE_URL }); await db.connect()
const dbname = (await db.query('select current_database() d')).rows[0].d
if (dbname !== 'plstg') { console.log('REFUSING: not the staging database'); process.exit(2) }

// a fresh SYNTHETIC sender (NANP fictional 555-01xx block) that holds no line yet
let wa = ''
const USE = process.env.USE_WA || ''
if (USE) {
  // an EXISTING synthetic line (555-01xx block) created by this harness's earlier run; it must be the sole holder and still at install
  if (!/^176755501\d\d$/.test(USE)) { console.log('USE_WA must be a synthetic 176755501xx number'); process.exit(2) }
  const rows = (await db.query(`select "installSelfReportedAt" is null as no_install, "registrationHandoffAt" is null as no_handoff from lite_accounts where "ownerPhone" like '%'||$1`, [USE])).rows
  console.log(`existing synthetic line ${mask(USE)}: holders=${rows.length} ${JSON.stringify(rows)}`)
  if (rows.length !== 1) process.exit(2)
  wa = USE
} else {
  for (let i = 0; i < 50 && !wa; i++) {
    const cand = `176755501${String(10 + Math.floor(Math.random() * 90))}`
    const n = (await db.query(`select count(*)::int n from lite_accounts where "ownerPhone" like '%'||$1 or "userId" = $1`, [cand])).rows[0].n
    if (n === 0) wa = cand
  }
  console.log(`synthetic sender ${mask(wa)} (fresh, no line)`)
}
const T1 = mint(wa)
const steps = []
const log = (k, r) => { steps.push([k, short(r)]); console.log(`${k}: ${short(r)}`) }
let r = await flow(T1, 'INIT', undefined, undefined); log('INIT', r)
if (r.data?.offer_text) console.log('  offer_text first line:', String(r.data.offer_text).split('\n')[0].replace(/\d{3}\) \d{3}-\d{4}/, 'NNN) NNN-NNNN'))
r = await flow(T1, 'data_exchange', 'WELCOME', { first_name: 'Stg' }); log('WELCOME', r)
if (r.data?.confirm_text) console.log('  confirm_text:', String(r.data.confirm_text).replace(/\d{3}\) \d{3}-\d{4}/, 'NNN) NNN-NNNN'))
r = await flow(T1, 'data_exchange', 'CONFIRM', { confirm: 'yes' }); log('CONFIRM', r)
for (let i = 0; i < 10 && r.screen === 'PROVISIONING'; i++) { await sleep(3000); r = await flow(T1, 'data_exchange', 'PROVISIONING', {}); log(`PROVISIONING#${i + 1}`, r) }
if (r.screen === 'LINE_READY') console.log('  line_text:', r.data?.line_text)
if (r.screen === 'ERROR') console.log('  error_text:', r.data?.error_text)
r = await flow(T1, 'data_exchange', 'LINE_READY', {}); log('LINE_READY->', r)
if (r.screen !== 'INSTALL') { console.log('NOT AT INSTALL - stopping (no store taps made)'); await db.end(); process.exit(3) }

// rc16 run 2 measured a first send landing 4.1 s after its tap - after a fixed 2.5 s wait - so per-tap attribution moved one row.
// The instrument now waits for the claim to finish (no 'store_button_claimed' row in flight for this sender) before counting.
async function settle() {
  await sleep(1500)
  for (let i = 0; i < 40; i++) {
    const n = (await db.query(`select count(*)::int n from pl_concierge_audit where endpoint = 'flows/store-button' and wa_last4 = $1 and code = 'store_button_claimed' and created_at > now() - interval '5 minutes'`, [wa.slice(-4)])).rows[0].n
    if (n === 0) break
    await sleep(500)
  }
  await sleep(1000)
}
// start from a clean window for this synthetic sender: age any earlier store-button rows past 24 h (staging DB, synthetic rows only)
const pre = await db.query(`update pl_concierge_audit set created_at = now() - interval '25 hours' where endpoint = 'flows/store-button' and wa_last4 = $1 and created_at > now() - interval '24 hours' returning op`, [wa.slice(-4)])
console.log(`pre-run: aged ${pre.rowCount} earlier store-button row(s) of ${mask(wa)} out of the window`)
const runStart = new Date()
const results = []
async function tap(label, token, os, expectSends) {
  const before = (await sentTo(wa)).length
  const t = await flow(token, 'data_exchange', 'INSTALL', { step: 'store', os })
  await settle()                                      // the send is fire-and-forget; wait until no claim is in flight, then 1 s
  const after = (await sentTo(wa)).length
  const row = { label, os, screen: t.screen, http: t.http, flow_ms: t.ms, store_url: t.data?.store_url, new_sends: after - before, expected: expectSends, ok: t.screen === 'INSTALL_STORE' && after - before === expectSends }
  results.push(row); console.log(JSON.stringify(row))
}
await tap('T1 first iPhone tap', T1, 'ios', 1)
await tap('T2 same iPhone tap again (same Flow session)', T1, 'ios', 0)
const T2 = mint(wa)
await tap('T3 iPhone tap from a NEW Flow session (new token)', T2, 'ios', 0)
await tap('T4 CONTROL first Android tap', T2, 'android', 1)
// Meta endpoint retries / double taps arriving together
{
  const T3 = mint(wa)
  const before = (await sentTo(wa)).length
  const rs = await Promise.all([1, 2, 3].map(() => flow(T3, 'data_exchange', 'INSTALL', { step: 'store', os: 'android' })))
  await settle()
  const after = (await sentTo(wa)).length
  const row = { label: 'T5 three concurrent Android taps', os: 'android', screens: rs.map((x) => x.screen), flow_ms: rs.map((x) => x.ms), new_sends: after - before, expected: 0, ok: rs.every((x) => x.screen === 'INSTALL_STORE') && after === before }
  results.push(row); console.log(JSON.stringify(row))
}
// window control: age THIS synthetic sender's iPhone claim rows past 24 h (staging DB, synthetic rows only), then tap again
const upd = await db.query(`update pl_concierge_audit set created_at = now() - interval '25 hours' where endpoint = 'flows/store-button' and op = 'ios' and wa_last4 = $1 and created_at > now() - interval '1 hour' returning id`, [wa.slice(-4)])
console.log(`aged ${upd.rowCount} iPhone claim row(s) of ${mask(wa)} past the window`)
await tap('T6 CONTROL iPhone tap after the 24 h window', mint(wa), 'ios', 1)

const mine = (await sentTo(wa)).filter((s) => new Date(s.t) >= runStart)
console.log('--- sends that reached the graph.facebook.com stand-in for this sender:')
for (const s of mine) {
  const i = s.body?.interactive
  console.log(JSON.stringify({ t: s.t, version: s.version, from_phone_id_last4: s.from_phone_id.slice(-4), auth_header: s.auth, to: mask(s.to), type: s.body?.type, interactive_type: i?.type, header: i?.header, footer: i?.footer, action: i?.action, display_text_len: i?.action?.parameters?.display_text?.length, body_has_isola: /isola/i.test(JSON.stringify(s.body)), body: i?.body?.text }))
}
const audit = await db.query(`select op, code, outcome, detail, latency_ms, created_at from pl_concierge_audit where endpoint = 'flows/store-button' and wa_last4 = $1 and coalesce(updated_at, created_at) >= $2 order by coalesce(updated_at, created_at)`, [wa.slice(-4), runStart])
console.log('--- pl_concierge_audit flows/store-button rows (this sender):'); for (const a of audit.rows) console.log(JSON.stringify(a))
const ws = await db.query(`select decision, "dispatchStatus", "senderPath", purpose, "sourceEventType", "metaMessageId" is not null as has_wamid, left("errorSummary", 120) as err, "createdAt" from wa_send_audit where "senderPath" = 'pl:flows/store-button' and phone = $1 and "createdAt" >= $2 order by "createdAt"`, [wa, runStart])
console.log('--- wa_send_audit rows (gate decisions) for this sender:'); for (const a of ws.rows) console.log(JSON.stringify(a))
console.log(`SUMMARY: ${results.filter((x) => x.ok).length}/${results.length} taps as expected; sends to this sender = ${mine.length} (expected 3: iPhone, Android, iPhone-after-window)`)
await db.end()
