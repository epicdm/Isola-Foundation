// rc16g host03 STAGING ONLY one-shot harness: the store button routed through the PL adapter (/v1/eligibility).
// Drives the REAL signup-Flow endpoint of plstg_zzrc16g_web the way Meta does (encrypted data_exchange, SERVER-signed flow_token) for a
// SYNTHETIC sender, with a REAL adapter (rc13h file) in front of a STATEFUL mock Chatwoot (cwmock) that the harness uses to set
// ownership / last inbound / failures, and reads what reached the graph.facebook.com stand-in (metamock). The adapter STOP is created
// through the adapter's own /v1/action route (signed relay context + bearer, a real STOP message in the mock), never by SQL.
// Secrets are read in-process from mounted files and never printed. Phones are printed masked (last 4).
import crypto from 'node:crypto'
import { readFileSync } from 'node:fs'
import pg from 'pg'

const env = {}
for (const raw of readFileSync('/run/secrets/plenv', 'utf8').split(/\r?\n/)) {
  const l = raw.trim(); if (!l || l.startsWith('#') || !l.includes('=')) continue
  const i = l.indexOf('='); env[l.slice(0, i).replace(/^export\s+/, '').trim()] = l.slice(i + 1).trim().replace(/^['"]|['"]$/g, '')
}
const rd = (p) => readFileSync(p, 'utf8').replace(/\r?\n$/, '')
const PLKEY = rd('/run/secrets/plkey'), CTXKEY = rd('/run/secrets/ctxkey'), BEARER = rd('/run/secrets/bearer')
const PUB = readFileSync('/app/zzh/flowkey/flow_public.pem', 'utf8')
const WEB = 'http://web-rc16g:3005/api/whatsapp/flows', MOCK = 'http://metamock:9001', CW = 'http://zzrc16g-cw:9300', AD = 'http://zzrc16g-adapter:9100'
const mask = (p) => `***${String(p).slice(-4)}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const P = process.env
for (const k of ['ADAPTER_ENV_RELAY_KID', 'ADAPTER_ENV_ACCOUNT', 'ADAPTER_ENV_INBOX', 'ADAPTER_ENV_WORKSPACE', 'ADAPTER_ENV_AGENT', 'ADAPTER_ENV_SLUG', 'ADAPTER_ENV_PL_KID']) if (!P[k]) { console.log('missing', k); process.exit(2) }
const b64u = (b) => Buffer.from(b).toString('base64url')

function mint(wa, rid = 'cw-stg-rc16g', o = {}) {
  const key = crypto.createHmac('sha256', Buffer.from(o.hmacKey ?? env.PL_ASSERTION_HMAC_KEY, 'utf8')).update('isola-pl-flow-token-v1').digest()
  const iat = o.iat ?? Math.floor(Date.now() / 1000)
  const Pp = b64u(JSON.stringify({ v: 1, p: o.purpose ?? 'signup', wa, cw: rid, iat, exp: o.exp ?? iat + 3600, n: crypto.randomBytes(12).toString('base64url') }))
  return `pls1.${Pp}.${crypto.createHmac('sha256', key).update('pls1.' + Pp).digest().toString('base64url')}`
}
async function flow(token, action, screen, data) {
  const aes = crypto.randomBytes(16), iv = crypto.randomBytes(16)
  const c = crypto.createCipheriv('aes-128-gcm', aes, iv)
  const enc = Buffer.concat([c.update(JSON.stringify({ version: '3.0', action, screen, data, flow_token: token })), c.final(), c.getAuthTag()])
  const body = JSON.stringify({ encrypted_flow_data: enc.toString('base64'), encrypted_aes_key: crypto.publicEncrypt({ key: PUB, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, aes).toString('base64'), initial_vector: iv.toString('base64') })
  const t0 = Date.now()
  const r = await fetch(WEB, { method: 'POST', headers: { 'content-type': 'application/json' }, body })
  const ms = Date.now() - t0, txt = await r.text()
  if (r.status !== 200) return { http: r.status, ms, raw: txt.slice(0, 120) }
  const buf = Buffer.from(txt, 'base64'); const fiv = Buffer.from(iv.map((b) => ~b & 0xff))
  const d = crypto.createDecipheriv('aes-128-gcm', aes, fiv); d.setAuthTag(buf.subarray(-16))
  const out = JSON.parse(Buffer.concat([d.update(buf.subarray(0, -16)), d.final()]).toString('utf8'))
  return { http: 200, ms, screen: out.screen, data: out.data }
}
const sentTo = async (wa) => (await (await fetch(`${MOCK}/__sent`)).json()).sent.filter((s) => s.to === wa)
const cwState = (wa, o) => fetch(`${CW}/__state`, { method: 'POST', body: JSON.stringify({ wa, ...o }) }).then((r) => r.json())
const OPEN = (wa, o = {}) => cwState(wa, { status: 'pending', inboundAgoS: 3600, outgoingOnly: false, failMessages: false, failConversation: false, noContact: false, delayMs: 0, inboundText: 'hi', ...o })

// ---- the adapter's own routes, signed the way their callers sign
function relayContext(wa, text) {
  const conv = Number(wa.slice(-6)) + 100000, msgId = 5000 + (Number(wa.slice(-4)) || 0)
  const claims = { kid: P.ADAPTER_ENV_RELAY_KID, iat: Math.floor(Date.now() / 1000), nonce: crypto.randomBytes(16).toString('base64url').slice(0, 22), accountId: Number(P.ADAPTER_ENV_ACCOUNT), inboxId: Number(P.ADAPTER_ENV_INBOX),
    workspaceId: P.ADAPTER_ENV_WORKSPACE, agentId: P.ADAPTER_ENV_AGENT, agentSlug: P.ADAPTER_ENV_SLUG, chatwootConversationId: String(conv), chatwootMessageId: String(msgId), messageSha256: crypto.createHash('sha256').update(text, 'utf8').digest('hex') }
  const Pp = b64u(JSON.stringify(claims))
  return `v1.${Pp}.${b64u(crypto.createHmac('sha256', Buffer.from(CTXKEY, 'utf8')).update('v1.' + Pp).digest())}`
}
async function adapterKeyword(wa, text) {   // STOP / START through the adapter's real /v1/action route
  await OPEN(wa, { inboundText: text, inboundAgoS: 30 })
  const r = await fetch(`${AD}/v1/action`, { method: 'POST', headers: { authorization: `Bearer ${BEARER}`, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'auto', context: relayContext(wa, text) }) })
  const j = await r.json().catch(() => ({})); await OPEN(wa); return { http: r.status, code: j.code, action: j.action }
}
const eSign = (key, body) => crypto.createHmac('sha256', Buffer.from(key, 'utf8')).update(`pl-eligibility-v1.${body}`, 'utf8').digest('base64url')
const eBody = (wa, o = {}) => JSON.stringify({ kid: P.ADAPTER_ENV_PL_KID, wa_id: wa, ref: 'cw-direct', iat: Math.floor(Date.now() / 1000), nonce: crypto.randomBytes(16).toString('base64url'), ...o })
const ePost = async (body, sig) => { const r = await fetch(`${AD}/v1/eligibility`, { method: 'POST', headers: sig ? { 'x-pl-eligibility-signature': sig } : {}, body }); return { http: r.status, json: await r.json().catch(() => null) } }

const db = new pg.Client({ connectionString: env.DATABASE_URL }); await db.connect()
if ((await db.query('select current_database() d')).rows[0].d !== 'plstg') { console.log('REFUSING: not the staging database'); process.exit(2) }
const wa = P.USE_WA || ''
if (!/^176755501\d\d$/.test(wa)) { console.log('USE_WA must be a synthetic 176755501xx number (an EXISTING synthetic line at install)'); process.exit(2) }
{ const rows = (await db.query(`select "installSelfReportedAt" is null as no_install, "registrationHandoffAt" is null as no_handoff from lite_accounts where "ownerPhone" like '%'||$1`, [wa])).rows
  console.log(`existing synthetic line ${mask(wa)}: holders=${rows.length} ${JSON.stringify(rows)}`); if (rows.length !== 1) process.exit(2) }
const idHash = (v) => crypto.createHmac('sha256', Buffer.from(env.PL_ASSERTION_HMAC_KEY, 'utf8')).update(`pl-audit\0${v}`, 'utf8').digest('hex').slice(0, 32)
const waHash = idHash(wa), SEED_KID = 'rc16g-seed', last4 = wa.slice(-4)
async function inboundAt(hoursAgo) {   // the PL service's own (proxy) record of the last relay-verified inbound; null = none
  await db.query(`delete from pl_concierge_audit where kid = $1 and wa_id_hash = $2`, [SEED_KID, waHash])
  if (hoursAgo === null) return
  await db.query(`insert into pl_concierge_audit (id, endpoint, op, http_status, code, kid, rid, wa_id_hash, wa_last4, created_at) values ($1,'account/journey',null,200,'journey',$2,'cw-seed',$3,$4, now() - ($5 || ' hours')::interval)`, [crypto.randomUUID(), SEED_KID, waHash, last4, String(hoursAgo)])
}
const claims = async (os) => (await db.query(`select count(*)::int n from pl_concierge_audit where endpoint='flows/store-button' and wa_last4=$1 and op=$2 and code in ('store_button_claimed','store_button_sent') and created_at > now() - interval '24 hours'`, [last4, os])).rows[0].n
const ageClaims = async (os) => (await db.query(`update pl_concierge_audit set created_at = now() - interval '25 hours' where endpoint='flows/store-button' and wa_last4=$1 and op=$2 and created_at > now() - interval '24 hours' and code in ('store_button_claimed','store_button_sent') returning id`, [last4, os])).rowCount
const dbNow = async () => (await db.query('select now() t')).rows[0].t
const refusalsSince = async (since) => (await db.query(`select code, left(detail,60) detail from pl_concierge_audit where endpoint='flows/store-button' and wa_last4=$1 and created_at >= $2 and code not in ('store_button_claimed','store_button_sent','store_button_failed') order by created_at`, [last4, since])).rows
// settle: the adapter consult takes 0.7-2.2 s (more under host load) BEFORE the claim row exists, so a fixed sleep can return before anything
// was written. Poll for a TERMINAL audit row of this tap (sent / failed / any refusal) created since `since`, then let the recorder catch up.
const terminalSince = async (since) => (await db.query(`select count(*)::int n from pl_concierge_audit where endpoint='flows/store-button' and wa_last4=$1 and created_at >= $2 and code <> 'store_button_claimed'`, [last4, since])).rows[0].n
const settle = async (since, wantTerminal, maxMs = 40000) => {
  const t0 = Date.now()
  if (wantTerminal) while (Date.now() - t0 < maxMs && (await terminalSince(since)) === 0) await sleep(500)
  else await sleep(2500)
  await sleep(1500)
}

// ---- get the sender to INSTALL
const T0 = mint(wa)
let r = await flow(T0, 'INIT'); console.log(`INIT: ${r.http} ${r.screen ?? r.raw}`)
r = await flow(T0, 'data_exchange', 'WELCOME', { first_name: 'Stg' }); console.log(`WELCOME: ${r.http} ${r.screen ?? r.raw}`)
r = await flow(T0, 'data_exchange', 'CONFIRM', { confirm: 'yes' }); console.log(`CONFIRM: ${r.http} ${r.screen ?? r.raw}`)
for (let i = 0; i < 6 && r.screen === 'PROVISIONING'; i++) { await sleep(3000); r = await flow(T0, 'data_exchange', 'PROVISIONING', {}) }
r = await flow(T0, 'data_exchange', 'LINE_READY', {}); console.log(`LINE_READY->: ${r.http} ${r.screen ?? r.raw}`)
if (r.screen !== 'INSTALL') { console.log('NOT AT INSTALL - stopping (no store taps made)'); process.exit(3) }

// ---- preconditions / fixtures
await fetch(`${MOCK}/__reset`, { method: 'POST' })
console.log(`pre-run: aged ${await ageClaims('ios') + await ageClaims('android')} earlier store-button claim row(s) of ${mask(wa)} out of the window`)
if (P.ADAPTER_DOWN !== '1') { const s = await adapterKeyword(wa, 'START'); console.log(`pre-run START via the adapter: ${JSON.stringify(s)} (clears any STOP left by an earlier run)`) }
await OPEN(wa); await inboundAt(1)
const runStart = await dbNow()
const results = [], nowS = () => Math.floor(Date.now() / 1000)
async function tap(label, token, os, expectSends, expectRefusal, o = {}) {
  const before = (await sentTo(wa)).length, since = await dbNow()
  const t = await flow(token, 'data_exchange', 'INSTALL', { step: 'store', os })
  await settle(since, expectSends > 0 || expectRefusal !== null)
  const after = (await sentTo(wa)).length
  const ref = await refusalsSince(since)
  const got = ref.map((x) => x.code)
  const ok = t.screen === (o.expectScreen ?? 'INSTALL_STORE') && after - before === expectSends && (expectRefusal === null ? got.length === 0 : got.includes(expectRefusal))
  const row = { label, os, flow_screen: t.screen, flow_ms: t.ms, new_sends: after - before, expected_sends: expectSends, refusal_codes: got, refusal_detail: ref.map((x) => x.detail), expected_refusal: expectRefusal, claims_ios_after: await claims('ios'), ok }
  results.push(row); console.log(JSON.stringify(row)); return row
}

if (P.ADAPTER_DOWN === '1') {   // phase 2, run by the operator script AFTER scaling plstg_zzrc16g_adapter to 0 (the adapter is genuinely unreachable)
  console.log('=== F. adapter unreachable (plstg_zzrc16g_adapter has 0 replicas) ===')
  await tap('F1 adapter down (connection refused/unresolvable) -> no send, claim not consumed, Flow answer unchanged and fast', mint(wa), 'ios', 0, 'store_button_eligibility_unavailable')
  results.at(-1).ok = results.at(-1).ok && results.at(-1).flow_ms < 1500
  await inboundAt(null)
  for (const x of results) console.log(x.ok ? 'PASS' : 'FAIL', x.label)
  console.log(`SUMMARY(F): ${results.filter((x) => x.ok).length}/${results.length}; sends recorded for this sender since run start = ${(await sentTo(wa)).length}`)
  await db.end(); process.exit(0)
}

console.log('=== 0. adapter endpoint auth, directly (key + kid held in-process) ===')
{
  const postsBefore = (await (await fetch(`${CW}/__posts?wa=${wa}`)).json()).posts.length   // the pre-run START confirmation is already in there
  const a = eBody(wa), good = await ePost(a, eSign(PLKEY, a))
  results.push({ label: 'E1 signed valid request -> 200 eligible (CONTROL, answers only)', ok: good.http === 200 && good.json?.eligible === true && good.json?.reason === 'ok', got: good }); console.log(JSON.stringify(results.at(-1)))
  const rep = await ePost(a, eSign(PLKEY, a)); results.push({ label: 'E2 the SAME signed request replayed -> 409', ok: rep.http === 409, got: rep.http }); console.log(JSON.stringify(results.at(-1)))
  const f = eBody(wa), forged = await ePost(f, eSign('z'.repeat(64), f)); results.push({ label: 'E3 forged signature -> 401', ok: forged.http === 401, got: forged.http }); console.log(JSON.stringify(results.at(-1)))
  const o = eBody(wa, { iat: Math.floor(Date.now() / 1000) - 600 }), exp = await ePost(o, eSign(PLKEY, o)); results.push({ label: 'E4 expired (iat 10 min old), validly signed -> 401', ok: exp.http === 401, got: exp.http }); console.log(JSON.stringify(results.at(-1)))
  const u = await ePost(eBody(wa)); results.push({ label: 'E5 unsigned -> 401', ok: u.http === 401, got: u.http }); console.log(JSON.stringify(results.at(-1)))
  const t = eBody(wa), tam = await ePost(t.replace(wa, '17675550198'), eSign(PLKEY, t)); results.push({ label: 'E6 tampered body (other wa_id) -> 401', ok: tam.http === 401, got: tam.http }); console.log(JSON.stringify(results.at(-1)))
  const pb = JSON.stringify({ kid: P.ADAPTER_ENV_PL_KID, wa_id: wa, key: 'first_call', ref: 'x', iat: Math.floor(Date.now() / 1000), nonce: crypto.randomBytes(16).toString('base64url') })
  const px = crypto.createHmac('sha256', Buffer.from(PLKEY, 'utf8')).update(`pl-proactive-v1.${pb}`, 'utf8').digest('base64url'); const cross = await ePost(pb, px)
  results.push({ label: 'E7 a /v1/proactive-purpose signature cannot be used as an eligibility request -> 401', ok: cross.http === 401, got: cross.http }); console.log(JSON.stringify(results.at(-1)))
  const noPost = (await (await fetch(`${CW}/__posts?wa=${wa}`)).json()).posts.length - postsBefore
  results.push({ label: 'E8 eligibility answers only: the mock Chatwoot received NO outgoing post for this sender', ok: noPost === 0, got: noPost }); console.log(JSON.stringify(results.at(-1)))
}

console.log('=== A. through the Flow (recorder = graph.facebook.com stand-in) ===')
await tap('A1 FORGED flow token -> ERROR screen, no send, no refusal row', mint(wa, 'cw-x', { hmacKey: 'z'.repeat(48) }), 'ios', 0, null, { expectScreen: 'ERROR' })

console.log('=== B. human ownership ===')
await OPEN(wa, { status: 'open' })
await tap('B1 conversation held by a person (status open) -> no send, claim not consumed', mint(wa), 'ios', 0, 'store_button_human_owned')
await OPEN(wa)
await tap('B2 TWIN person hands back (pending) -> exactly 1 (iPhone)', mint(wa), 'ios', 1, null); console.log(`  iPhone claims now: ${await claims('ios')}`); await ageClaims('ios')

console.log('=== C. adapter STOP (through the adapter\'s own /v1/action) ===')
console.log(`  STOP -> ${JSON.stringify(await adapterKeyword(wa, 'STOP'))}`)
await tap('C1 customer sent STOP (adapter preference) -> no send, claim not consumed', mint(wa), 'ios', 0, 'store_button_stopped')
console.log(`  START -> ${JSON.stringify(await adapterKeyword(wa, 'START'))}`)
await tap('C2 TWIN after START -> exactly 1', mint(wa), 'ios', 1, null); await ageClaims('ios')

console.log('=== D. the real 24 h window (Chatwoot last inbound) vs the PL-service proxy (kept OPEN = 1 h) ===')
await OPEN(wa, { inboundAgoS: 25 * 3600 })
await tap('D1 Chatwoot last inbound 25 h ago while the proxy says open -> no send (adapter outranks the proxy)', mint(wa), 'ios', 0, 'store_button_window_closed')
await OPEN(wa, { inboundAgoS: 3600 })
await tap('D2 TWIN Chatwoot last inbound 1 h ago -> exactly 1', mint(wa), 'ios', 1, null); await ageClaims('ios')
await OPEN(wa, { outgoingOnly: true })
await tap('D3 no customer message on record in Chatwoot (window unknown) -> no send', mint(wa), 'ios', 0, 'store_button_eligibility_unavailable')
await OPEN(wa, { failMessages: true })
await tap('D4 Chatwoot messages unreadable (HTTP 500) -> no send (fail closed)', mint(wa), 'ios', 0, 'store_button_eligibility_unavailable')
await OPEN(wa, { failConversation: true })
await tap('D5 Chatwoot conversation unreadable (HTTP 500) -> no send (fail closed)', mint(wa), 'ios', 0, 'store_button_eligibility_unavailable')
await OPEN(wa, { noContact: true })
await tap('D6 no Chatwoot contact for the number -> no send', mint(wa), 'ios', 0, 'store_button_eligibility_unavailable')
await OPEN(wa, { delayMs: 9000 })
await tap('D7 adapter slow (Chatwoot answers after 9 s; plsvc bound 6 s) -> no send, Flow answer not delayed', mint(wa), 'ios', 0, 'store_button_eligibility_unavailable', { settleMs: 9000 })
const d7 = results.at(-1); d7.ok = d7.ok && d7.flow_ms < 1500; d7.note = `Flow answered in ${d7.flow_ms} ms (the send is not awaited)`
await OPEN(wa)
console.log(`  claims spent by all refusals so far (ios): ${await claims('ios')} (must be 0)`)

console.log('=== E. dedup expiry vs window (independent) ===')
await tap('E0 setup: eligible -> 1 (iPhone)', mint(wa), 'ios', 1, null)
await tap('E1 window OPEN (adapter eligible) but the claim is still active -> no send, store_button_deduped', mint(wa), 'ios', 0, 'store_button_deduped')
console.log(`  aged ${await ageClaims('ios')} iPhone claim row(s) past the dedup window`)
await OPEN(wa, { inboundAgoS: 25 * 3600 })
await tap('E2 dedup EXPIRED but the real window CLOSED -> no send, allowance unspent', mint(wa), 'ios', 0, 'store_button_window_closed')
console.log(`  iPhone claims after that refusal: ${await claims('ios')} (must be 0)`)
await OPEN(wa, { inboundAgoS: 3600 })
await tap('E3 TWIN dedup expired AND window open -> exactly 1', mint(wa), 'ios', 1, null); await ageClaims('ios')

await inboundAt(null); await OPEN(wa)
const mine = (await sentTo(wa))
console.log('--- sends that reached the graph.facebook.com stand-in for this sender:')
for (const s of mine) { const i = s.body?.interactive; console.log(JSON.stringify({ t: s.t, from_phone_id_last4: s.from_phone_id.slice(-4), to: mask(s.to), type: s.body?.type, interactive_type: i?.type, footer: i?.footer, url_host: (() => { try { return new URL(i?.action?.parameters?.url).host } catch { return null } })(), body_has_isola: /isola/i.test(JSON.stringify(s.body)) })) }
console.log('--- pl_concierge_audit flows/store-button rows (this sender, this run):')
for (const a of (await db.query(`select op, code, left(detail,70) detail from pl_concierge_audit where endpoint='flows/store-button' and wa_last4=$1 and coalesce(updated_at, created_at) >= $2 order by coalesce(updated_at, created_at)`, [last4, runStart])).rows) console.log(JSON.stringify(a))
console.log('--- wa_send_audit (gate decisions) for this sender:')
for (const a of (await db.query(`select decision, "dispatchStatus", "senderPath", purpose from wa_send_audit where "senderPath"='pl:flows/store-button' and phone=$1 and "createdAt" >= $2 order by "createdAt"`, [wa, runStart])).rows) console.log(JSON.stringify(a))
const stray = (await db.query(`select count(*)::int n from pl_concierge_audit where wa_id_hash=$1 and rid like 'elig-%' and created_at >= $2`, [waHash, runStart])).rows[0].n
console.log(`adapter consent reads recorded under rid elig-* (excluded from the window proxy): ${stray}`)
const bad = results.filter((x) => !x.ok)
console.log(`SUMMARY: ${results.filter((x) => x.ok).length}/${results.length} as expected; sends recorded for this sender = ${mine.length}`)
for (const b of bad) console.log('NOT AS EXPECTED:', JSON.stringify(b))
await db.end()
