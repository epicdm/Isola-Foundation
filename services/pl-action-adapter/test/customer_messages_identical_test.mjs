// adapter - CUSTOMER-VISIBLE OUTPUT IDENTITY: the status card must change nothing the customer receives (PM 2026-10-23).
// Compared per scenario: the full body of every PUBLIC Chatwoot post, the endpoint + full request body of every PL-service call, the HTTP status and the answer. NOT compared: private notes and labels (staff-only; the card is
// private by design - and labels are off), response headers, timing, WhatsApp-side delivery. Runs the SAME scenarios through the REAL HTTP routes (/v1/action flow_done for every journey state; /v1/proactive for every key x state) against a BASELINE artifact (the deployed
// 15c701c file) and the CANDIDATE, then compares every PUBLIC Chatwoot post (text + buttons) and every call made to the PL service, scenario by scenario. Labels are at their default (off).
// CONTROL: a copy of the candidate with ONE customer-facing word changed must be reported as different (a comparison that cannot see a difference proves nothing).
// usage: node customer_messages_identical_test.mjs <candidate.mjs> <baseline.mjs>      (internal: ... --driver <artifact.mjs> prints the scenario results as JSON)
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const argv = process.argv.slice(2)
const THIS = fileURLToPath(import.meta.url)

if (argv[0] === '--driver') {
  const A = await import('file:///' + argv[1].replace(/\\/g, '/'))
  const WA = '17670000001'
  const ACT = { setup_not_activated: ['continue_setup', 'human'], activated_not_registered: ['check_connection', 'continue_setup', 'human'], registered_no_call: ['how_to_call', 'troubleshoot', 'human'],
    active: ['balance', 'recent_calls', 'calling_help'], attention: ['balance', 'plans', 'human'], no_line: ['get_number', 'how_it_works', 'plans'] }
  const facts = (o) => ({ did_pretty: '+1 767 555 0102', did_masked: '+1 767 ***0102', registration: 'unregistered', softphone_activated: false, first_call_done: false, inbound_enabled: true, plan: 'trial', plan_name: 'Free Trial',
    minutes_included: 60, minutes_remaining: 52, low: false, wallet_xcd: '0.00', pool: 'dominica', ...o })
  const J = (state, o = {}) => ({ state, next_action: ACT[state][0], actions: ACT[state], attention: [], registration_known: true, has_line: state !== 'no_line', consent: { known: true, estate_suppressed: false }, facts: state === 'no_line' ? null : facts(o) })
  const JS = { setup_not_activated: J('setup_not_activated'), activated_not_registered: J('activated_not_registered', { softphone_activated: true }), registered_no_call: J('registered_no_call', { registration: 'reachable', softphone_activated: true }),
    active: J('active', { registration: 'registered', softphone_activated: true, first_call_done: true }), attention: J('attention', { registration: 'registered', softphone_activated: true, first_call_done: true, low: true, minutes_remaining: 4 }), no_line: J('no_line') }
  function fakeDb() {
    const g = []; let seq = 0
    return { g, async query(sql, p = []) {
      const s = sql.replace(/\s+/g, ' ').trim()
      if (s.startsWith('INSERT INTO pl_adapter_guidance')) {
        const ev = s.includes("'status'") ? 'status' : s.includes("'proactive'") ? 'proactive' : s.includes("'recovery'") ? 'recovery' : p[3]
        if (g.some((r) => r.c === p[0] && r.h === p[1] && r.m === p[2] && r.e === ev)) return { rows: [], rowCount: 0 }
        const r = { id: ++seq, c: p[0], h: p[1], m: p[2], e: ev, stage: null, t: new Date() }; g.push(r); return { rows: [{ id: r.id }], rowCount: 1 }
      }
      if (s.startsWith('UPDATE pl_adapter_guidance SET stage')) { const r = g.find((x) => x.id === p[0]); if (r) r.stage = p[1] ?? 'status_note'; return { rows: [], rowCount: r ? 1 : 0 } }
      if (s === 'DELETE FROM pl_adapter_guidance WHERE id=$1') { const i = g.findIndex((x) => x.id === p[0]); if (i >= 0) g.splice(i, 1); return { rows: [], rowCount: i >= 0 ? 1 : 0 } }
      if (s.startsWith('SELECT event, stage, message_id, created_at FROM pl_adapter_guidance')) return { rows: [], rowCount: 0 }
      return { rows: [], rowCount: 0 }
    } }
  }
  function world(j) {
    const pub = [], priv = [], plCalls = []
    const nowS = Math.floor(Date.now() / 1000)
    const f = async (url, init) => {
      const u = String(url); const ok = (b) => ({ ok: true, status: 200, json: async () => b })
      if (u.startsWith('http://pl/')) {
        const ep = u.split('/v1/')[1]; plCalls.push({ ep, body: init?.body ? JSON.parse(init.body) : null })
        if (ep === 'account/journey') return ok({ code: 'journey', data: j })
        if (ep === 'account/next-step') return ok({ code: 'buttons_sent', data: { stage: 'install', buttons: 3, include_app: true } })
        if (ep === 'flows/launch') return ok({ code: 'flow_sent', data: { existing_line: j?.has_line === true } })
        return ok({ code: 'bad_response' })
      }
      if (u.startsWith('http://cw/')) {
        const p = u.split('/accounts/2')[1]
        if (init?.method === 'POST') {
          const b = JSON.parse(init.body)
          if (p.endsWith('/labels')) return ok({ payload: b.labels })
          if (p.endsWith('/messages')) { if (b.private === true) { priv.push(b); return ok({ id: 8000 + priv.length }) } pub.push(b); return ok({ id: 9000 + pub.length }) }
          return ok({ id: 1 })
        }
        if (p.startsWith('/contacts/search')) return ok({ payload: [{ id: 5 }] })
        if (p === '/contacts/5/conversations') return ok({ payload: [{ id: 77, inbox_id: 11, last_activity_at: nowS }] })
        if (p === '/contacts/5') return ok({ payload: { id: 5, contact_inboxes: [{ inbox: { id: 11 }, source_id: WA }] } })
        if (p === '/conversations/77/messages') return ok({ payload: [{ id: 100, message_type: 0, private: false, sender_type: 'Contact', source_id: 'wamid.ABCDEFGHIJKL', content: 'hi', created_at: nowS - 60 }] })
        if (p === '/conversations/77') return ok({ id: 77, inbox_id: 11, contact_id: 5, status: 'pending', labels: [] })
      }
      throw new Error('unexpected fetch ' + u)
    }
    const cfg = { plKey: 'k'.repeat(32), plKid: 'k1', plPnid: '1023804347491554', plBase: 'http://pl', cwBase: 'http://cw', cwAccount: 2, cwInbox: 11, cwToken: 't', timeoutMs: 5000, flowOnboarding: true, accountTools: true, bearer: 'b', sourceCidrs: [],
      ctxKid: 'c1', ctxKey: 'c'.repeat(32), ctxSkewS: 60, workspaceId: 'w'.repeat(36), agentId: '28a55c69-ef04-416f-9c91-7d72e9e21345', agentSlug: 'slug' }
    return { pub, priv, plCalls, cfg, f, db: fakeDb() }
  }
  const context = (cfg) => {
    const claims = { kid: 'c1', iat: Math.floor(Date.now() / 1000), nonce: crypto.randomBytes(16).toString('base64url').slice(0, 22), accountId: 2, inboxId: 11, workspaceId: cfg.workspaceId, agentId: cfg.agentId, agentSlug: cfg.agentSlug,
      chatwootConversationId: '77', chatwootMessageId: '100', messageSha256: crypto.createHash('sha256').update('hi', 'utf8').digest('hex') }
    const p = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url')
    return `v1.${p}.${crypto.createHmac('sha256', Buffer.from(cfg.ctxKey, 'utf8')).update('v1.' + p, 'utf8').digest('base64url')}`
  }
  const psign = (cfg, body) => crypto.createHmac('sha256', Buffer.from(cfg.plKey, 'utf8')).update(`${A.PROACTIVE_PURPOSE}.${body}`, 'utf8').digest('base64url')
  const out = []
  const run = async (name, j, route, key) => {
    const w = world(j); const { server } = A.makeServer(w.cfg, w.db, w.f); await new Promise((res) => server.listen(0, '127.0.0.1', res))
    const base = `http://127.0.0.1:${server.address().port}`
    let rs
    if (route === 'action') rs = await fetch(`${base}/v1/action`, { method: 'POST', headers: { authorization: 'Bearer b', 'content-type': 'application/json' }, body: JSON.stringify({ action: 'flow_done', context: context(w.cfg) }) })
    else { const body = JSON.stringify({ kid: 'k1', wa_id: WA, key, ref: 'rowD', iat: Math.floor(Date.now() / 1000), nonce: 'n'.repeat(22) }); rs = await fetch(`${base}/v1/proactive`, { method: 'POST', headers: { 'x-pl-proactive-signature': psign(w.cfg, body) }, body }) }
    const j2 = await rs.json().catch(() => null)
    await (A.settleStatus?.() ?? Promise.resolve())
    server.close()
    // the response is compared WITHOUT the added result.state (the one intended addition) and the PL calls WITHOUT nothing removed: they must be identical
    if (j2?.result && 'state' in j2.result && route === 'action') { const { state, ...rest } = j2.result; j2.result = rest; j2._stateAdded = typeof state === 'string' }
    out.push({ name, status: rs.status, answer: j2, publicPosts: w.pub, plCalls: w.plCalls })
  }
  for (const st of Object.keys(JS)) await run(`flow_done @ ${st}`, JS[st], 'action')
  for (const key of ['activated', 'first_call', 'stalled:handoff_no_register', 'stalled:link_not_opened', 'stalled:no_handoff', 'stalled:peer_absent_from_conf'])
    for (const st of ['setup_not_activated', 'activated_not_registered', 'registered_no_call', 'active']) await run(`proactive ${key} @ ${st}`, JS[st], 'proactive', key)
  process.stdout.write(JSON.stringify(out))
  process.exit(0)
}

// ── runner ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const [cand, base] = argv
let fails = 0, n = 0
const check = (name, ok, x = '') => { n++; if (!ok) fails++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (x ? ' | ' + x : '')) }
const drive = (p) => { const r = spawnSync(process.execPath, [THIS, '--driver', p], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }); if (r.status !== 0) throw new Error('driver failed: ' + (r.stderr || '').slice(0, 400)); return JSON.parse(r.stdout) }
const R_cand = drive(cand), R_base = drive(base)
const diffs = (a, b) => a.map((x, i) => (JSON.stringify([x.name, x.status, x.answer && { ...x.answer, _stateAdded: undefined }, x.publicPosts, x.plCalls]) === JSON.stringify([b[i].name, b[i].status, b[i].answer && { ...b[i].answer, _stateAdded: undefined }, b[i].publicPosts, b[i].plCalls]) ? null : x.name)).filter(Boolean)
const crypto2 = crypto
const baseLf = fs.readFileSync(base, 'utf8').split('\r\n').join('\n')
check('the baseline IS the deployed 15c701c file (LF sha256 prefix 79bb9b517ea9bde4; its CRLF form is the running host file ed6612ee82e03807)', crypto2.createHash('sha256').update(baseLf).digest('hex').startsWith('79bb9b517ea9bde4'))
check(`scenarios ran: ${R_cand.length} candidate / ${R_base.length} baseline`, R_cand.length === R_base.length && R_cand.length >= 30)
const withPosts = R_base.filter((x) => x.publicPosts.length > 0).length, withCalls = R_base.filter((x) => x.plCalls.length > 0).length
check('instrument: the baseline scenarios really produce customer-visible posts and PL calls (not an empty comparison)', withPosts >= 10 && withCalls >= 10, `scenarios with public posts=${withPosts}, with PL calls=${withCalls}`)
const d = diffs(R_cand, R_base)
check('IDENTITY: every public post (the WHOLE request body: text, buttons, type, attributes), every PL-service call (endpoint AND request body), every HTTP status and answer is identical to the deployed file in every scenario', d.length === 0, d.length ? 'DIFFERENT: ' + d.join('; ') : `${R_cand.length} scenarios identical`)
const addedOnly = R_cand.filter((x) => x.name.startsWith('flow_done') && x.answer?.code === 'handled').every((x) => x.answer._stateAdded === true)
check('the one intended addition: every handled flow_done now carries the journey state (baseline carried it only on the fall-through path)', addedOnly && R_cand.some((x) => x.answer?._stateAdded))
// CONTROL: change one customer-facing word in a copy of the candidate; the comparison must see it
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cmi-')); const mut = path.join(tmp, 'mutant.mjs')
const src = fs.readFileSync(cand, 'utf8'); const needle = 'Continue setup'
fs.writeFileSync(mut, src.replace(needle, 'Continue set-up'))
check('control: the mutation target exists in the candidate', src.includes(needle))
const dm = diffs(drive(mut), R_base)
check('CONTROL: a candidate with ONE customer-facing word changed IS reported as different (the comparison can fail)', dm.length > 0, `${dm.length} scenarios differ`)
fs.rmSync(tmp, { recursive: true, force: true })
console.log(`${n - fails}/${n} ${fails ? 'SOME FAILED' : 'ALL PASS'}`)
process.exit(fails ? 1 : 0)
