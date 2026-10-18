// The REAL pl-action-adapter HTTP route POST /v1/staff over a loopback socket (support packet 2026-10-18). Chatwoot is a STATEFUL
// fake (messages, labels, assignment, status); pl_adapter_guidance is emulated at the level of the exact statements the handler issues.
// Every wa_id is FICTIONAL. Proves: one card per ref, private-only, acceptance by reply/note/label/open, ONE escalation, mirror once with
// links + token-like strings removed, signature separation, and that NOTHING ever reaches the customer (no non-private message post).
import crypto, { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

const SRC = process.env.ADAPTER_SRC ? new URL('file:///' + process.env.ADAPTER_SRC.replace(/\\/g, '/')) : new URL('../pl-action-adapter.mjs', import.meta.url)
const adapter = await import(SRC.href)
const KEY = 'TEST_KEY_NOT_A_REAL_KEY'
const NOW = () => Math.floor(Date.now() / 1000)
const STAFF = 'pl-staff-v1', PRO = 'pl-proactive-v1', OPT = 'pl-optional-contact-v1'
const SELF = 900, AGENT = 77, LEAD = 88

const W = { A: '15550100574', B: '15550100575', C: '15550100576', N: '15550100599' }
const conv = {}   // convId -> { wa, status, labels, assignee, messages: [] }
const contact = {} // contactId -> wa
let nextMsg = 1000
function addCustomer(wa, contactId, convId, status = 'pending') { contact[contactId] = wa; conv[convId] = { wa, status, labels: [], assignee: null, messages: [{ id: nextMsg++, message_type: 0, private: false, sender_type: 'contact', content: 'hello' }] } }
addCustomer(W.A, 101, 5001); addCustomer(W.B, 102, 5002); addCustomer(W.C, 103, 5003, 'open')
const convOf = (wa) => Object.entries(conv).find(([, c]) => c.wa === wa)
const state = { down: false, postFails: false, postLost: false, recordFails: false }
const log = []

const cwF = async (url, opts = {}) => {
  const u = String(url).replace(/^https?:\/\/[^/]+/, ''); const method = (opts.method || 'GET').toUpperCase()
  const body = opts.body ? JSON.parse(opts.body) : null
  log.push({ method, u, body })
  const ok = (j) => ({ ok: true, status: 200, json: async () => j })
  if (state.down) return { ok: false, status: 503, json: async () => ({}) }
  const p = u.replace('/api/v1/accounts/2', ''); let m
  if (method === 'GET' && (m = /^\/contacts\/search\?q=(\d+)$/.exec(p))) return ok({ payload: Object.entries(contact).filter(([, wa]) => wa === m[1]).map(([id]) => ({ id: Number(id) })) })
  if (method === 'GET' && (m = /^\/contacts\/(\d+)$/.exec(p))) return ok({ payload: { contact_inboxes: [{ inbox: { id: 11 }, source_id: contact[m[1]] }] } })
  if (method === 'GET' && (m = /^\/contacts\/(\d+)\/conversations$/.exec(p))) { const e = convOf(contact[m[1]]); return ok({ payload: e ? [{ id: Number(e[0]), inbox_id: 11, last_activity_at: 1 }] : [] }) }
  if (method === 'GET' && (m = /^\/conversations\/(\d+)$/.exec(p))) { const c = conv[m[1]]; return ok({ id: Number(m[1]), status: c.status, labels: [...c.labels], meta: { assignee: c.assignee ? { id: c.assignee } : null } }) }
  if (method === 'GET' && (m = /^\/conversations\/(\d+)\/messages$/.exec(p))) return ok({ payload: conv[m[1]].messages.slice(-20) })
  if (method === 'POST' && (m = /^\/conversations\/(\d+)\/messages$/.exec(p))) { if (state.postFails) return { ok: false, status: 422, json: async () => ({}) }; if (state.onPost) state.onPost(conv[m[1]]); if (state.postLost) { conv[m[1]].messages.push({ id: nextMsg++, message_type: 1, private: !!body.private, sender_type: 'User', sender: { id: SELF, type: 'user' }, content: body.content }); throw new TypeError('fetch failed') } const msg = { id: nextMsg++, message_type: 1, private: !!body.private, sender_type: 'User', sender: { id: SELF, type: 'user' }, content: body.content }; conv[m[1]].messages.push(msg); return ok(msg) }
  if (method === 'POST' && (m = /^\/conversations\/(\d+)\/labels$/.exec(p))) { conv[m[1]].labels = body.labels; return ok({ payload: body.labels }) }
  if (method === 'POST' && (m = /^\/conversations\/(\d+)\/assignments$/.exec(p))) { conv[m[1]].assignee = body.assignee_id; return ok({ id: body.assignee_id }) }
  return { ok: false, status: 404, json: async () => ({}) }
}

// pl_adapter_guidance, emulated for the statements handleStaff issues (and nothing else is expected on this route)
const G = []; let gid = 1; const unknownSql = []
const db = { query: async (sql, params = []) => {
  const s = String(sql).replace(/\s+/g, ' ').trim()
  if (s.startsWith("INSERT INTO pl_adapter_guidance (cw_conversation, wa_hash, message_id, event) VALUES ($1,$2,$3,'staff') ON CONFLICT DO NOTHING RETURNING id")) {
    if (G.some((r) => r.cw_conversation === String(params[0]) && r.wa_hash === params[1] && r.message_id === params[2] && r.event === 'staff')) return { rows: [], rowCount: 0 }
    const r = { id: gid++, cw_conversation: String(params[0]), wa_hash: params[1], message_id: params[2], event: 'staff', stage: null, posted_msg_id: null, created_at: new Date() }; G.push(r); return { rows: [{ id: r.id }], rowCount: 1 }
  }
  if (s.startsWith('UPDATE pl_adapter_guidance SET stage=$2, posted_msg_id=$3 WHERE id=$1') && state.recordFails) throw new Error('db write failed')
  if (s.startsWith('UPDATE pl_adapter_guidance SET stage=$2 WHERE id=$1')) { const r = G.find((x) => x.id === params[0]); if (r) r.stage = params[1]; return { rows: [], rowCount: r ? 1 : 0 } }
  if (s.startsWith('UPDATE pl_adapter_guidance SET stage=$2, posted_msg_id=$3 WHERE id=$1')) { const r = G.find((x) => x.id === params[0]); if (r) { r.stage = params[1]; r.posted_msg_id = params[2] }; return { rows: [], rowCount: r ? 1 : 0 } }
  if (s.startsWith('DELETE FROM pl_adapter_guidance WHERE id=$1')) { const i = G.findIndex((x) => x.id === params[0]); if (i >= 0) G.splice(i, 1); return { rows: [], rowCount: i >= 0 ? 1 : 0 } }
  if (s.startsWith("SELECT posted_msg_id, stage, created_at FROM pl_adapter_guidance WHERE cw_conversation=$1 AND wa_hash=$2 AND message_id=$3 AND event='staff'")) { const r = G.find((x) => x.cw_conversation === String(params[0]) && x.wa_hash === params[1] && x.message_id === params[2] && x.event === 'staff'); return { rows: r ? [r] : [], rowCount: r ? 1 : 0 } }
  if (/^SELECT proactive_stopped FROM pl_adapter_preference/.test(s)) return { rows: [], rowCount: 0 }
  unknownSql.push(s.slice(0, 80)); return { rows: [], rowCount: 0 }
} }

const cfg = { plKey: KEY, plKid: 'k1', plPnid: '0', plBase: 'http://pl.invalid', cwBase: 'http://cw.invalid', cwAccount: 2, cwInbox: 11, cwToken: 'x', timeoutMs: 5000, bearer: 'unused-bearer-not-sent', sourceCidrs: [], stallOwnerAgentId: AGENT, stallEscalationAgentId: LEAD }
const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${srv.address().port}`)))
const srv = adapter.makeServer(cfg, db, cwF).server; const URL1 = await listen(srv)
const cfgNoAssign = { ...cfg, stallOwnerAgentId: null, stallEscalationAgentId: null }
const srv2 = adapter.makeServer(cfgNoAssign, db, cwF).server; const URL2 = await listen(srv2)

const sign = (purpose, raw, key = KEY) => crypto.createHmac('sha256', Buffer.from(key, 'utf8')).update(`${purpose}.${raw}`, 'utf8').digest('base64url')
const body = (o = {}) => JSON.stringify({ kid: 'k1', wa_id: W.A, action: 'route', ref: 'link_not_opened:row-f574', text: 'STALL CARD link_not_opened', iat: NOW(), nonce: crypto.randomBytes(16).toString('base64url'), ...o })
async function post(url, raw, headers) { const r = await fetch(url + '/v1/staff', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: raw }); let j = null; try { j = await r.json() } catch {} return { status: r.status, j } }
const staff = (o, opts = {}) => { const raw = body(o); return post(opts.url ?? URL1, raw, { 'x-pl-staff-signature': opts.sig ?? sign(STAFF, raw) }) }
const code = async (o, opts) => { const r = await staff(o, opts); return `${r.status}/${r.j?.code}${r.j?.by ? ':' + r.j.by : r.j?.detail ? ':' + r.j.detail : ''}` }
const check = (o) => staff({ action: 'check', text: undefined, ack_window_s: 1800, escalate_text: 'ESCALATION CARD', ...o })
const checkCode = async (o = {}) => { const r = await check(o); return `${r.status}/${r.j?.code}${r.j?.by ? ':' + r.j.by : ''}` }
const ageCard = (ref, conversationId, seconds) => { const r = G.find((x) => x.message_id === `stall:${ref}` && x.cw_conversation === String(conversationId)); r.created_at = new Date(Date.now() - seconds * 1000) }

const results = []
const t = (name, got, expected) => results.push({ name, got: String(got), expected: String(expected), pass: String(got) === String(expected) })
const A = conv[5001], B = conv[5002], C = conv[5003]
const privateNotes = (c) => c.messages.filter((m) => m.message_type === 1 && m.private)

// ── route: one card, private, labelled, assigned ──
t('S1 route -> routed', await code({}), '200/routed')
t('S1 the card is a PRIVATE note', privateNotes(A).length, 1)
t('S1 label pl-stall-open added', A.labels.includes('pl-stall-open'), true)
t('S1 stall owner assigned (no assignee before)', A.assignee, AGENT)
t('S1 status untouched (still pending = AI-owned; an assignee is not a hold)', A.status, 'pending')
t('S2 the SAME route again -> duplicate, no second card', await code({}), '200/duplicate')
t('S2 still exactly one card', privateNotes(A).length, 1)
// ── check: waiting, then escalate ONCE, then escalated_waiting ──
t('S3 check inside the window -> waiting', await checkCode(), '200/waiting')
ageCard('link_not_opened:row-f574', 5001, 1801)
t('S3 check after the window, nobody accepted -> escalated', await checkCode(), '200/escalated')
t('S3 escalation card is private', privateNotes(A).length, 2)
t('S3 label pl-stall-escalated added', A.labels.includes('pl-stall-escalated'), true)
t('S3 escalation assignee', A.assignee, LEAD)
t('S3 a further check -> escalated_waiting, no third card', await checkCode(), '200/escalated_waiting')
t('S3 still two notes', privateNotes(A).length, 2)
t('S3 the adapter\'s OWN notes never count as acceptance', (await checkCode()).startsWith('200/accepted'), false)
// ── acceptance paths (each on its own conversation/ref) ──
t('S4 B routed', await code({ wa_id: W.B, ref: 'handoff_no_register:row-b' }), '200/routed')
B.messages.push({ id: nextMsg++, message_type: 1, private: false, sender_type: 'User', sender: { id: AGENT, type: 'user' }, content: 'Hi, I can help' })
t('S4 a staff REPLY after the card -> accepted:staff_reply', await checkCode({ wa_id: W.B, ref: 'handoff_no_register:row-b' }), '200/accepted:staff_reply')
t('S5 B second ref routed', await code({ wa_id: W.B, ref: 'calls_not_connecting:row-b' }), '200/routed')
B.messages.push({ id: nextMsg++, message_type: 1, private: true, sender_type: 'User', sender: { id: AGENT, type: 'user' }, content: 'on it' })
t('S5 a staff PRIVATE NOTE after the card -> accepted:staff_note', await checkCode({ wa_id: W.B, ref: 'calls_not_connecting:row-b' }), '200/accepted:staff_note')
t('S6 A third ref routed', await code({ ref: 'no_handoff:row-a2' }), '200/routed')
A.labels.push('pl-stall-accepted')
t('S6 label pl-stall-accepted -> accepted:label', await checkCode({ ref: 'no_handoff:row-a2' }), '200/accepted:label')
t('S7 HELD conversation (open = a person holds it): the card still posts (private), no AI message', await code({ wa_id: W.C, ref: 'link_not_opened:row-c' }), '200/routed')
t('S7 open status ALONE is not acceptance (Codex review) -> waiting', await checkCode({ wa_id: W.C, ref: 'link_not_opened:row-c' }), '200/waiting')
ageCard('link_not_opened:row-c', 5003, 1801)
t('S7 open + nobody acted within the window -> escalated (toward a person)', await checkCode({ wa_id: W.C, ref: 'link_not_opened:row-c' }), '200/escalated')
t('S7 held conversation got ONLY private notes from the adapter', C.messages.filter((m) => m.sender?.id === SELF && !m.private).length, 0)
t('S8 check for a ref never routed -> not_routed', await checkCode({ ref: 'link_not_opened:row-never' }), '200/not_routed')
// ── no assignee configured: notes + labels only ──
t('S9 route without configured agents', await code({ wa_id: W.B, ref: 'peer_absent_from_conf:row-b9' }, { url: URL2 }), '200/routed')
// ── mirror ──
const mirrorText = 'Your line is ready.\nTap: https://go.example.invalid/go/0123456789abcdef0123456789abcdef and use code ABCDEFGHIJKLMNOPQRSTUVWXYZ012345\n[Button: Set up my line]'
t('S10 mirror -> sent', await code({ action: 'mirror', ref: 'mabc123', text: mirrorText }), '200/sent')
const mirrored = A.messages[A.messages.length - 1]
t('S10 mirror is PRIVATE', mirrored.private, true)
t('S10 mirror has NO link', /https?:\/\//.test(mirrored.content), false)
t('S10 mirror has NO long token', /[A-Za-z0-9_-]{24,}/.test(mirrored.content), false)
t('S10 mirror keeps the visible words and the button label', mirrored.content.includes('Your line is ready.') && mirrored.content.includes('[Button: Set up my line]'), true)
t('S11 the same mirror ref -> duplicate (once per message)', await code({ action: 'mirror', ref: 'mabc123', text: mirrorText }), '200/duplicate')
// ── failures ──
t('S12 no conversation for that wa_id -> no_conversation', await code({ wa_id: W.N, ref: 'x:1' }), '200/no_conversation:no_contact')
state.postFails = true
t('S13 Chatwoot REFUSES the post (4xx) -> failed, claim released', await code({ ref: 'link_not_opened:row-pf' }), '200/failed:note_not_posted')
state.postFails = false
t('S13 the released claim routes on the next attempt (never silently "routed")', await code({ ref: 'link_not_opened:row-pf' }), '200/routed')
state.down = true
t('S14 Chatwoot down -> failed', await code({ ref: 'link_not_opened:row-down' }), '200/failed:chatwoot_unreachable')
state.down = false
// ── ambiguous outcomes (Codex delta review 2026-10-18) ──
{ const before = privateNotes(A).length; state.postLost = true
  t('S17 post landed but the response was LOST -> routed:post_unconfirmed (claim kept)', await code({ ref: 'link_not_opened:row-lost' }), '200/routed:post_unconfirmed')
  state.postLost = false
  t('S17 a retry of the same route -> duplicate (no second card)', await code({ ref: 'link_not_opened:row-lost' }), '200/duplicate')
  t('S17 exactly ONE card exists for that ref', privateNotes(A).length - before, 1)
  t('S17 check inside the window -> waiting (never not_routed: no re-route loop)', await checkCode({ ref: 'link_not_opened:row-lost' }), '200/waiting')
  ageCard('link_not_opened:row-lost', 5001, 1801)
  t('S17 unconfirmed card still escalates on time', await checkCode({ ref: 'link_not_opened:row-lost' }), '200/escalated') }
{ state.recordFails = true
  t('S18 post OK but recording its id FAILS -> routed (claim kept)', await code({ wa_id: W.B, ref: 'link_not_opened:row-rec' }), '200/routed')
  state.recordFails = false
  t('S18 check -> waiting, not not_routed', await checkCode({ wa_id: W.B, ref: 'link_not_opened:row-rec' }), '200/waiting')
  B.labels.push('pl-stall-accepted')
  t('S18 with no recorded card id, the LABEL still proves acceptance', await checkCode({ wa_id: W.B, ref: 'link_not_opened:row-rec' }), '200/accepted:label') }
{ const r = adapter.stallAccepted({ labels: [], status: 'open' }, [{ id: 99, message_type: 1, private: true, sender_type: 'User', sender: { id: 7 } }], null, null)
  t('S19 PURE: no recorded card id -> a later staff message cannot be attributed, not accepted', r.accepted, false)
  t('S19 PURE CONTROL: with the card id + self id the same message IS acceptance', adapter.stallAccepted({ labels: [] }, [{ id: 99, message_type: 1, private: true, sender_type: 'User', sender: { id: 7 } }], 50, 900).accepted, true) }
{ A.labels.push('pl-stall-accepted')
  t('S20 precondition: A carries pl-stall-accepted from an EARLIER stall', A.labels.includes('pl-stall-accepted'), true)
  t('S20 a NEW stall on the same conversation routes', await code({ ref: 'handoff_no_register:row-a20' }), '200/routed')
  t('S20 the old accepted mark is cleared by the new card', A.labels.includes('pl-stall-accepted'), false)
  t('S20 the new stall is NOT auto-accepted by the old label', await checkCode({ ref: 'handoff_no_register:row-a20' }), '200/waiting') }
{ state.onPost = (c) => { if (!c.labels.includes('vip')) c.labels = [...c.labels, 'vip'] }   // a person labels the conversation WHILE the card posts
  t('S21 route while a person changes labels', await code({ wa_id: W.B, ref: 'no_handoff:row-b21' }), '200/routed')
  state.onPost = null
  t('S21 the label the person added during the post SURVIVES the stall-label write', B.labels.includes('vip'), true)
  t('S21 and pl-stall-open is set', B.labels.includes('pl-stall-open'), true) }
// ── signed-request model ──
{ const raw = body(); t('S15 a pl-proactive-v1 signature is rejected', (await post(URL1, raw, { 'x-pl-staff-signature': sign(PRO, raw) })).j?.detail, 'bad_signature') }
{ const raw = body(); t('S15 a pl-optional-contact-v1 signature is rejected', (await post(URL1, raw, { 'x-pl-staff-signature': sign(OPT, raw) })).j?.detail, 'bad_signature') }
{ const raw = body(); t('S15 wrong key', (await post(URL1, raw, { 'x-pl-staff-signature': sign(STAFF, raw, 'WRONG') })).status, 401) }
{ const raw = body(); t('S15 no signature', (await post(URL1, raw, {})).j?.detail, 'no_signature') }
{ const raw = body(), other = body({ wa_id: W.B }); t('S15 tampered body', (await post(URL1, other, { 'x-pl-staff-signature': sign(STAFF, raw) })).j?.detail, 'bad_signature') }
t('S15 stale iat', (await staff({ iat: NOW() - 600 })).j?.detail, 'stale_or_wrong_key')
t('S15 unknown action', (await staff({ action: 'send' })).j?.detail, 'bad_fields')
t('S15 ref with a space', (await staff({ ref: 'a b' })).j?.detail, 'bad_fields')
t('S15 route without text', (await staff({ text: '' })).j?.detail, 'bad_fields')
t('S15 check without escalate_text', (await staff({ action: 'check', ack_window_s: 1800 })).j?.detail, 'bad_fields')
t('S15 check with a 10 s window (below 60)', (await staff({ action: 'check', ack_window_s: 10, escalate_text: 'x' })).j?.detail, 'bad_fields')
{ const raw = JSON.stringify({ kid: 'k1', wa_id: W.A, key: 'stalled:no_handoff', ref: 'r1', iat: NOW(), nonce: 'n' }); t('S16 CONTROL /v1/proactive still rejects a staff signature', (await fetch(URL1 + '/v1/proactive', { method: 'POST', headers: { 'content-type': 'application/json', 'x-pl-proactive-signature': sign(STAFF, raw) }, body: raw }).then((r) => r.json())).detail, 'bad_signature') }

// ── composeJourney: stage-aware only on VERIFIED progress, stage label + choices unchanged ──
const j0 = { state: 'setup_not_activated', facts: { did_pretty: '+1 767 555 0100' }, payment: {} }
const plain = adapter.composeJourney(j0)
const notOpened = adapter.composeJourney({ ...j0, progress: { stage: 'link_issued', evidence: 'verified' } })
const unknownOpen = adapter.composeJourney({ ...j0, progress: { stage: 'link_issued', evidence: 'unknown' } })
const opened = adapter.composeJourney({ ...j0, progress: { stage: 'link_opened', evidence: 'verified' } })
const failing = adapter.composeJourney({ state: 'registered_no_call', facts: {}, payment: {}, progress: { stage: 'call_attempts_failing', evidence: 'verified' } })
t('J1 verified not-opened -> says it has not been opened', /hasn't been opened/.test(notOpened.text), true)
t('J1 same stage label as before', notOpened.stage, plain.stage)
t('J1 same choices as before', JSON.stringify(notOpened.choices), JSON.stringify(plain.choices))
t('J2 UNKNOWN open evidence -> unchanged wording (never "not opened")', unknownOpen.text, plain.text)
t('J3 opened, not finished', /opened your setup link but the setup didn't finish/.test(opened.text), true)
t('J4 failing calls wording, no claim that a person was told', /didn't connect/.test(failing.text) && !/team|person/i.test(failing.text), true)
t('J5 no progress -> unchanged wording (CONTROL)', adapter.composeJourney(j0).text, plain.text)
t('J6 never claims an install anywhere', [notOpened, opened, failing].some((x) => /installed/i.test(x.text)), false)

// ── run-wide proofs ──
const posts = log.filter((c) => c.method === 'POST' && /\/messages$/.test(c.u))
t('P1 CONTROL the run posted notes', posts.length >= 8, true)
t('P1 EVERY message the route posted is private (nothing to the customer)', posts.every((c) => c.body?.private === true), true)
t('P2 only account 2 addressed', log.every((c) => c.u.startsWith('/api/v1/accounts/2/')), true)
t('P3 no unexpected SQL on this route', unknownSql.length, 0)

const sha = createHash('sha256').update(readFileSync(SRC)).digest('hex')
console.log('adapter candidate sha256:', sha)
for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name.padEnd(96)} got=${r.got}${r.pass ? '' : '   EXPECTED=' + r.expected}`)
console.log(`${results.filter((r) => r.pass).length}/${results.length}`, results.every((r) => r.pass) ? 'ALL PASS' : 'SOME FAILED')
srv.closeAllConnections?.(); srv2.closeAllConnections?.()
await new Promise((r) => srv.close(r)); await new Promise((r) => srv2.close(r))
process.exitCode = results.every((r) => r.pass) ? 0 : 1
