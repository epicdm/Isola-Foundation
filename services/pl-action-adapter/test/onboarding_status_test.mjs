// adapter - Personal Line onboarding status card for staff + flow_done carries the journey state (owner chunk 2026-10-23).
// Isolated: no model, no network, no real customer, FICTIONAL identities only. argv: <abs path to pl-action-adapter.mjs>
// The fakes record every Chatwoot write (public vs private, labels) and every SQL statement. Every absence assertion has a positive twin.
import crypto from 'node:crypto'
const [, , adapterPath] = process.argv
const A = await import('file:///' + adapterPath.replace(/\\/g, '/'))
let fails = 0, n = 0
const check = (name, ok, x = '') => { n++; if (!ok) fails++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (x ? ' | ' + x : '')) }

const PAY = { topup_available: false, rail: 'fiserv', reason: 'fiserv_topup_not_available_in_chat' }
const OKC = { estate_suppressed: false, known: true }
const facts = (o) => ({ did_pretty: '+1 767 555 0102', did_masked: '+1 767 ***0102', registration: 'unregistered', softphone_activated: false, first_call_done: false, inbound_enabled: true, plan: 'trial', minutes_remaining: 60, minutes_included: 60, ...o })
const ACT = { setup_not_activated: ['continue_setup', 'human'], activated_not_registered: ['check_connection', 'continue_setup', 'human'], registered_no_call: ['how_to_call', 'troubleshoot', 'human'], active: ['balance', 'recent_calls', 'calling_help'], no_line: ['get_number', 'how_it_works', 'plans'] }
const J = (state, o = {}) => ({ state, next_action: ACT[state][0], actions: ACT[state], attention: [], registration_known: true, has_line: state !== 'no_line', facts: state === 'no_line' ? null : facts(o), payment: PAY, consent: OKC })
const JS = {
  setup_not_activated: J('setup_not_activated'),
  activated_not_registered: J('activated_not_registered', { softphone_activated: true }),
  registered_no_call: J('registered_no_call', { registration: 'reachable', softphone_activated: true }),
  active: J('active', { registration: 'registered', softphone_activated: true, first_call_done: true }),
  no_line: J('no_line'),
}

function fakeDb({ failHistory = false } = {}) {
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
      if (failHistory) throw new Error('history unreadable')
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
function world({ j, status = 'pending', labels = [], labelsUnreadable = false, failPrivatePost = false, failHistory = false, nextStep = null, lastInboundAgoS = 60, hangPrivate = false, rereadFails = false, labelsOn = true, slowPrivateMs = 0 } = {}) {
  let convGets = 0
  const pub = [], priv = [], labelWrites = [], calls = []
  const state = { labels: [...labels], status }
  const nowS = Math.floor(Date.now() / 1000)
  const f = async (url, init) => {
    const u = String(url); const ok = (b) => ({ ok: true, status: 200, json: async () => b })
    if (u.startsWith('http://pl/')) {
      const ep = u.split('/v1/')[1]; calls.push(ep)
      if (ep === 'account/journey') return ok({ code: 'journey', data: j })
      if (ep === 'account/next-step') return ok(nextStep ?? { code: 'buttons_sent', data: { stage: 'install', buttons: 3, include_app: true } })
      if (ep === 'flows/launch') return ok({ code: 'flow_sent', data: { existing_line: j?.has_line === true } })
      if (ep === 'lines/provision') return ok({ code: 'line_created', data: {} })
      return ok({ code: 'bad_response' })
    }
    if (u.startsWith('http://cw/')) {
      const path = u.split('/accounts/2')[1]
      if (init?.method === 'POST') {
        const b = JSON.parse(init.body)
        if (path.endsWith('/labels')) { labelWrites.push(b.labels); state.labels = [...b.labels]; return ok({ payload: b.labels }) }
        if (path.endsWith('/messages')) {
          if (b.private === true) { if (hangPrivate) return new Promise(() => {}); if (slowPrivateMs) await new Promise((r) => setTimeout(r, slowPrivateMs)); if (failPrivatePost) return { ok: false, status: 500, json: async () => ({}) }; priv.push(b); return ok({ id: 8000 + priv.length }) }
          pub.push(b); return ok({ id: 9000 + pub.length })
        }
        return ok({ id: 1 })
      }
      if (path.startsWith('/contacts/search')) return ok({ payload: [{ id: 5 }] })
      if (path === '/contacts/5/conversations') return ok({ payload: [{ id: 77, inbox_id: 11, last_activity_at: nowS }] })
      if (path === '/contacts/5') return ok({ payload: { id: 5, contact_inboxes: [{ inbox: { id: 11 }, source_id: WA }] } })
      if (path === '/conversations/77/messages') return ok({ payload: [{ id: 100, message_type: 0, private: false, sender_type: 'Contact', source_id: 'wamid.ABCDEFGHIJKL', content: 'hi', created_at: nowS - lastInboundAgoS }] })
      if (path === '/conversations/77') return ok(labelsUnreadable || (rereadFails && priv.length > 0 && ++convGets > 1) ? { id: 77, inbox_id: 11, status: state.status } : { id: 77, inbox_id: 11, status: state.status, labels: state.labels })
    }
    throw new Error('unexpected fetch ' + u)
  }
  const cfg = { plKey: 'k'.repeat(32), plKid: 'k1', plPnid: '1023804347491554', plBase: 'http://pl', cwBase: 'http://cw', cwAccount: 2, cwInbox: 11, cwToken: 't', timeoutMs: 1000, flowOnboarding: true, accountTools: true, bearer: 'b', sourceCidrs: [], ctxKid: 'c1', ctxKey: 'c'.repeat(32), workspaceId: 'w'.repeat(36), agentId: '28a55c69-ef04-416f-9c91-7d72e9e21345', agentSlug: 'slug', onboardingLabels: labelsOn }
  const db = fakeDb({ failHistory })
  // The status card is DETACHED from the caller (it never waits for Chatwoot), so tests that assert on the card settle the detached work first. A hanging Chatwoot is never settled.
  const hh = A.makeHandlers(cfg, db, {}, f)
  const h = { ...hh, _runAction: async (...a) => { const r = await hh._runAction(...a); if (!hangPrivate) await A.settleStatus(); return r } }
  return { pub, priv, labelWrites, calls, db, cfg, f, state, h, hRaw: hh, hang: hangPrivate }
}
const who = (mid = 'fd1') => ({ waId: WA, wamid: 'wamid.T1234567890', conversationId: '77', messageId: mid, content: '' })
const noUrl = (t) => !/https?:\/\//i.test(t) && !/[A-Za-z0-9_-]{24,}/.test(t)
// The honest sentences ("...not recorded") are removed first; the instrument is proven by the section-0 controls (it still fires on real overclaims).
const HONEST = [/Working service: YES - an answered call is on record\./g, /[Ww]hether the customer opened it is not recorded\./g, /whether it was opened is not recorded\./g, /Delivered\/read: not recorded\./g]
const overclaim = (t) => /\b(was|were|been|is|are|got) (delivered|read|seen)\b|opened it\b|customer opened|verified (the )?(customer|activation)|is working/i.test(HONEST.reduce((x, re) => x.replace(re, ''), t))
const sign = (cfg, body) => crypto.createHmac('sha256', Buffer.from(cfg.plKey, 'utf8')).update(`${A.PROACTIVE_PURPOSE}.${body}`, 'utf8').digest('base64url')
async function proactive(w, key, ref = 'row1') {
  const body = JSON.stringify({ kid: w.cfg.plKid, wa_id: WA, key, ref, iat: Math.floor(Date.now() / 1000), nonce: 'n'.repeat(22) })
  const v = A.verifyProactive(body, sign(w.cfg, body), w.cfg); if (!v.ok) return { code: 'unauthorized:' + v.why }
  const r = await A.handleProactive(w.cfg, w.db, {}, v.b, w.f); if (!w.hang) await A.settleStatus(); return r
}

// ── 0. instrument self-check: the overclaim detector must fire on a deliberately bad sentence (law 11/19) ────────────────────────────
check('0 CONTROL overclaim detector fires on "buttons were delivered"', overclaim('Setup buttons were delivered to the customer'))
check('0 CONTROL overclaim detector fires on "customer opened it"', overclaim('The customer opened it at 14:20'))
check('0 CONTROL overclaim detector stays quiet on the honest sentence', !overclaim('buttons ACCEPTED by the WhatsApp API. Delivered/read: not recorded.'))

// ── 1. the 6400 shape: form completed, line provisioned, buttons accepted, activation incomplete ─────────────────────────────────
{
  const w = world({ j: JS.setup_not_activated, labels: ['vip'] })
  const r = await w.h._runAction(who('fd1'), 'flow_done')
  check('1 flow_done @ setup_not_activated returns the KNOWN state (relay no longer prints unknown)', r.ok && r.result.code === 'buttons_sent' && r.result.state === 'setup_not_activated', JSON.stringify({ code: r.result?.code, state: r.result?.state }))
  check('1 exactly ONE private status note, ZERO public messages from the adapter (buttons are sent by the PL service)', w.priv.length === 1 && w.pub.length === 0)
  const t = w.priv[0]?.content ?? ''
  for (const [name, re] of [['form completed (form report only)', /Signup form: completed according to the form's own report/], ['line provisioned', /Line provisioned: YES \(\+1 767 \*\*\*0102\)/], ['setup message ACCEPTED, delivery/read not recorded', /ACCEPTED by the WhatsApp API at .*Delivered\/read: not recorded/],
    ['activation incomplete', /Activation: NOT complete - no hand-off/], ['link open not recorded', /whether it was opened is not recorded/], ['registration absent at check', /Phone registration: ABSENT at the check above/],
    ['last automated action', /Last automated action: setup buttons to the customer at /], ['working service not claimed', /Working service: NOT claimed/], ['no human help requested', /Human help: none requested/], ['awaiting customer, no assignee implied', /Next: AWAITING CUSTOMER .* No assignee is implied/], ['source and as-of time', /as of \d{4}-\d{2}-\d{2} \d{2}:\d{2}Z[\s\S]*Source: PL service journey read/]])
    check(`1 note states: ${name}`, re.test(t))
  check('1 note never overclaims delivery / opening / activation / working service', !overclaim(t), t.split('\n').filter((l) => overclaim(l)).join(' // '))
  check('1 note carries no link and no token-like string', noUrl(t))
  check('1 awaiting label added AND the staff label kept (labels endpoint replaces the set)', w.labelWrites.length === 1 && w.labelWrites[0].includes('vip') && w.labelWrites[0].includes(A.ONBOARDING_AWAITING_LABEL) && !w.labelWrites[0].includes(A.ONBOARDING_FAULT_LABEL), JSON.stringify(w.labelWrites))
  // repeated completion event (same Chatwoot message id): nothing duplicated
  const r2 = await w.h._runAction(who('fd1'), 'flow_done')
  check('1 repeated completion event: no second note, no second label write, no second buttons request', r2.ok && w.priv.length === 1 && w.labelWrites.length === 1 && w.calls.filter((c) => c === 'account/next-step').length === 1)
  check('1 CONTROL a NEW completion event is its own event (second note posted)', (await w.h._runAction(who('fd2'), 'flow_done')).ok && w.priv.length === 2)
}

// ── 2. other states: state returned, honest wording, labels cleared once connected ──────────────────────────────────────────────
for (const [s, re, label] of [
  ['activated_not_registered', /Activation: line handed to Cloud Softphone \(recorded\); the phone has not connected yet\./, true],
  ['registered_no_call', /Activation: complete \(the phone has registered\)[\s\S]*Working service: NOT claimed .*no answered call yet/, false],
  ['active', /Working service: YES - an answered call is on record\.[\s\S]*Next: None - line working\./, false],
  ['no_line', /Line provisioned: NO account or line found[\s\S]*Activation: not started/, false],
]) {
  const w = world({ j: JS[s], labels: ['vip', A.ONBOARDING_AWAITING_LABEL] })
  const r = await w.h._runAction(who(`fd-${s}`), 'flow_done')
  const t = w.priv[0]?.content ?? ''
  check(`2 ${s}: state returned and note states ${re.source.slice(0, 40)}...`, r.ok && r.result.state === s && re.test(t) && !overclaim(t), t.split('\n').slice(2, 9).join(' | ').slice(0, 260))
  const last = w.labelWrites.at(-1)
  check(`2 ${s}: ${label ? 'awaiting label kept' : 'awaiting label CLEARED'}, staff label kept`, label ? (w.labelWrites.length === 0 && w.state.labels.includes(A.ONBOARDING_AWAITING_LABEL)) : (last && !last.includes(A.ONBOARDING_AWAITING_LABEL) && last.includes('vip')), JSON.stringify(w.labelWrites))
}

// ── 3. the registration watch's stalled verdict: reminder + refreshed card, still no overclaim ───────────────────────────────────
{
  const w = world({ j: JS.setup_not_activated })
  await w.h._runAction(who('fd1'), 'flow_done')
  const r = await proactive(w, 'stalled:no_handoff', 'rowA')
  check('3 stalled:no_handoff -> ONE public reminder (existing behaviour) and a second status card', r.code === 'sent' && w.pub.length === 1 && w.priv.length === 2)
  const t = w.priv[1]?.content ?? ''
  check('3 card: link EXPIRED without a hand-off, opening not recorded, reminder named as last automated action', /Setup link: EXPIRED without a hand-off/.test(t) && /whether the customer opened it is not recorded/i.test(t) && /Last automated action: link-expired reminder to the customer at /.test(t) && /AWAITING CUSTOMER/.test(t) && !overclaim(t))
  check('3 card does not say the customer verified or opened anything', !/verified on the setup page/i.test(t) && !/customer verified/i.test(t))
  const again = await proactive(w, 'stalled:no_handoff', 'rowA')
  check('3 same verdict twice: no second reminder, no second card', again.code === 'duplicate' && w.pub.length === 1 && w.priv.length === 2)
}

// ── 4. technical fault vs awaiting customer, and human help ─────────────────────────────────────────────────────────────────────────
{
  const w = world({ j: JS.activated_not_registered, labels: [A.ONBOARDING_AWAITING_LABEL] })
  const r = await proactive(w, 'stalled:peer_absent_from_conf', 'rowP')
  const t = w.priv.map((x) => x.content).join('\n')
  // Codex review 2026-10-23 (finding 1): the existing note already carries the fault, so a second note was a duplicate. Deliberate: ONE note, label only.
  check('4 peer absent: exactly ONE private note (the existing one, no second card); NO customer message', r.code === 'sent' && w.priv.length === 1 && w.pub.length === 0 && !w.db.g.some((x) => x.e === 'status'))
  check('4 peer absent: the one note is the existing fault note, not an awaiting-customer card', /pl-awaiting|AWAITING CUSTOMER/.test(w.priv[0]?.content ?? '') === false && w.priv[0]?.content.length > 0)
  check('4 peer absent: fault label added, awaiting label removed', w.labelWrites.at(-1)?.includes(A.ONBOARDING_FAULT_LABEL) && !w.labelWrites.at(-1)?.includes(A.ONBOARDING_AWAITING_LABEL), JSON.stringify(w.labelWrites))
}
{
  const w = world({ j: JS.setup_not_activated })
  w.db.g.push({ id: 900, c: '77', h: A.waHash ? A.waHash(w.cfg, WA) : null, m: 'esc:x', e: 'recovery', stage: 'escalation_open|playbook_exhausted', t: new Date() })
  // the adapter hashes the wa id itself; seed through the same function the handlers use
  const hh = (await (async () => { const probe = world({ j: JS.setup_not_activated }); await probe.h._runAction(who('probe'), 'flow_done'); return probe.db.g[0].h })())
  w.db.g[0].h = hh
  await w.h._runAction(who('fd9'), 'flow_done')
  const t = w.priv[0]?.content ?? ''
  check('4 human help requested: shown as REQUESTED, acceptance explicitly NOT tracked here (no still-open claim), next party is a person, no awaiting label', /Human help: REQUESTED at .*Whether a person has accepted it is NOT tracked in this note - check the thread for a staff reply or the label pl-stall-accepted/.test(t) && !/still OPEN/.test(t) && /Next: HUMAN HELP REQUESTED - confirm in the thread/.test(t) && !w.labelWrites.some((l) => l.includes(A.ONBOARDING_AWAITING_LABEL)))
  const ctl = world({ j: JS.setup_not_activated }); await ctl.h._runAction(who('fd9'), 'flow_done')
  check('4 CONTROL without an escalation row the same journey says none requested', /Human help: none requested/.test(ctl.priv[0]?.content ?? ''))
}

// ── 5. unknown only where evidence is genuinely unavailable; failures isolated ─────────────────────────────────────────────────
{
  const w = world({ j: JS.setup_not_activated, failHistory: true })
  const r = await w.h._runAction(who('fd1'), 'flow_done'); const t = w.priv[0]?.content ?? ''
  check('5 send history unreadable: card says unknown for those rows, not a guess', r.ok && /Setup message: send history unreadable \(unknown\)/.test(t) && /Last automated action: history unreadable \(unknown\)/.test(t))
  check('5 CONTROL history readable: same journey states the buttons time (no unknown)', !/unreadable/.test((await (async () => { const c = world({ j: JS.setup_not_activated }); await c.h._runAction(who('fd1'), 'flow_done'); return c.priv[0].content })())))
}
{
  const w = world({ j: JS.setup_not_activated, failPrivatePost: true })
  const r = await w.h._runAction(who('fd1'), 'flow_done')
  check('5 private note cannot be posted: flow_done still returns ok with the state (card is additive)', r.ok && r.result.state === 'setup_not_activated' && w.priv.length === 0)
  w.state.status = 'pending'
  const retry = world({ j: JS.setup_not_activated }); const r1 = await retry.h._runAction(who('fd1'), 'flow_done')
  check('5 CONTROL same event with a healthy Chatwoot posts the card (so the failure above was the cause)', r1.ok && retry.priv.length === 1)
  check('5 failed post released its claim (a later event can retry)', w.db.g.filter((x) => x.e === 'status').length === 0)
}
{   // Codex review finding 2: an unreadable/absent registration value must read 'unknown', not 'ABSENT'; a known value still reads ABSENT (positive twin)
  const unk = A.composeOnboardingStatus({ j: J('setup_not_activated', { registration: null }), hist: [] }).text
  const unk2 = A.composeOnboardingStatus({ j: { ...J('setup_not_activated'), registration_known: false }, hist: [] }).text
  const known = A.composeOnboardingStatus({ j: J('setup_not_activated', { registration: 'unregistered' }), hist: [] }).text
  check('4b registration null / registration_known=false -> unknown, never ABSENT', /Phone registration: unknown/.test(unk) && /Phone registration: unknown/.test(unk2) && !/ABSENT/.test(unk + unk2))
  check('4b CONTROL known value unregistered -> ABSENT (the unknown branch did not swallow it)', /Phone registration: ABSENT/.test(known))
}
{   // Codex review finding 3: the label write is skipped when the fresh re-read fails (no write from an older snapshot); control = readable -> written
  const w = world({ j: JS.setup_not_activated, labels: ['vip'], rereadFails: true })
  await w.h._runAction(who('fd1b'), 'flow_done')
  const ctl = world({ j: JS.setup_not_activated, labels: ['vip'] })
  await ctl.h._runAction(who('fd1c'), 'flow_done')
  check('5b re-read fails after the first read: note posted, labels NOT written', w.priv.length === 1 && w.labelWrites.length === 0)
  check('5b CONTROL re-read works: labels written with the staff label kept', ctl.labelWrites.length === 1 && ctl.labelWrites[0].includes('vip') && ctl.labelWrites[0].includes(A.ONBOARDING_AWAITING_LABEL))
}
{
  const w = world({ j: JS.setup_not_activated, labels: ['vip'], labelsUnreadable: true })
  await w.h._runAction(who('fd1'), 'flow_done')
  check('5 labels unreadable: note still posted, labels NOT written (never overwrite the set)', w.priv.length === 1 && w.labelWrites.length === 0)
}
{
  const w = world({ j: JS.setup_not_activated, nextStep: { code: 'link_rate_limited', data: {} } })
  const r = await w.h._runAction(who('fd1'), 'flow_done')
  check('5 buttons refused by the PL service (nothing sent): falls through to the completion message, state still reported', r.ok && r.result.state === 'setup_not_activated')
}

// ── 6. wording of the stall playbook ──────────────────────────────────────────────────────────────────────────────────────────
check('6 no_handoff playbook no longer claims the customer verified anything', !/verified on the setup page/i.test(A.RECOVERY_PLAYBOOKS.no_handoff.observe) && /not recorded/.test(A.RECOVERY_PLAYBOOKS.no_handoff.observe), A.RECOVERY_PLAYBOOKS.no_handoff.observe)
check('6 CONTROL link_not_opened (tracked-only reason) wording unchanged', /never opened/.test(A.RECOVERY_PLAYBOOKS.link_not_opened.observe))

// ── 7. pure composer: no state yields an overclaim, no input throws ───────────────────────────────────────────────────────────
for (const s of Object.keys(JS)) for (const kind of ['flow_done', 'stalled', 'peer_absent', 'event']) {
  let t = ''; try { t = A.composeOnboardingStatus({ j: JS[s], hist: [], trigger: { kind, key: 'stalled:no_handoff' }, nowMs: Date.parse('2026-10-23T14:36:00Z') }).text } catch (e) { t = 'THROW ' + e.message }
  check(`7 composer ${s}/${kind}: no throw, no overclaim, no link, within the note limit`, !t.startsWith('THROW') && !overclaim(t) && noUrl(t) && t.length <= 1500, t.slice(0, 60))
}
check('7 composer with a missing journey does not throw and says unknown', /unknown/.test(A.composeOnboardingStatus({ j: null, hist: null, trigger: {}, nowMs: Date.now() }).text))

// ── 8. Continue setup / resend: resumes the EXISTING account; never signs up again or creates another line ──────────────────────
// Production taps go to the agent (PL_DETERMINISTIC_TAPS=0), whose tool for a tap is pl_next_step; pl_provision is the only provisioning tool.
{
  const w = world({ j: JS.setup_not_activated })
  const r = await w.h.pl_next_step(who('tap1'), { event: 'resend' })
  check('8 Continue setup (line holder): ONE next-step request asking for the setup buttons', r.ok && r.result.code === 'buttons_sent' && w.calls.filter((c) => c === 'account/next-step').length === 1)
  check('8 ...and NO signup Flow, NO provisioning request (no second line, no second DID)', !w.calls.includes('flows/launch') && !w.calls.includes('lines/provision') && w.pub.length === 0)
  const body = w.calls.length
  await w.h.pl_next_step(who('tap1'), { event: 'resend' })
  check('8 the same tap delivered twice: no second request to the PL service', w.calls.filter((c) => c === 'account/next-step').length === 1 && w.calls.length >= body)
  await w.h.pl_next_step(who('tap2'), { event: 'resend' })
  check('8 CONTROL a NEW tap is its own request (rate limits live in the PL service)', w.calls.filter((c) => c === 'account/next-step').length === 2 && !w.calls.includes('lines/provision') && !w.calls.includes('flows/launch'))
}
{
  const w = world({ j: JS.no_line })
  const r = await w.h.pl_next_step(who('tap1'), { event: 'resend' })
  check('8 CONTROL a customer with NO line is sent the signup Flow (so the harness can see flows/launch)', r.ok && r.result.code === 'setup_flow_sent' && w.calls.includes('flows/launch'))
}
{
  const w = world({ j: JS.setup_not_activated, nextStep: { code: 'link_rate_limited', data: {} } })
  const r = await w.h.pl_next_step(who('tap1'), { event: 'resend' })
  check('8 link rate-limited: told to use the latest link; nothing re-provisioned, no Flow, no public post', r.ok && r.result.code === 'link_rate_limited' && !w.calls.includes('lines/provision') && !w.calls.includes('flows/launch') && w.pub.length === 0)
}
{
  const w = world({ j: JS.setup_not_activated })
  const r = await w.h.pl_provision(who('tap1'), { offer_key: 'trial' })
  check('8 pl_provision for an existing holder without a presented offer is refused before any provisioning request', !r.ok && r.result.code === 'offer_not_presented' && !w.calls.includes('lines/provision'))
}

// ── 9. review findings (independent read 2026-10-23): every statement on the card is backed by a row that proves it ────────────────────────
const T0 = Date.parse('2026-10-23T14:40:00Z'), D = (m) => new Date(T0 - m * 60000)
const card = (hist, st = 'setup_not_activated', trigger = { kind: 'event' }) => A.composeOnboardingStatus({ j: JS[st], hist, trigger, nowMs: T0 }).text
{
  const unk = card([{ event: 'buttons:flow_done', stage: null, message_id: 'm', created_at: D(5) }])
  check('9 buttons send of UNCONFIRMED outcome: line 3 and line 7 both say acceptance was not confirmed (no "accepted by the API")', /3\. Setup message: a send was attempted.*acceptance was not confirmed/.test(unk) && /7\. Last automated action: setup buttons to the customer attempted at .*acceptance was not confirmed/.test(unk) && !/accepted by the API/.test(unk))
  const ok = card([{ event: 'buttons:flow_done', stage: 'setup_buttons', message_id: 'm', created_at: D(5) }])
  check('9 CONTROL confirmed buttons send: "accepted by the API; delivery/read not recorded"', /7\. Last automated action: setup buttons to the customer at .*\(accepted by the API; delivery\/read not recorded\)/.test(ok))
  const failed = card([{ event: 'recovery', stage: 'send_setup|service_unavailable', message_id: 'fail:stall1:msgA', created_at: D(2) }])
  check('9 FAILED recovery row: shown as failed / nothing sent, never as accepted', /recovery step FAILED \(nothing was sent\)/.test(failed) && !/accepted by the API/.test(failed))
  const sent = card([{ event: 'recovery', stage: 'send_setup|delivered', message_id: 'act:stall1:msgA', created_at: D(2) }])
  check('9 CONTROL delivered recovery step: accepted by the API', /recovery step to the customer at .*accepted by the API/.test(sent))
  const esc = card([{ event: 'recovery', stage: 'escalation_open|playbook_exhausted', message_id: 'esc:x', created_at: D(1) }, { event: 'buttons:flow_done', stage: 'setup_buttons', message_id: 'm', created_at: D(9) }])
  check('9 escalation row is NOT reported as an automated customer send (line 7 shows the buttons; line 9 shows the request)', /7\. Last automated action: setup buttons/.test(esc) && /Human help: REQUESTED/.test(esc))
  const staffNote = card([{ event: 'proactive', stage: 'staff_note', message_id: 'proactive:x', created_at: D(1) }])
  check('9 private staff note is described as a private note, not a customer message', /private staff note posted at /.test(staffNote) && !/accepted by the API/.test(staffNote))
  const unreplied = card([{ event: 'proactive', stage: null, message_id: 'proactive:y', created_at: D(1) }])
  check('9 proactive row with no stage (post not confirmed): not claimed as accepted', /attempted at .*acceptance was not confirmed/.test(unreplied))
}
{
  // deliverOwn rows (flow_done / act:*) are in the history now: the card posted right after a completion MESSAGE does not say "none recorded"
  const w = world({ j: JS.activated_not_registered })
  await w.h._runAction(who('fd1'), 'flow_done')
  const t = w.priv[0]?.content ?? ''
  check('9 flow_done that posted a completion message: card lists it (reply to the customer, accepted), not "none recorded"', w.pub.length === 1 && /7\. Last automated action: reply to the customer at .*accepted by the API/.test(t) && !/none recorded/.test(t), t.split('\n').find((l) => l.startsWith('7.')))
}
{
  const w = world({ j: JS.setup_not_activated, nextStep: { code: 'weird_unrecognised', data: {} } })
  const r = await w.h._runAction(who('fd1'), 'flow_done'); const t = w.priv[0]?.content ?? ''
  check('9 unknown buttons outcome: the result still carries the state (relay no longer prints unknown) AND the card says acceptance was not confirmed', r.result?.state === 'setup_not_activated' && /acceptance was not confirmed/.test(t), JSON.stringify({ ok: r.ok, code: r.result?.code, state: r.result?.state }))
}

// ── 10. labels cannot go stale when a verdict sends nothing ───────────────────────────────────────────────────────────────────────
{
  const w = world({ j: JS.registered_no_call, labels: ['vip', A.ONBOARDING_AWAITING_LABEL], lastInboundAgoS: 25 * 3600 })
  const r = await proactive(w, 'activated', 'rowQ')
  check('10 phone connected while the 24 h window is closed: nothing sent, no note, but the awaiting label is CLEARED and the staff label kept', r.code === 'outside_window' && w.pub.length === 0 && w.priv.length === 0 && w.labelWrites.at(-1) && !w.labelWrites.at(-1).includes(A.ONBOARDING_AWAITING_LABEL) && w.labelWrites.at(-1).includes('vip'), JSON.stringify({ code: r.code, labelWrites: w.labelWrites }))
  const ctl = world({ j: JS.setup_not_activated, labels: ['vip'], lastInboundAgoS: 25 * 3600 })
  const rc = await proactive(ctl, 'stalled:no_handoff', 'rowQ')
  check('10 CONTROL a stalled verdict held by the window still marks the line AWAITING (label added, vip kept), nothing sent', rc.code === 'outside_window' && ctl.pub.length === 0 && ctl.labelWrites.at(-1)?.includes(A.ONBOARDING_AWAITING_LABEL) && ctl.labelWrites.at(-1)?.includes('vip'))
  const held = world({ j: JS.registered_no_call, labels: [A.ONBOARDING_AWAITING_LABEL], status: 'open' })
  const rh = await proactive(held, 'activated', 'rowH')
  check('10 a person holds the conversation (held): label still refreshed, nothing sent', rh.code === 'held' && held.pub.length === 0 && !held.labelWrites.at(-1)?.includes(A.ONBOARDING_AWAITING_LABEL))
  const fault = world({ j: JS.activated_not_registered, labels: [A.ONBOARDING_FAULT_LABEL] })
  await proactive(fault, 'stalled:peer_absent_from_conf', 'rowF')
  check('10 CONTROL peer-absent verdict leaves the fault label in place and never adds the awaiting label (final label set read back)', fault.state.labels.includes(A.ONBOARDING_FAULT_LABEL) && !fault.state.labels.includes(A.ONBOARDING_AWAITING_LABEL), JSON.stringify(fault.state.labels))
}

// ── 11. the card never delays the caller beyond a bound (Chatwoot hangs) ─────────────────────────────────────────────────────────
{   // the card is detached: a SLOW Chatwoot (private post takes 1.2 s) must not add to the caller's time at all
  const t0 = Date.now(); const fast = world({ j: JS.setup_not_activated }); await fast.hRaw._runAction(who('fd1'), 'flow_done'); const fastMs = Date.now() - t0
  const t1 = Date.now(); const slow = world({ j: JS.setup_not_activated, slowPrivateMs: 1200 }); const r = await slow.hRaw._runAction(who('fd1'), 'flow_done'); const slowMs = Date.now() - t1
  check('11 CONTROL healthy Chatwoot: flow_done returns promptly', fastMs < 600, fastMs + 'ms')
  check('11 slow Chatwoot card (1.2 s): flow_done returns with the state and adds NO wait (within 300 ms of the healthy run)', r.ok && r.result.state === 'setup_not_activated' && slowMs < fastMs + 300, `${slowMs}ms vs ${fastMs}ms`)
  check('11 CONTROL the slow card had not finished when the caller was answered, and it still completes afterwards (detached, not dropped)', slow.priv.length === 0 && (await A.settleStatus(), slow.priv.length === 1))
}

// ── 12. Law 20: the PATH, not the pieces. Real makeServer + real HTTP + a signed /v1/proactive request (what plsvc's registration watch sends) ──────────
{
  const post = async (w, key, ref, signed = true) => {
    const { server } = A.makeServer(w.cfg, w.db, w.f); await new Promise((res) => server.listen(0, '127.0.0.1', res))
    const body = JSON.stringify({ kid: w.cfg.plKid, wa_id: WA, key, ref, iat: Math.floor(Date.now() / 1000), nonce: 'n'.repeat(22) })
    const rs = await fetch(`http://127.0.0.1:${server.address().port}/v1/proactive`, { method: 'POST', headers: signed ? { 'x-pl-proactive-signature': sign(w.cfg, body) } : {}, body })
    const j = await rs.json().catch(() => null); await A.settleStatus(); server.close(); return { status: rs.status, j }
  }
  const un = world({ j: JS.activated_not_registered })
  const u = await post(un, 'stalled:handoff_no_register', 'rowU', false)
  check('12 HTTP unsigned /v1/proactive -> 401 and NOTHING written (no note, no customer message, no label)', u.status === 401 && un.priv.length === 0 && un.pub.length === 0 && un.labelWrites.length === 0)
  const sent = world({ j: JS.activated_not_registered, labels: ['vip'] })
  const s1 = await post(sent, 'stalled:handoff_no_register', 'rowS')
  check('12 HTTP CONTROL signed stalled reminder -> 200 sent: exactly ONE customer message AND the status card AND the awaiting label (staff label kept)',
    s1.status === 200 && s1.j?.code === 'sent' && sent.pub.length === 1 && sent.priv.length === 1 && /Personal Line onboarding status/.test(sent.priv[0].content) && sent.labelWrites.at(-1)?.includes('vip') && sent.labelWrites.at(-1)?.includes(A.ONBOARDING_AWAITING_LABEL), JSON.stringify(s1.j))
  const again = await post(sent, 'stalled:handoff_no_register', 'rowS')
  check('12 HTTP the same signed event again -> no second customer message, no second card', sent.pub.length === 1 && sent.priv.length === 1, JSON.stringify(again.j))
  const pa = world({ j: JS.activated_not_registered, labels: ['vip', A.ONBOARDING_AWAITING_LABEL] })
  const p1 = await post(pa, 'stalled:peer_absent_from_conf', 'rowPA')
  // The one private note is owned by the ADAPTER's pre-existing peer-absent branch (STAFF_NOTE_PEER_ABSENT, posted in handleProactiveCore). The onboarding feature adds no note there, only (flag ON) the fault label.
  check('12 HTTP peer-absent -> 200 sent: ONE private note, NO customer message, fault label added / awaiting removed / staff label kept',
    p1.status === 200 && p1.j?.code === 'sent' && pa.priv.length === 1 && pa.priv[0].content === A.STAFF_NOTE_PEER_ABSENT && pa.pub.length === 0 && pa.labelWrites.at(-1)?.includes(A.ONBOARDING_FAULT_LABEL) && !pa.labelWrites.at(-1)?.includes(A.ONBOARDING_AWAITING_LABEL) && pa.labelWrites.at(-1)?.includes('vip'), JSON.stringify(p1.j))
}

{   // the same complete route with the label flag at its DEFAULT (off): the existing note only, no customer message, no label write, no extra journey read
  const post = async (w, key, ref) => {
    const { server } = A.makeServer(w.cfg, w.db, w.f); await new Promise((res) => server.listen(0, '127.0.0.1', res))
    const body = JSON.stringify({ kid: w.cfg.plKid, wa_id: WA, key, ref, iat: Math.floor(Date.now() / 1000), nonce: 'n'.repeat(22) })
    const rs = await fetch(`http://127.0.0.1:${server.address().port}/v1/proactive`, { method: 'POST', headers: { 'x-pl-proactive-signature': sign(w.cfg, body) }, body })
    const j = await rs.json().catch(() => null); await A.settleStatus(); server.close(); return { status: rs.status, j }
  }
  const off = world({ j: JS.activated_not_registered, labels: ['vip'], labelsOn: false })
  const r = await post(off, 'stalled:peer_absent_from_conf', 'rowPA3')
  check('12 HTTP peer-absent, labels at their DEFAULT (off): 200 sent, exactly the adapter-owned note, zero customer messages, zero label writes, no journey read, staff label untouched',
    r.status === 200 && r.j?.code === 'sent' && off.priv.length === 1 && off.priv[0].content === A.STAFF_NOTE_PEER_ABSENT && off.pub.length === 0 && off.labelWrites.length === 0 && !off.calls.includes('account/journey') && off.state.labels.join() === 'vip', JSON.stringify(r.j))
}

// ── 12b. labels are OFF by default (PL_ONBOARDING_LABELS): the labels endpoint overwrites the whole set, so nothing label-related may run unless enabled ───────
{
  const off = world({ j: JS.setup_not_activated, labels: ['vip'], labelsOn: false })
  await off.h._runAction(who('fdL'), 'flow_done')
  check('12b labels OFF (default): the private status note is still posted exactly once, NO label write at all, the staff label untouched', off.priv.length === 1 && off.labelWrites.length === 0 && off.state.labels.join() === 'vip')
  const on = world({ j: JS.setup_not_activated, labels: ['vip'], labelsOn: true })
  await on.h._runAction(who('fdL'), 'flow_done')
  check('12b CONTROL labels ON: the same event writes the awaiting label and keeps the staff label (the OFF assertion could have failed)', on.priv.length === 1 && on.labelWrites.length === 1 && on.labelWrites[0].includes(A.ONBOARDING_AWAITING_LABEL) && on.labelWrites[0].includes('vip'))
  const heldOff = world({ j: JS.registered_no_call, labels: ['vip', A.ONBOARDING_AWAITING_LABEL], status: 'open', labelsOn: false })
  const rho = await proactive(heldOff, 'activated', 'rowH2')
  const heldOn = world({ j: JS.registered_no_call, labels: ['vip', A.ONBOARDING_AWAITING_LABEL], status: 'open', labelsOn: true })
  const rhn = await proactive(heldOn, 'activated', 'rowH3')
  check('12b labels OFF: a no-send verdict does no extra journey read and no label write; CONTROL ON does both', rho.code === 'held' && !heldOff.calls.includes('account/journey') && heldOff.labelWrites.length === 0 && rhn.code === 'held' && heldOn.calls.includes('account/journey') && heldOn.labelWrites.length === 1, JSON.stringify([heldOff.calls, heldOn.calls]))
  const paOff = world({ j: JS.activated_not_registered, labels: ['vip'], labelsOn: false })
  const rpo = await proactive(paOff, 'stalled:peer_absent_from_conf', 'rowPA2')
  check('12b labels OFF, peer-absent: the ADAPTER-owned staff note (STAFF_NOTE_PEER_ABSENT) is posted once, nothing public, no label write', rpo.code === 'sent' && paOff.priv.length === 1 && paOff.priv[0].content === A.STAFF_NOTE_PEER_ABSENT && paOff.pub.length === 0 && paOff.labelWrites.length === 0)
}

// ── 12c. the detach cap: bounded, and a slot is reclaimed even if the work never settles (Codex review 2026-10-23, finding 1) ─────────────────────────────────
{
  const saved = { ...A.statusLimits }; A.statusLimits.maxPending = 2; A.statusLimits.maxAgeMs = 150
  const before = { ...A.statusStats }
  let ran = 0; const hang = () => { ran++; return new Promise(() => {}) }
  A.detachStatus(hang); A.detachStatus(hang); A.detachStatus(hang)
  await new Promise((r) => setTimeout(r, 20))
  check('12c cap: with 2 stuck cards, the 3rd is dropped (cap works) - only 2 ran', ran === 2 && A.statusStats.dropped === before.dropped + 1)
  await new Promise((r) => setTimeout(r, 200))
  A.detachStatus(hang); await new Promise((r) => setTimeout(r, 20))
  check('12c CONTROL after the max age the stuck slots are reclaimed: a new card is accepted and runs', ran === 3)
  let unhandled = 0; const onUnhandled = () => { unhandled++ }; process.on('unhandledRejection', onUnhandled)
  Promise.reject(new Error('deliberate, instrument control')); await new Promise((r) => setTimeout(r, 20)); const control = unhandled; unhandled = 0
  A.detachStatus(() => { throw new Error('sync boom') }); A.detachStatus(() => Promise.reject(new Error('async boom')))
  await new Promise((r) => setTimeout(r, 40))
  check('12c a card that throws synchronously or rejects never escapes: 0 unhandled rejections (CONTROL: the counter DID see the deliberate one)', control === 1 && unhandled === 0, `control=${control} seen=${unhandled}`)
  process.off('unhandledRejection', onUnhandled)
  Object.assign(A.statusLimits, saved)
}

// ── 13. last: a Chatwoot that NEVER answers the private post (hang) must not delay or break flow_done; nothing is settled afterwards (the fake never returns) ──
{
  const t0 = Date.now(); const fast = world({ j: JS.setup_not_activated }); await fast.hRaw._runAction(who('fd1'), 'flow_done'); const fastMs = Date.now() - t0
  const t1 = Date.now(); const hung = world({ j: JS.setup_not_activated, hangPrivate: true }); const r = await hung.hRaw._runAction(who('fd1'), 'flow_done'); const hungMs = Date.now() - t1
  check('13 Chatwoot private post hangs forever: flow_done still answers with the state, no added wait', r.ok && r.result.state === 'setup_not_activated' && hungMs < fastMs + 300, `${hungMs}ms vs ${fastMs}ms`)
}

console.log(`${n - fails}/${n} ${fails ? 'SOME FAILED' : 'ALL PASS'}`)
process.exit(fails ? 1 : 0)
