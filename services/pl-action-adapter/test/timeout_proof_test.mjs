// adapter - TIMEOUT PROOF for the staff status card (PM correction 2026-10-23).
// Question: can the card make a call that used to succeed in time (16-20 s) miss its caller's deadline? The relay aborts /v1/action at 20 s and then posts a PUBLIC fallback
// message although the setup buttons were already delivered; plsvc aborts /v1/proactive at 20 s. This drives the REAL server over HTTP (signed relay context / signed proactive),
// with a client that aborts at a deadline, a plsvc/Chatwoot that answers after a controlled delay, and a Chatwoot private-note post that NEVER answers (the worst card).
// argv: <abs path to pl-action-adapter.mjs> [control]   env: REALTIME=1 runs the true 20 s scale (slow, about 1 min) instead of the 1:6.67 scale.
//   "control" = run against the PRE-FIX artifact (2bb8b7a, which awaited the card for up to 4 s): the near-deadline scenarios are then EXPECTED to be aborted. That proves the
//   instrument can fire (a proof that never saw a timeout would prove nothing).
import crypto from 'node:crypto'
const [, , adapterPath, mode] = process.argv
const CONTROL = mode === 'control'
const A = await import('file:///' + adapterPath.replace(/\\/g, '/'))
let fails = 0, n = 0
const check = (name, ok, x = '') => { n++; if (!ok) fails++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (x ? ' | ' + x : '')) }
const REAL = process.env.REALTIME === '1'
const T = REAL ? 20000 : 3000                 // the caller's deadline (relay /v1/action, plsvc /v1/proactive)
const NEAR = REAL ? 19000 : 2700              // an operation that previously succeeded with 1 s (scaled: 0.3 s) to spare
const MID = REAL ? 17000 : 2400               // inside the 16-20 s band named by the PM

function fakeDb() {
  const g = []; let seq = 0
  return { g, async query(sql, p = []) {
    const s = sql.replace(/\s+/g, ' ').trim()
    if (s.startsWith('INSERT INTO pl_adapter_guidance')) {
      const ev = s.includes("'status'") ? 'status' : s.includes("'proactive'") ? 'proactive' : s.includes("'recovery'") ? 'recovery' : p[3]
      if (g.some((r) => r.c === p[0] && r.h === p[1] && r.m === p[2] && r.e === ev)) return { rows: [], rowCount: 0 }
      const r = { id: ++seq, c: p[0], h: p[1], m: p[2], e: ev, stage: null, t: new Date() }; g.push(r); return { rows: [{ id: r.id }], rowCount: 1 }
    }
    if (s.startsWith("UPDATE pl_adapter_guidance SET stage='status_note'")) { const r = g.find((x) => x.id === p[0]); if (r) r.stage = 'status_note'; return { rows: [], rowCount: r ? 1 : 0 } }
    if (s.startsWith('UPDATE pl_adapter_guidance SET stage')) { const r = g.find((x) => x.id === p[0]); if (r) r.stage = p[1]; return { rows: [], rowCount: r ? 1 : 0 } }
    if (s === 'DELETE FROM pl_adapter_guidance WHERE id=$1') { const i = g.findIndex((x) => x.id === p[0]); if (i >= 0) g.splice(i, 1); return { rows: [], rowCount: i >= 0 ? 1 : 0 } }
    if (s.startsWith('SELECT event, stage, message_id, created_at FROM pl_adapter_guidance WHERE cw_conversation=$1 AND wa_hash=$2 AND (event IN')) {
      const rows = g.filter((x) => x.c === p[0] && x.h === p[1] && x.e !== 'status').reverse().map((x) => ({ event: x.e, stage: x.stage, message_id: x.m, created_at: x.t })); return { rows, rowCount: rows.length }
    }
    if (/FROM pl_adapter_offer/.test(s)) return { rows: [], rowCount: 0 }
    if (s.startsWith('SELECT proactive_stopped')) return { rows: [], rowCount: 0 }
    if (s.startsWith("SELECT 1 FROM pl_adapter_guidance WHERE wa_hash=$1 AND event='recovery_pause'")) return { rows: [], rowCount: 0 }
    if (s.startsWith('SELECT 1 FROM pl_adapter_guidance')) return { rows: [], rowCount: 0 }
    throw new Error('unexpected SQL: ' + s.slice(0, 90))
  } }
}
const WA = '17670000001'
const J1 = { state: 'setup_not_activated', next_action: 'continue_setup', actions: ['continue_setup', 'human'], attention: [], registration_known: true, has_line: true, consent: { known: true, estate_suppressed: false },
  facts: { did_pretty: '+1 767 555 0102', did_masked: '+1 767 ***0102', registration: 'unregistered', softphone_activated: false, first_call_done: false, inbound_enabled: true, plan: 'trial' } }
function world({ nextStepDelayMs = 0, publicDelayMs = 0, cardHangs = true, journey = J1 } = {}) {
  const pub = [], priv = []
  const nowS = Math.floor(Date.now() / 1000)
  const f = async (url, init) => {
    const u = String(url); const ok = (b) => ({ ok: true, status: 200, json: async () => b })
    if (u.startsWith('http://pl/')) {
      const ep = u.split('/v1/')[1]
      if (ep === 'account/journey') return ok({ code: 'journey', data: journey })
      if (ep === 'account/next-step') { await new Promise((r) => setTimeout(r, nextStepDelayMs)); return ok({ code: 'buttons_sent', data: { stage: 'install', buttons: 3, include_app: true } }) }
      return ok({ code: 'bad_response' })
    }
    if (u.startsWith('http://cw/')) {
      const path = u.split('/accounts/2')[1]
      if (init?.method === 'POST') {
        const b = JSON.parse(init.body)
        if (path.endsWith('/labels')) return ok({ payload: b.labels })
        if (path.endsWith('/messages')) {
          if (b.private === true) { if (cardHangs) return new Promise(() => {}); priv.push(b); return ok({ id: 8000 + priv.length }) }
          if (publicDelayMs) await new Promise((r) => setTimeout(r, publicDelayMs))
          pub.push(b); return ok({ id: 9000 + pub.length })
        }
        return ok({ id: 1 })
      }
      if (path.startsWith('/contacts/search')) return ok({ payload: [{ id: 5 }] })
      if (path === '/contacts/5/conversations') return ok({ payload: [{ id: 77, inbox_id: 11, last_activity_at: nowS }] })
      if (path === '/contacts/5') return ok({ payload: { id: 5, contact_inboxes: [{ inbox: { id: 11 }, source_id: WA }] } })
      if (path === '/conversations/77/messages') return ok({ payload: [{ id: 100, message_type: 0, private: false, sender_type: 'Contact', source_id: 'wamid.ABCDEFGHIJKL', content: 'hi', created_at: nowS - 60 }] })
      if (path === '/conversations/77') return ok({ id: 77, inbox_id: 11, contact_id: 5, status: 'pending', labels: [] })
    }
    throw new Error('unexpected fetch ' + u)
  }
  const cfg = { plKey: 'k'.repeat(32), plKid: 'k1', plPnid: '1023804347491554', plBase: 'http://pl', cwBase: 'http://cw', cwAccount: 2, cwInbox: 11, cwToken: 't', timeoutMs: 60000, flowOnboarding: true, accountTools: true, bearer: 'b', sourceCidrs: [],
    ctxKid: 'c1', ctxKey: 'c'.repeat(32), ctxSkewS: 60, workspaceId: 'w'.repeat(36), agentId: '28a55c69-ef04-416f-9c91-7d72e9e21345', agentSlug: 'slug', onboardingLabels: true }
  return { pub, priv, cfg, f, db: fakeDb() }
}
function context(cfg) {
  const claims = { kid: 'c1', iat: Math.floor(Date.now() / 1000), nonce: crypto.randomBytes(16).toString('base64url').slice(0, 22), accountId: 2, inboxId: 11, workspaceId: cfg.workspaceId, agentId: cfg.agentId, agentSlug: cfg.agentSlug,
    chatwootConversationId: '77', chatwootMessageId: '100', messageSha256: crypto.createHash('sha256').update('hi', 'utf8').digest('hex') }
  const p = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url')
  return `v1.${p}.${crypto.createHmac('sha256', Buffer.from(cfg.ctxKey, 'utf8')).update('v1.' + p, 'utf8').digest('base64url')}`
}
const psign = (cfg, body) => crypto.createHmac('sha256', Buffer.from(cfg.plKey, 'utf8')).update(`${A.PROACTIVE_PURPOSE}.${body}`, 'utf8').digest('base64url')
/** The caller: aborts at T exactly like the relay's adapterClient (AbortSignal.timeout) - outcome is 'timeout' (=> relay posts the PUBLIC fallback) or the parsed answer. */
async function call(w, route) {
  const { server } = A.makeServer(w.cfg, w.db, w.f); await new Promise((res) => server.listen(0, '127.0.0.1', res))
  const base = `http://127.0.0.1:${server.address().port}`
  const t0 = Date.now(); let outcome
  try {
    let rs
    if (route === 'action') rs = await fetch(`${base}/v1/action`, { method: 'POST', headers: { authorization: 'Bearer b', 'content-type': 'application/json' }, body: JSON.stringify({ action: 'flow_done', context: context(w.cfg) }), signal: AbortSignal.timeout(T) })
    else { const body = JSON.stringify({ kid: 'k1', wa_id: WA, key: 'stalled:handoff_no_register', ref: 'rowT', iat: Math.floor(Date.now() / 1000), nonce: 'n'.repeat(22) }); rs = await fetch(`${base}/v1/proactive`, { method: 'POST', headers: { 'x-pl-proactive-signature': psign(w.cfg, body) }, body, signal: AbortSignal.timeout(T) }) }
    outcome = { status: rs.status, j: await rs.json() }
  } catch (e) { outcome = { timeout: e?.name === 'TimeoutError' || e?.name === 'AbortError', err: e?.name } }
  const ms = Date.now() - t0; server.closeAllConnections?.(); server.close(); return { ...outcome, ms }
}
console.log(`mode=${CONTROL ? 'CONTROL (pre-fix artifact: aborts are EXPECTED)' : 'candidate'} scale=${REAL ? 'REAL 20 s' : 'scaled'} deadline=${T}ms near=${NEAR}ms mid=${MID}ms node=${process.version}`)
const okAction = (r) => r.status === 200 && r.j?.code === 'handled' && r.j?.result?.state === 'setup_not_activated'

// P0 positive control for the instrument itself: a call slower than the deadline IS reported as a timeout (the harness can see one).
{ const w = world({ nextStepDelayMs: T + 500, cardHangs: false }); const r = await call(w, 'action')
  check('P0 instrument: a caller that waits past its deadline sees a TIMEOUT (the harness can fire)', r.timeout === true, `${r.ms}ms`) }
// A. flow_done, setup buttons take MID (17 s band), the card's Chatwoot post never answers
{ const w = world({ nextStepDelayMs: MID }); const r = await call(w, 'action')
  if (CONTROL) check('A control(pre-fix): 17 s buttons + hung card is aborted by the caller', r.timeout === true, `${r.ms}ms`)
  else check('A flow_done, buttons take the 17 s band, card hangs: answered handled+state before the deadline', okAction(r) && r.ms < T, `${r.ms}ms of ${T}ms`) }
// B. the near-timeout case: buttons took NEAR (1 s / 0.3 s spare)
{ const w = world({ nextStepDelayMs: NEAR }); const r = await call(w, 'action')
  if (CONTROL) check('B control(pre-fix): near-deadline buttons + hung card is aborted by the caller (=> relay public fallback)', r.timeout === true, `${r.ms}ms`)
  else check('B flow_done NEAR the deadline, card hangs: still answered handled+state before the deadline (no relay timeout, no public fallback)', okAction(r) && r.ms < T, `${r.ms}ms of ${T}ms`) }
// C. positive twin: with a healthy card the same near-deadline call also succeeds (the candidate is not just returning early/empty)
{ const w = world({ nextStepDelayMs: NEAR, cardHangs: false }); const r = await call(w, 'action'); for (let i = 0; i < 40 && w.priv.length < 1; i++) await new Promise((res) => setTimeout(res, 50))   // not settleStatus(): the hung cards of A/B never finish in this fake
  if (CONTROL) check('C control(pre-fix) healthy card: near-deadline flow_done answers in time (positive twin of B)', okAction(r) && r.ms < T, `${r.ms}ms`)
  else check('C CONTROL healthy card: near-deadline flow_done answers handled+state and the card is posted exactly once afterwards', okAction(r) && r.ms < T && w.priv.length === 1, `${r.ms}ms priv=${w.priv.length}`) }
// D. plsvc -> /v1/proactive: the reminder send itself takes NEAR, the card hangs
{ const w = world({ publicDelayMs: NEAR, journey: { ...J1, state: 'activated_not_registered', facts: { ...J1.facts, softphone_activated: true } } }); const r = await call(w, 'proactive')
  if (CONTROL) check('D control(pre-fix): near-deadline reminder + hung card is aborted by plsvc', r.timeout === true, `${r.ms}ms`)
  else check('D proactive reminder NEAR the deadline, card hangs: answered {code:sent} before plsvc aborts; exactly ONE customer message', r.status === 200 && r.j?.code === 'sent' && r.ms < T && w.pub.length === 1, `${r.ms}ms of ${T}ms pub=${w.pub.length} answer=${JSON.stringify(r.j ?? r)}`) }
// E. the card path never makes a customer-facing post (the buttons come from plsvc; the only public posts are the proactive reminder itself)
if (!CONTROL) { const w = world({ nextStepDelayMs: 200 }); const r = await call(w, 'action')
  check('E flow_done with a hung card: zero public posts by the adapter and still handled', w.pub.length === 0 && okAction(r), `pub=${w.pub.length}`) }
console.log(`${n - fails}/${n} ${fails ? 'SOME FAILED' : 'ALL PASS'}`)
process.exit(fails ? 1 : 0)
