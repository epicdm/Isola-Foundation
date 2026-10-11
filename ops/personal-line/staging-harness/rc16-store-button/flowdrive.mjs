// rc16f: adds copy assertions, forged/expired/wrong-purpose token refusals, and the window-vs-dedup matrix (the customer's last relay-verified
// inbound is seeded in the STAGING DB as a synthetic audit row, because staging has no relay). Original header follows.
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

function mint(wa, rid = 'stg-rc16', o = {}) {
  const key = crypto.createHmac('sha256', Buffer.from(o.hmacKey ?? env.PL_ASSERTION_HMAC_KEY, 'utf8')).update('isola-pl-flow-token-v1').digest()
  const iat = o.iat ?? Math.floor(Date.now() / 1000)
  const P = Buffer.from(JSON.stringify({ v: 1, p: o.purpose ?? 'signup', wa, cw: rid, iat, exp: o.exp ?? iat + 3600, n: crypto.randomBytes(12).toString('base64url') })).toString('base64url')
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
const APPROVED = 'Make calls from the free Cloud Softphone app. This launch offer covers outgoing calling.'
const copyChecks = []
const chk = (k, ok) => { copyChecks.push([k, !!ok]); console.log(`COPY ${ok ? 'PASS' : 'FAIL'}: ${k}`) }
if (r.data?.offer_text) {
  console.log('  offer_text first line:', String(r.data.offer_text).split('\n')[0].replace(/\d{3}\) \d{3}-\d{4}/, 'NNN) NNN-NNNN'))
  const ot = String(r.data.offer_text)
  const holder = /^Your EPIC line/.test(ot)   // an existing line holder gets the line/status text, not the trial offer
  if (holder) chk('WELCOME (existing holder) says EPIC and never Isola; the offer sentence applies to the new-customer path only', /EPIC/.test(ot) && !/isola/i.test(ot))
  else chk('WELCOME offer_text contains the approved outgoing-calling sentence', ot.includes(APPROVED))
  chk('WELCOME offer_text has no "Incoming calls to your number" / "made and received" / Isola', !/Incoming calls to your number|made and received|isola/i.test(ot))
}
r = await flow(T1, 'data_exchange', 'WELCOME', { first_name: 'Stg' }); log('WELCOME', r)
if (r.data?.confirm_text) { console.log('  confirm_text:', String(r.data.confirm_text).replace(/\d{3}\) \d{3}-\d{4}/, 'NNN) NNN-NNNN')); chk('CONFIRM text never says Isola (new customer: says EPIC)', !/isola/i.test(r.data.confirm_text) && (/continue with your line/.test(r.data.confirm_text) || /EPIC/.test(r.data.confirm_text))) }
r = await flow(T1, 'data_exchange', 'CONFIRM', { confirm: 'yes' }); log('CONFIRM', r)
for (let i = 0; i < 10 && r.screen === 'PROVISIONING'; i++) { await sleep(3000); r = await flow(T1, 'data_exchange', 'PROVISIONING', {}); log(`PROVISIONING#${i + 1}`, r) }
if (r.screen === 'LINE_READY') { console.log('  line_text:', r.data?.line_text); chk('LINE_READY text says EPIC, never Isola', /EPIC/.test(r.data?.line_text) && !/isola/i.test(r.data?.line_text)) }
if (r.screen === 'ERROR') console.log('  error_text:', r.data?.error_text)
r = await flow(T1, 'data_exchange', 'LINE_READY', {}); log('LINE_READY->', r)
if (r.screen !== 'INSTALL') { console.log('NOT AT INSTALL - stopping (no store taps made)'); await db.end(); process.exit(3) }

// ---- window proof: staging has no relay, so the customer's last relay-verified inbound is a SYNTHETIC audit row in the STAGING DB
const idHash = (v) => crypto.createHmac('sha256', Buffer.from(env.PL_ASSERTION_HMAC_KEY, 'utf8')).update(`pl-audit\0${v}`, 'utf8').digest('hex').slice(0, 32)
const waHash = idHash(wa)
const SEED_KID = 'rc16f-seed'
async function inboundAt(hoursAgo) {   // null = no inbound on record
  await db.query(`delete from pl_concierge_audit where kid = $1 and wa_id_hash = $2`, [SEED_KID, waHash])
  if (hoursAgo === null) return
  await db.query(`insert into pl_concierge_audit (id, endpoint, op, http_status, code, kid, wa_id_hash, wa_last4, created_at) values ($1,'account/journey',null,200,'journey',$2,$3,$4, now() - ($5 || ' hours')::interval)`,
    [crypto.randomUUID(), SEED_KID, waHash, wa.slice(-4), String(hoursAgo)])
}
// does this sender hold any claim/sent store-button row in the last 24h (i.e. is the once-per-24h allowance spent)?
const claims = async (os) => (await db.query(`select count(*)::int n from pl_concierge_audit where endpoint='flows/store-button' and wa_last4=$1 and op=$2 and code in ('store_button_claimed','store_button_sent') and created_at > now() - interval '24 hours'`, [wa.slice(-4), os])).rows[0].n
const lastRefusal = async () => (await db.query(`select code from pl_concierge_audit where endpoint='flows/store-button' and wa_last4=$1 and code not in ('store_button_claimed','store_button_sent','store_button_failed') order by created_at desc limit 1`, [wa.slice(-4)])).rows[0]?.code ?? null

async function settle() {
  await sleep(1500)
  for (let i = 0; i < 40; i++) {
    const n = (await db.query(`select count(*)::int n from pl_concierge_audit where endpoint = 'flows/store-button' and wa_last4 = $1 and code = 'store_button_claimed' and created_at > now() - interval '5 minutes'`, [wa.slice(-4)])).rows[0].n
    if (n === 0) break
    await sleep(500)
  }
  await sleep(1000)
}
const pre = await db.query(`update pl_concierge_audit set created_at = now() - interval '25 hours' where endpoint = 'flows/store-button' and wa_last4 = $1 and created_at > now() - interval '24 hours' returning op`, [wa.slice(-4)])
console.log(`pre-run: aged ${pre.rowCount} earlier store-button row(s) of ${mask(wa)} out of the window`)
const runStart = new Date()
const results = []
async function tap(label, token, os, expectSends, expect = {}) {
  const before = (await sentTo(wa)).length
  const t = await flow(token, 'data_exchange', 'INSTALL', { step: 'store', os })
  await settle()
  const after = (await sentTo(wa)).length
  const row = { label, os, screen: t.screen, http: t.http, flow_ms: t.ms, store_url: t.data?.store_url, new_sends: after - before, expected: expectSends }
  row.refusal = expect.refusal !== undefined ? await lastRefusal() : undefined
  row.ok = (expect.screen ?? 'INSTALL_STORE') === t.screen && after - before === expectSends && (expect.refusal === undefined || row.refusal === expect.refusal)
  results.push(row); console.log(JSON.stringify(row))
}
const nowS = () => Math.floor(Date.now() / 1000)

console.log('=== A. proof refusals (no inbound seeded yet; window is not what is under test) ===')
await inboundAt(1)
await tap('A1 FORGED token (signed with another key)', mint(wa, 'stg-rc16', { hmacKey: 'z'.repeat(48) }), 'ios', 0, { screen: 'ERROR' })
await tap('A2 EXPIRED token (minted 2 h ago, 1 h ttl)', mint(wa, 'stg-rc16', { iat: nowS() - 7200 }), 'ios', 0, { screen: 'ERROR' })
await tap('A3 WRONG-PURPOSE token (topup)', mint(wa, 'stg-rc16', { purpose: 'topup' }), 'ios', 0, { screen: 'ERROR' })
await tap('A4 token for a DIFFERENT sender cannot send to this one (token wa = other synthetic number)', mint('17675550198'), 'ios', 0, { screen: 'INSTALL_STORE' })
results.at(-1).note = 'recipient is the token wa; this sender received nothing. (The other number holds no line, so no send was attempted for it either.)'

console.log('=== B. window / dedup matrix ===')
await inboundAt(null)
await tap('B1 window UNKNOWN (no inbound on record), no claim -> no send', mint(wa), 'ios', 0, { refusal: 'store_button_window_unknown' })
await inboundAt(25)
await tap('B2 window CLOSED (last inbound 25 h ago), no claim -> no send', mint(wa), 'ios', 0, { refusal: 'store_button_window_closed' })
console.log(`claims spent by refusals so far (ios): ${await claims('ios')} (must be 0)`)
await inboundAt(1)
const S1 = mint(wa)
await tap('B3 window OPEN + no claim -> exactly 1 (iPhone)', S1, 'ios', 1)
await tap('B4 same iPhone tap again (same Flow session) -> 0 (deduped)', S1, 'ios', 0, { refusal: 'store_button_deduped' })
const S2 = mint(wa)
await tap('B5 iPhone from a NEW Flow session, window open, claim active -> 0 (deduped)', S2, 'ios', 0, { refusal: 'store_button_deduped' })
await tap('B6 CONTROL first Android tap -> 1', S2, 'android', 1)
{
  const S3 = mint(wa)
  const before = (await sentTo(wa)).length
  const rs = await Promise.all([1, 2, 3].map(() => flow(S3, 'data_exchange', 'INSTALL', { step: 'store', os: 'android' })))
  await settle()
  const after = (await sentTo(wa)).length
  const row = { label: 'B7 three concurrent Android taps (claim active) -> 0 extra', os: 'android', screens: rs.map((x) => x.screen), flow_ms: rs.map((x) => x.ms), new_sends: after - before, expected: 0, ok: rs.every((x) => x.screen === 'INSTALL_STORE') && after === before }
  results.push(row); console.log(JSON.stringify(row))
}
// age THIS sender's iPhone claim rows past 24 h (dedup EXPIRED)
const upd = await db.query(`update pl_concierge_audit set created_at = now() - interval '25 hours' where endpoint = 'flows/store-button' and op = 'ios' and wa_last4 = $1 and created_at > now() - interval '1 hour' and code in ('store_button_claimed','store_button_sent') returning id`, [wa.slice(-4)])
console.log(`aged ${upd.rowCount} iPhone claim row(s) of ${mask(wa)} past the dedup window`)
await inboundAt(25)
await tap('B8 dedup EXPIRED but window CLOSED -> 0 (expiry is not eligibility)', mint(wa), 'ios', 0, { refusal: 'store_button_window_closed' })
console.log(`iPhone claims after that refusal: ${await claims('ios')} (must be 0 - the refusal did not burn the allowance)`)
await inboundAt(1)
await tap('B9 dedup expired AND window open -> 1', mint(wa), 'ios', 1)
await inboundAt(null)

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
console.log(`COPY CHECKS: ${copyChecks.filter(([, ok]) => ok).length}/${copyChecks.length}`)
console.log(`SUMMARY: ${results.filter((x) => x.ok).length}/${results.length} taps as expected; sends to this sender = ${mine.length} (expected 3: B3 iPhone, B6 Android, B9 iPhone)`)
await db.end()
