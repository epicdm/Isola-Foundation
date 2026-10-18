// ACCEPTANCE DEMONSTRATION - FICTIONAL, MESSAGE-DRIVEN recovery (owner correction 2026-10-18). Every recovery step here is triggered by a
// fictional customer's message and the agent's tool call in reply. It is NOT unattended customer completion: a silent customer gets only the
// watcher's existing once-per-verdict reminder, and an account with no setup link is not reached at all (both gaps stand).
// The agent's REAL path: JSON-RPC tools/call on the adapter's /mcp route over loopback, with a signed relay context and Chatwoot readback of
// the customer's own message (the identity the live concierge uses), plus the signed /v1/proactive route. plsvc is a STATEFUL fake whose
// verified `progress` only advances when the (fictional) customer acts; Chatwoot is a stateful fake. FICTIONAL numbers only (1555010xxxx).
// Each absence assertion has a positive twin. argv[2] = adapter file (default: ../../adapter-work/pl-action-adapter.mjs).
import crypto, { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

const SRC = process.argv[2] ? new URL('file:///' + process.argv[2].replace(/\\/g, '/')) : new URL('../pl-action-adapter.mjs', import.meta.url)
const A = await import(SRC.href)
const results = []
const t = (name, got, expected) => results.push({ name, got: String(got), expected: String(expected), pass: String(got) === String(expected) })
const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex')
const nowS = () => Math.floor(Date.now() / 1000)

// ── worlds: one fictional customer per conversation ──
const W = {}   // wa -> { conv, contact, status, messages, progress, journeyFails, plCalls: [], customerSaw: [] }
let nextMsg = 1000
function customer(wa, conv, contact, progress) { W[wa] = { wa, conv, contact, status: 'pending', messages: [], progress, journeyFails: false, plCalls: [], customerSaw: [], toggleFails: false }; return W[wa] }
function say(wa, text) { const c = W[wa]; const m = { id: nextMsg++, message_type: 0, private: false, sender_type: 'contact', source_id: 'wamid.' + crypto.randomBytes(12).toString('hex'), content: text, created_at: nowS() }; c.messages.push(m); return m }
const P = (stage, reason, extra = {}) => ({ stage, evidence: stage === 'first_call_ok' ? 'technical' : 'verified', since: '2026-10-18T10:01:00.000Z', age_minutes: 39, stalled: !!reason, reason,
  staff_next_action: `NEXT HUMAN ACTION for ${reason ?? stage}`, customer_guidance: 'open_the_link', coverage: { automated_reminders: 'covered', why: null }, ...extra })
const byConv = (id) => Object.values(W).find((c) => String(c.conv) === String(id))
const byContact = (id) => Object.values(W).find((c) => String(c.contact) === String(id))
const cwLog = []

const KEY = 'TEST_PL_KEY_NOT_REAL', CTXKEY = 'TEST_CTX_KEY_NOT_REAL'
const f = async (url, init = {}) => {
  const u = String(url), method = (init.method || 'GET').toUpperCase()
  const ok = (j) => ({ ok: true, status: 200, json: async () => j })
  if (u.startsWith('http://pl.invalid/')) {
    const ep = u.split('/api/internal/pl-concierge/v1/')[1]
    const a = JSON.parse(Buffer.from(String(init.headers['x-isola-assertion']).split('.')[1], 'base64url').toString('utf8'))
    const c = W[String(a.wa_id)]
    c.plCalls.push(ep)
    if (ep === 'account/journey') {
      if (c.journeyFails) return ok({ code: 'service_unavailable' })
      return ok({ code: 'journey', data: { state: c.progress?.stage === 'first_call_ok' ? 'active' : 'setup_not_activated', has_line: true, actions: ['continue_setup', 'human'], attention: [], registration_known: true,
        facts: { did_pretty: '+1 555 010 0000', registration: c.progress?.stage === 'registered' || c.progress?.stage === 'call_attempts_failing' ? 'registered' : 'unregistered', first_call_done: c.progress?.stage === 'first_call_ok', minutes_remaining: 60, minutes_included: 60 },
        payment: { topup_available: false }, consent: { estate_suppressed: false, known: true }, progress: c.progress } })
    }
    if (ep === 'account/next-step') { c.customerSaw.push('[plsvc] Set up my line button'); return ok({ code: 'buttons_sent', data: { include_app: true, buttons: 2 } }) }
    if (ep === 'account/balance') return ok({ code: 'balance', data: { known: true, kind: 'included', minutes_included: 60, minutes_remaining: 60, low: false, wallet_xcd: '0.00' } })
    return ok({ code: 'bad_response' })
  }
  if (u.startsWith('http://cw.invalid/api/v1/accounts/2/')) {
    const p = u.replace('http://cw.invalid/api/v1/accounts/2', ''); const body = init.body ? JSON.parse(init.body) : null; let m
    cwLog.push({ method, p, body })
    if (method === 'GET' && (m = /^\/contacts\/search\?q=(\d+)$/.exec(p))) return ok({ payload: W[m[1]] ? [{ id: W[m[1]].contact }] : [] })
    if (method === 'GET' && (m = /^\/contacts\/(\d+)$/.exec(p))) { const c = byContact(m[1]); return ok({ payload: { id: c.contact, phone_number: '+' + c.wa, contact_inboxes: [{ inbox: { id: 11 }, source_id: c.wa }] } }) }
    if (method === 'GET' && (m = /^\/contacts\/(\d+)\/conversations$/.exec(p))) { const c = byContact(m[1]); return ok({ payload: [{ id: c.conv, inbox_id: 11, last_activity_at: nowS() }] }) }
    if (method === 'GET' && (m = /^\/conversations\/(\d+)$/.exec(p))) { const c = byConv(m[1]); return ok({ id: c.conv, inbox_id: 11, status: c.status, labels: [], meta: { sender: { id: c.contact } } }) }
    if (method === 'GET' && (m = /^\/conversations\/(\d+)\/messages$/.exec(p))) return ok({ payload: byConv(m[1]).messages.slice(-20) })
    if (method === 'POST' && (m = /^\/conversations\/(\d+)\/messages$/.exec(p))) { const c = byConv(m[1]); const msg = { id: nextMsg++, message_type: 1, private: !!body.private, sender_type: 'User', sender: { id: 900 }, content: body.content, created_at: nowS() }; c.messages.push(msg); if (!body.private) c.customerSaw.push(body.content); return ok(msg) }
    if (method === 'POST' && (m = /^\/conversations\/(\d+)\/toggle_status$/.exec(p))) { const c = byConv(m[1]); if (c.toggleFails) return { ok: false, status: 500, json: async () => ({}) }; c.status = body.status; return ok({ payload: { current_status: body.status } }) }
    if (method === 'POST' && (m = /^\/conversations\/(\d+)\/assignments$/.exec(p))) return ok({})
    return { ok: false, status: 404, json: async () => ({}) }
  }
  throw new Error('unexpected fetch ' + u)
}

// pl_adapter_guidance + pl_adapter_preference, emulated for exactly the statements the adapter issues on these routes
const G = []; let gid = 1; const unknownSql = []
const db = { query: async (sql, p = []) => {
  const s = String(sql).replace(/\s+/g, ' ').trim()
  const R = (rows) => ({ rows, rowCount: rows.length })
  if (s.startsWith('INSERT INTO pl_adapter_guidance (cw_conversation, wa_hash, message_id, event) VALUES ($1,$2,$3,$4)')
    || s.startsWith("INSERT INTO pl_adapter_guidance (cw_conversation, wa_hash, message_id, event) VALUES ($1,$2,$3,'recovery')")
    || s.startsWith("INSERT INTO pl_adapter_guidance (cw_conversation, wa_hash, message_id, event) VALUES ($1,$2,$3,'proactive')")
    || s.startsWith('INSERT INTO pl_adapter_guidance (cw_conversation, wa_hash, message_id, event, stage)')) {
    const ev = s.includes("'recovery_pause'") ? 'recovery_pause' : s.includes("'recovery'") ? 'recovery' : s.includes("'proactive'") ? 'proactive' : p[3]
    const stage = s.includes('event, stage)') ? p[3] : null
    if (G.some((r) => r.c === String(p[0]) && r.h === p[1] && r.m === p[2] && r.e === ev)) return R([])
    const r = { id: gid++, c: String(p[0]), h: p[1], m: p[2], e: ev, stage, created: new Date() }; G.push(r)
    return s.includes('RETURNING id') ? R([{ id: r.id }]) : R([{}])
  }
  if (s.startsWith('UPDATE pl_adapter_guidance SET stage=$2, posted_msg_id=$3 WHERE id=$1') || s.startsWith('UPDATE pl_adapter_guidance SET stage=$2 WHERE id=$1')) { const r = G.find((x) => x.id === p[0]); if (r) r.stage = p[1]; return R(r ? [{}] : []) }
  if (s === 'DELETE FROM pl_adapter_guidance WHERE id=$1') { const i = G.findIndex((x) => x.id === p[0]); if (i >= 0) G.splice(i, 1); return R(i >= 0 ? [{}] : []) }
  if (s === "DELETE FROM pl_adapter_guidance WHERE wa_hash=$1 AND event='recovery_pause'") { const n = G.filter((x) => x.h === p[0] && x.e === 'recovery_pause').length; for (let i = G.length - 1; i >= 0; i--) if (G[i].h === p[0] && G[i].e === 'recovery_pause') G.splice(i, 1); return { rows: [], rowCount: n } }
  if (s.startsWith("SELECT stage FROM pl_adapter_guidance WHERE wa_hash=$1 AND event='recovery_pause' AND created_at > now() - make_interval(secs => $2)")) { const r = G.filter((x) => x.h === p[0] && x.e === 'recovery_pause' && x.created > new Date(Date.now() - p[1] * 1000)).slice(-1); return R(r.map((x) => ({ stage: x.stage }))) }
  if (s.startsWith("SELECT 1 FROM pl_adapter_guidance WHERE wa_hash=$1 AND event='recovery_pause' AND created_at > now() - make_interval(secs => $2)")) { const r = G.filter((x) => x.h === p[0] && x.e === 'recovery_pause' && x.created > new Date(Date.now() - p[1] * 1000)); return R(r.length ? [{}] : []) }
  if (s.startsWith("SELECT message_id, stage, created_at FROM pl_adapter_guidance WHERE wa_hash=$1 AND event='recovery' AND (left(message_id, length($2)) = $2 OR left(message_id, length($3)) = $3)")) return R(G.filter((x) => x.h === p[0] && x.e === 'recovery' && (x.m.startsWith(p[1]) || x.m.startsWith(p[2]))).map((x) => ({ message_id: x.m, stage: x.stage, created_at: x.created })))
  if (s.startsWith('SELECT stage FROM pl_adapter_guidance WHERE cw_conversation=$1 AND wa_hash=$2 AND message_id=$3 AND event=$4')) { const r = G.find((x) => x.c === String(p[0]) && x.h === p[1] && x.m === p[2] && x.e === p[3]); return R(r ? [{ stage: r.stage }] : []) }
  if (s.startsWith("SELECT stage FROM pl_adapter_guidance WHERE wa_hash=$1 AND event='recovery' AND message_id=$2 LIMIT 1")) { const r = G.find((x) => x.h === p[0] && x.e === 'recovery' && x.m === p[1]); return R(r ? [{ stage: r.stage }] : []) }
  if (s.startsWith('SELECT proactive_stopped FROM pl_adapter_preference')) return R([])
  if (s.startsWith("SELECT 1 FROM pl_adapter_guidance WHERE cw_conversation=$1 AND wa_hash=$2 AND message_id=$3 AND stage='proactive_first_call'")) return R([])
  unknownSql.push(s.slice(0, 90)); return R([])
} }

const base = { plKey: KEY, plKid: 'k1', plPnid: '0', plBase: 'http://pl.invalid', cwBase: 'http://cw.invalid', cwAccount: 2, cwInbox: 11, cwToken: 'x', timeoutMs: 3000, bearer: 'TEST_BEARER_NOT_REAL', sourceCidrs: [],
  ctxKid: 'c1', ctxKey: CTXKEY, ctxSkewS: 60, workspaceId: 'w'.repeat(36), agentId: '00000000-0000-4000-8000-000000000001', agentSlug: 'test-agent', flowOnboarding: true, accountTools: true, deterministicTaps: true }
const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${srv.address().port}`)))
const ON = await listen(A.makeServer({ ...base, recoveryTools: true }, db, f).server)
const OFF = await listen(A.makeServer({ ...base, recoveryTools: false }, db, f).server)

function context(c, msg, key = CTXKEY) {
  const claims = { kid: 'c1', iat: nowS(), nonce: crypto.randomBytes(16).toString('base64url').slice(0, 22), accountId: 2, inboxId: 11, workspaceId: base.workspaceId, agentId: base.agentId, agentSlug: base.agentSlug,
    chatwootConversationId: c.conv, chatwootMessageId: msg.id, messageSha256: sha(msg.content) }
  const p = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url')
  return `v1.${p}.${crypto.createHmac('sha256', Buffer.from(key, 'utf8')).update('v1.' + p, 'utf8').digest('base64url')}`
}
let rpcId = 1
async function rpc(url, method, params) { const r = await fetch(url + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${base.bearer}` }, body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method, params }) }); return r.json() }
/** The agent calls a tool for the customer's latest message (exactly what the relay mints per turn). */
async function tool(c, name, args = {}, { url = ON, msg = null, key = CTXKEY } = {}) {
  const m = msg ?? c.messages.filter((x) => x.message_type === 0).slice(-1)[0]
  const j = await rpc(url, 'tools/call', { name, arguments: args, _meta: { [A.META_KEY]: context(c, m, key) } })
  return JSON.parse(j.result.content[0].text)
}
const signP = (raw) => crypto.createHmac('sha256', Buffer.from(KEY, 'utf8')).update(`pl-proactive-v1.${raw}`, 'utf8').digest('base64url')
async function proactive(c, key, ref) { const raw = JSON.stringify({ kid: 'k1', wa_id: c.wa, key, ref, iat: nowS(), nonce: crypto.randomBytes(16).toString('base64url') }); const r = await fetch(ON + '/v1/proactive', { method: 'POST', headers: { 'content-type': 'application/json', 'x-pl-proactive-signature': signP(raw) }, body: raw }); return (await r.json()).code }
const publicTo = (c) => c.customerSaw.length

// ═════ S1 the 574 shape, end to end: link never opened -> fresh setup -> handed off -> not connecting -> connected -> calls failing -> WORKING CALL ═════
{ const c = customer('15550100574', 7001, 501, P('link_issued', 'link_not_opened'))
  say(c.wa, 'hi, i never got to set it up')
  let r = await tool(c, 'pl_recovery')
  t('S1 observe: verified stage + the ONE playbook for it', `${r.stage}/${r.evidence}/${r.reason}/${r.playbook?.actions}`, 'link_issued/verified/link_not_opened/send_setup')
  t('S1 the playbook states customer step, success evidence and the escalation condition', !!(r.playbook?.customer && r.playbook?.success && r.playbook?.escalate_when), true)
  t('S1 no person required yet', r.must_escalate, false)
  r = await tool(c, 'pl_recovery_act', { action: 'send_setup' })
  t('S1 act: fresh setup buttons sent by the existing sender', `${r.code}/${r.recovery?.attempts_used}`, 'buttons_sent/1')
  t('S1 plsvc next-step was the mechanism (no new sender)', c.plCalls.includes('account/next-step'), true)
  c.progress = P('handed_off', null)                      // the customer tapped it: plsvc now shows the hand-off (verified)
  say(c.wa, 'ok i tapped it')
  r = await tool(c, 'pl_recovery')
  t('S1 verify: progress moved, no stall, normal next step', `${r.stage}/${r.playbook}/${r.must_escalate}`, 'handed_off/null/false')
  c.progress = P('handed_off', 'handoff_no_register')
  say(c.wa, 'it says nothing')
  r = await tool(c, 'pl_recovery')
  t('S1 new stall -> its own playbook (check_connection, send_setup)', String(r.playbook?.actions), 'check_connection,send_setup')
  t('S1 attempts are per stall: the earlier link stall does not count here', r.playbook?.attempts_used, 0)
  const before = publicTo(c)
  r = await tool(c, 'pl_recovery_act', { action: 'check_connection' })
  t('S1 act: connection check delivered as ONE system-written message', `${r.code}/${publicTo(c) - before}`, 'message_sent/1')
  c.progress = P('call_attempts_failing', 'calls_not_connecting')
  say(c.wa, 'connected now but my calls fail')
  r = await tool(c, 'pl_recovery_act', { action: 'diagnose_call' })
  t('S1 act: call diagnosis from live facts', r.code, 'message_sent')
  c.progress = P('first_call_ok', null)
  say(c.wa, 'it worked!')
  r = await tool(c, 'pl_recovery')
  t('S1 STOP CONDITION: working call reached', `${r.terminal}/${r.evidence}`, 'working_call/technical')
  t('S1 the outcome note separates technical evidence from customer confirmation', /technical evidence/.test(r.note) && /confirm/.test(r.note), true)
  r = await tool(c, 'pl_recovery_act', { action: 'send_setup' })
  t('S1 no further recovery after a working call', r.code, 'already_working')
  t('S1 the agent never asked a person (conversation still AI-owned)', c.status, 'pending')
}

// ═════ S2 limits, duplicates, playbook-only actions, then escalation with the full package ═════
{ const c = customer('15550100575', 7002, 502, P('link_issued', 'link_not_opened'))
  const m1 = say(c.wa, 'hello')
  let r = await tool(c, 'pl_recovery_act', { action: 'send_setup' })
  t('S2 attempt 1 delivered', r.code, 'buttons_sent')
  const sent1 = c.plCalls.filter((x) => x === 'account/next-step').length
  r = await tool(c, 'pl_recovery_act', { action: 'send_setup' }, { msg: m1 })
  t('S2 DUPLICATE: the same customer message cannot trigger a second send', `${r.code}/${c.plCalls.filter((x) => x === 'account/next-step').length - sent1}`, 'already_acted/0')
  r = await tool(c, 'pl_recovery_act', { action: 'diagnose_call' })
  t('S2 an action outside the playbook is refused (no invented repair)', `${r.code}/${r.allowed}`, 'action_not_in_playbook/send_setup')
  say(c.wa, 'still nothing')
  r = await tool(c, 'pl_recovery_act', { action: 'send_setup' })
  t('S2 attempt 2 delivered', `${r.code}/${r.recovery?.attempts_left}`, 'buttons_sent/0')
  say(c.wa, 'nope')
  const seen = publicTo(c)
  r = await tool(c, 'pl_recovery_act', { action: 'send_setup' })
  t('S2 LIMIT: attempt 3 refused, a person is required, nothing sent', `${r.code}/${r.escalate_reason}/${publicTo(c) - seen}`, 'escalation_required/playbook_exhausted/0')
  r = await tool(c, 'pl_recovery')
  t('S2 pl_recovery says escalate, with both attempts listed', `${r.must_escalate}/${r.escalate_reason}/${r.actions_attempted?.length}`, 'true/playbook_exhausted/2')
  r = await tool(c, 'pl_escalate', { reason: 'playbook_exhausted' })
  t('S2 ESCALATION REQUESTED: open (status read back), never reported as accepted', `${r.code}/${r.escalation?.state}/${r.handoff_confirmed}/${c.status}`, 'escalation_open/open/true/open')
  const pkg = c.messages.filter((m) => m.private).slice(-1)[0]?.content ?? ''
  t('S2 package says REQUESTED and open until a person accepts', /escalation REQUESTED .*Open until a person accepts/.test(pkg), true)
  t('S2 package: stage + evidence', /Stage: link_issued \(evidence: verified\)/.test(pkg), true)
  t('S2 package: both actions attempted', (pkg.match(/send_setup at /g) ?? []).length, 2)
  t('S2 package: remaining blocker', /Remaining blocker: A setup link was sent, never opened/.test(pkg), true)
  t('S2 package: next human action', /Next human action: NEXT HUMAN ACTION for link_not_opened/.test(pkg), true)
  t('S2 package: no link, token or SIP data', /https?:\/\/|sip|password|nonce/i.test(pkg), false)
  t('S2 the customer got the relay\'s own handoff line', c.customerSaw.slice(-1)[0], A.HANDOFF_TEXT)
  r = await tool(c, 'pl_escalate', { reason: 'playbook_exhausted' })
  t('S2 escalation is once per stall (still open)', `${r.code}/${r.escalation?.state}`, 'escalation_already_open/open')
  t('S2 pl_recovery reports the escalation as OPEN (requested, not accepted)', (await tool(c, 'pl_recovery')).escalation?.state, 'open')
  const after = publicTo(c)
  say(c.wa, 'hello?')
  r = await tool(c, 'pl_recovery_act', { action: 'send_setup' })
  t('S2 HUMAN OWNS IT: no automated customer reply after takeover', publicTo(c) - after, 0)
}

// ═════ S3 a person already holds the conversation: the agent sends nothing and counts nothing ═════
{ const c = customer('15550100576', 7003, 503, P('link_issued', 'link_not_opened'))
  c.status = 'open'
  say(c.wa, 'hi')
  const calls = c.plCalls.length
  let r = await tool(c, 'pl_recovery_act', { action: 'send_setup' })
  t('S3 refused: conversation not AI-owned', r.code, 'conversation_not_ai_owned')
  t('S3 no customer message, no setup send', `${publicTo(c)}/${c.plCalls.slice(calls).includes('account/next-step')}`, '0/false')
  c.status = 'pending'                                   // handed back by the person
  r = await tool(c, 'pl_recovery')
  t('S3 the refusal was not counted as a failed attempt', `${r.playbook?.attempts_used}/${r.playbook?.failures}`, '0/0')
  r = await tool(c, 'pl_recovery_act', { action: 'send_setup' })
  t('S3 POSITIVE CONTROL: after hand-back the same action runs', r.code, 'buttons_sent')
}

// ═════ S4 a failure only a person can fix: escalate at once, name the missing capability ═════
{ const c = customer('15550100577', 7004, 504, P('handed_off', 'peer_absent_from_conf'))
  say(c.wa, 'app says no line')
  let r = await tool(c, 'pl_recovery')
  t('S4 requires a person immediately', `${r.must_escalate}/${r.escalate_reason}/${r.playbook?.actions?.length}`, 'true/requires_human/0')
  t('S4 the missing capability is stated explicitly', /not an authorised agent tool/.test(r.playbook?.missing ?? ''), true)
  r = await tool(c, 'pl_recovery_act', { action: 'send_setup' })
  t('S4 no customer-side repair attempted', r.code, 'escalation_required')
  r = await tool(c, 'pl_escalate', { reason: 'requires_human' })
  t('S4 escalation open', `${r.code}/${c.status}`, 'escalation_open/open')
}

// ═════ S5 customer pause / decline stops reminders; resume restores; proactive path honours it ═════
{ const c = customer('15550100578', 7005, 505, P('link_issued', 'link_not_opened'))
  const ctl = customer('15550100579', 7006, 506, P('link_issued', 'link_not_opened'))
  say(c.wa, 'not now, maybe next week'); say(ctl.wa, 'hi')
  let r = await tool(c, 'pl_recovery_pause', { kind: 'paused' })
  t('S5 pause recorded from the customer\'s own message', r.code, 'recovery_paused')
  r = await tool(c, 'pl_recovery')
  t('S5 STOP CONDITION: customer paused', r.terminal, 'customer_paused')
  r = await tool(c, 'pl_recovery_act', { action: 'send_setup' })
  t('S5 no setup push while paused', r.code, 'customer_paused')
  t('S5 the watcher\'s stall reminder is held for the paused customer', await proactive(c, 'stalled:link_not_opened', 'rowS5'), 'stopped')
  t('S5 POSITIVE CONTROL: the same reminder still goes to a customer who did not pause', await proactive(ctl, 'stalled:link_not_opened', 'rowS5c'), 'sent')
  say(c.wa, 'ok lets continue')
  r = await tool(c, 'pl_recovery_resume')
  t('S5 resume on the customer\'s request', r.code, 'recovery_resumed')
  r = await tool(c, 'pl_recovery_act', { action: 'send_setup' })
  t('S5 after resume the playbook runs again', r.code, 'buttons_sent')
  const d = customer('15550100580', 7007, 507, P('link_issued', 'link_not_opened'))
  say(d.wa, 'no thanks, not interested')
  await tool(d, 'pl_recovery_pause', { kind: 'declined' })
  t('S5 STOP CONDITION: customer declined', (await tool(d, 'pl_recovery')).terminal, 'customer_declined')
}

// ═════ S6 escalation is not a shortcut; the customer may always ask for a person ═════
{ const c = customer('15550100581', 7008, 508, P('link_issued', 'link_not_opened'))
  say(c.wa, 'hi')
  let r = await tool(c, 'pl_escalate', { reason: 'playbook_exhausted' })
  t('S6 escalation before the playbook ran is refused', `${r.code}/${c.status}`, 'escalation_not_warranted/pending')
  say(c.wa, 'can I talk to someone')
  r = await tool(c, 'pl_escalate', { reason: 'customer_requested' })
  t('S6 the customer asking for a person always escalates', `${r.code}/${c.status}`, 'escalation_open/open')
}

// ═════ S7 fail closed: unreadable state, failed handoff ═════
{ const c = customer('15550100582', 7009, 509, P('link_issued', 'link_not_opened'))
  c.journeyFails = true
  say(c.wa, 'hi')
  let r = await tool(c, 'pl_recovery')
  t('S7 progress unreadable -> no guessing, a person decides', `${r.must_escalate}/${r.why}`, 'true/progress_unknown')
  r = await tool(c, 'pl_recovery_act', { action: 'send_setup' })
  t('S7 no action on an unreadable stage', r.code, 'progress_unknown')
  const d = customer('15550100583', 7010, 510, P('link_issued', 'link_not_opened'))
  d.toggleFails = true
  say(d.wa, 'person please')
  r = await tool(d, 'pl_escalate', { reason: 'customer_requested' })
  t('S7 handoff that did not open is NOT reported as done', `${r.code}/${d.status}`, 'escalation_unconfirmed/pending')
  t('S7 and the customer is told honestly', d.customerSaw.slice(-1)[0], A.NO_HANDOFF_TEXT)
  d.toggleFails = false
  say(d.wa, 'person please')
  r = await tool(d, 'pl_escalate', { reason: 'customer_requested' })
  t('S7 a later message can hand over (claim released)', `${r.code}/${d.status}`, 'escalation_open/open')
}

// ═════ S8 authority: gated for the working concierge, identity-bound, strict arguments ═════
{ const c = customer('15550100584', 7011, 511, P('link_issued', 'link_not_opened'))
  say(c.wa, 'hi')
  const listOn = ((await rpc(ON, 'tools/list', {})).result?.tools ?? []).map((x) => x.name)
  const listOff = (await rpc(OFF, 'tools/list', {})).result.tools.map((x) => x.name)
  t('S8 recovery tools listed when enabled', ['pl_recovery', 'pl_recovery_act', 'pl_recovery_pause', 'pl_recovery_resume', 'pl_escalate'].every((n) => listOn.includes(n)), true)
  t('S8 WORKING CONCIERGE (flag off): recovery tools not listed', listOff.some((n) => n.startsWith('pl_recovery') || n === 'pl_escalate'), false)
  t('S8 CONTROL: the existing tools are listed either way', listOff.includes('pl_journey') && listOff.includes('pl_next_step') && listOn.includes('pl_journey'), true)
  t('S8 flag off: a direct call is refused', (await tool(c, 'pl_recovery', {}, { url: OFF })).code, 'unknown_tool')
  t('S8 forged relay context -> identity_unverified', (await tool(c, 'pl_recovery_act', { action: 'send_setup' }, { key: 'WRONG' })).code, 'identity_unverified')
  t('S8 a smuggled phone number argument is refused', (await tool(c, 'pl_recovery_act', { action: 'send_setup', wa_id: '15550100599' })).code, 'invalid_arguments')
  t('S8 an action outside the enum is refused', (await tool(c, 'pl_recovery_act', { action: 'reset_sip_password' })).code, 'action_not_in_playbook')
}

// ═════ S9 TEST-ROUTE INSTANCE: instance-scoped tool + sender allowlists (owner 2026-10-18: no global flag under a test-account description) ═════
{ const TOOLS = new Set(['pl_journey', 'pl_guide', 'pl_recovery', 'pl_recovery_pause', 'pl_recovery_resume', 'pl_escalate'])
  const tester = customer('15550100590', 7090, 590, P('link_issued', 'link_not_opened'))
  const stranger = customer('15550100591', 7091, 591, P('link_issued', 'link_not_opened'))
  const TR = await listen(A.makeServer({ ...base, recoveryTools: true, toolsAllowlist: TOOLS, senderAllowlist: new Set([tester.wa]) }, db, f).server)
  say(tester.wa, 'hi'); say(stranger.wa, 'hi')
  const listed = ((await rpc(TR, 'tools/list', {})).result?.tools ?? []).map((x) => x.name).sort()
  t('S9 only the allowlisted tools are listed on the test-route instance', listed.join(','), [...TOOLS].sort().join(','))
  t('S9 sending tools are NOT offered there (pl_next_step / pl_present_offer / pl_provision / pl_recovery_act)', ['pl_next_step', 'pl_present_offer', 'pl_provision', 'pl_recovery_act'].some((n) => listed.includes(n)), false)
  const before = stranger.plCalls.length, seen = publicTo(stranger)
  let r = await tool(stranger, 'pl_recovery', {}, { url: TR })
  t('S9 REAL CUSTOMER EXCLUDED: a verified sender not on the allowlist is refused', r.code, 'sender_not_allowlisted')
  t('S9 ...and nothing was read from plsvc or sent to them', `${stranger.plCalls.length - before}/${publicTo(stranger) - seen}`, '0/0')
  r = await tool(tester, 'pl_recovery', {}, { url: TR })
  t('S9 POSITIVE CONTROL: the allowlisted tester is served', `${r.code}/${r.reason}`, 'recovery/link_not_opened')
  t('S9 a sending action is not callable on the test route', (await tool(tester, 'pl_recovery_act', { action: 'send_setup' }, { url: TR })).code, 'unknown_tool')
  // Every signed /v1/* endpoint is refused on the test-route instance, with a CORRECT signature (so the refusal is the route rule, not a bad
  // signature); the positive twin: the SAME signed proactive request is accepted by the production instance (ON).
  const sigFor = (purpose, raw) => crypto.createHmac('sha256', Buffer.from(KEY, 'utf8')).update(`${purpose}.${raw}`, 'utf8').digest('base64url')
  const pro = JSON.stringify({ kid: 'k1', wa_id: tester.wa, key: 'stalled:link_not_opened', ref: 'rowS9', iat: nowS(), nonce: crypto.randomBytes(16).toString('base64url') })
  const sentBefore = publicTo(tester)
  const proTR = await fetch(TR + '/v1/proactive', { method: 'POST', headers: { 'content-type': 'application/json', 'x-pl-proactive-signature': sigFor('pl-proactive-v1', pro) }, body: pro })
  t('S9 /v1/proactive (correctly signed) is refused on the test route', `${proTR.status}/${(await proTR.json()).error}`, '403/route_endpoints_disabled')
  t('S9 ...and the tester received nothing from it', publicTo(tester) - sentBefore, 0)
  for (const [path, hdr, purpose] of [['/v1/staff', 'x-pl-staff-signature', 'pl-staff-v1'], ['/v1/optional-contact', 'x-pl-optional-contact-signature', 'pl-optional-contact-v1']]) {
    const raw = JSON.stringify({ kid: 'k1', wa_id: tester.wa, action: 'mirror', key: 'plan_expiring', ref: 'rS9', text: 'x', iat: nowS(), nonce: crypto.randomBytes(16).toString('base64url') })
    const r9 = await fetch(TR + path, { method: 'POST', headers: { 'content-type': 'application/json', [hdr]: sigFor(purpose, raw) }, body: raw })
    t(`S9 ${path} is refused on the test route`, `${r9.status}/${(await r9.json()).error}`, '403/route_endpoints_disabled')
  }
  for (const path of ['/v1/action', '/v1/eligibility']) {
    const r9 = await fetch(TR + path, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${base.bearer}` }, body: '{}' })
    t(`S9 ${path} is refused on the test route`, `${r9.status}/${(await r9.json()).error}`, '403/route_endpoints_disabled')
  }
  const proON = JSON.stringify({ kid: 'k1', wa_id: tester.wa, key: 'stalled:link_not_opened', ref: 'rowS9p', iat: nowS(), nonce: crypto.randomBytes(16).toString('base64url') })
  const onR = await fetch(ON + '/v1/proactive', { method: 'POST', headers: { 'content-type': 'application/json', 'x-pl-proactive-signature': sigFor('pl-proactive-v1', proON) }, body: proON })
  t('S9 POSITIVE TWIN: the same signed proactive request IS accepted by the production instance (status 200)', onR.status, 200)
  const prodList = ((await rpc(ON, 'tools/list', {})).result?.tools ?? []).map((x) => x.name)
  t('S9 CONTROL: the instance WITHOUT lists still lists every tool (production behaviour unchanged)', prodList.includes('pl_next_step') && prodList.includes('pl_present_offer') && prodList.includes('pl_recovery_act'), true)
  const PL = typeof A.parseList === 'function' ? A.parseList : null
  t('S9 parseList: unset -> null (no restriction)', PL ? PL('', /x/) : 'parseList missing', null)
  let threw = false; try { if (!PL) throw 0; PL('15550100590,not-a-number', /^[1-9][0-9]{6,15}$/) } catch (e) { threw = e !== 0 }
  t('S9 parseList: one malformed entry fails CLOSED (boot error), never a silently shorter list', threw, true)
}

// ═════ run-wide proofs ═════
const privatePosts = cwLog.filter((x) => x.method === 'POST' && /\/messages$/.test(x.p) && x.body?.private)
t('P1 CONTROL the run posted private packages', privatePosts.length >= 4, true)
t('P1 every private package is free of links and long tokens', privatePosts.every((x) => !/https?:\/\//.test(x.body.content) && !/[A-Za-z0-9_-]{24,}/.test(x.body.content)), true)
t('P2 no unexpected SQL', unknownSql.length, 0)
const adapterSha = createHash('sha256').update(readFileSync(SRC)).digest('hex')
console.log('adapter sha256:', adapterSha)
for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name.padEnd(100)} got=${r.got}${r.pass ? '' : '   EXPECTED=' + r.expected}`)
if (unknownSql.length) console.log('UNKNOWN SQL:', unknownSql)
console.log(`${results.filter((r) => r.pass).length}/${results.length}`, results.every((r) => r.pass) ? 'ALL PASS' : 'SOME FAILED')
process.exit(results.every((r) => r.pass) ? 0 : 1)
