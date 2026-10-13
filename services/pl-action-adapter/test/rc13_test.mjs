// adapter rc13 - isolated fixtures across every journey state (no model, no network, no real customer). argv: <adapter.mjs>
// Fakes: the PL service (journey/offer/balance/calls/flows per fixture state), Chatwoot (conversation status, messages, contacts,
// posts) and the adapter DB (the exact statements the adapter issues). Each absence assertion has a positive twin in the same run.
import crypto from 'node:crypto'
const [, , adapterPath] = process.argv
const A = await import('file:///' + adapterPath.replace(/\\/g, '/'))
let fails = 0, n = 0
const check = (name, ok, x = '') => { n++; if (!ok) fails++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (x ? ' | ' + x : '')) }
const titles = (g) => (g?.choices ?? []).map((c) => c.title)
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

const OFFER = { trial_days: 7, trial_minutes: 60, trial_pool: 'dominica', trial_price_xcd: '0.00', overage_dominica_xcd: '0.135', overage_uscan_xcd: '1.49',
  plans: [{ key: 'day', name: 'Day Pass', days: 1, minutes: 60, pool: 'dominica', price_xcd: '5.00' }, { key: 'plus', name: 'Plus', days: 30, minutes: 1500, pool: 'shared', price_xcd: '99.00' }] }
const F = { did_pretty: '+1 767 818 5097', registration: 'registered', softphone_activated: true, first_call_done: true, minutes_remaining: 58, minutes_included: 60, low: false, expires_date_pretty: 'October 17, 2026', wallet_xcd: '0.00' }
const PAY = { topup_available: false, rail: 'fiserv', reason: 'fiserv_topup_not_available_in_chat' }
const OKC = { estate_suppressed: false, known: true }
const J = {
  no_line: { state: 'no_line', next_action: 'get_number', actions: ['get_number', 'how_it_works', 'plans'], attention: [], registration_known: false, has_line: false, facts: null, payment: PAY },
  setup_not_activated: { state: 'setup_not_activated', next_action: 'continue_setup', actions: ['continue_setup', 'human'], attention: [], registration_known: true, has_line: true, facts: { ...F, softphone_activated: false, first_call_done: false, registration: 'unregistered' }, payment: PAY , consent: OKC },
  activated_not_registered: { state: 'activated_not_registered', next_action: 'check_connection', actions: ['check_connection', 'continue_setup', 'human'], attention: [], registration_known: true, has_line: true, facts: { ...F, first_call_done: false, registration: 'unregistered' }, payment: PAY , consent: OKC },
  registered_no_call: { state: 'registered_no_call', next_action: 'how_to_call', actions: ['how_to_call', 'troubleshoot', 'human'], attention: [], registration_known: true, has_line: true, facts: { ...F, first_call_done: false }, payment: PAY , consent: OKC },
  active: { state: 'active', next_action: 'balance', actions: ['balance', 'recent_calls', 'calling_help'], attention: [], registration_known: true, has_line: true, facts: F, payment: PAY , consent: OKC },
  attention: { state: 'attention', next_action: 'balance', actions: ['balance', 'plans', 'human'], attention: ['minutes_low', 'plan_ending'], registration_known: true, has_line: true, facts: { ...F, minutes_remaining: 4, low: true }, payment: PAY , consent: OKC },
  attention_topup_on: { state: 'attention', next_action: 'top_up', actions: ['top_up', 'balance', 'plans', 'human'], attention: ['minutes_exhausted'], registration_known: true, has_line: true, facts: { ...F, minutes_remaining: 0 }, payment: { ...PAY, topup_available: true } , consent: OKC },
}

// The adapter's release statement, matched EXACTLY (owner-approved 2026-10-10: the fake recognises the full scoped statement).
const RELEASE_SQL = 'DELETE FROM pl_adapter_guidance WHERE id=$1'
function fakeDb() {
  const g = [], pref = new Map(); let seq = 0
  return { g, pref, async query(sql, p = []) {
    const s = sql.replace(/\s+/g, ' ').trim()
    if (s.startsWith('INSERT INTO pl_adapter_guidance')) {
      const ev = s.includes("'provision_ack'") ? 'provision_ack' : s.includes("'proactive'") ? 'proactive' : p[3]
      if (g.some((r) => r.c === p[0] && r.h === p[1] && r.m === p[2] && r.e === ev)) return { rows: [], rowCount: 0 }
      const r = { id: ++seq, c: p[0], h: p[1], m: p[2], e: ev, stage: null, posted: null }; g.push(r); return { rows: [{ id: r.id }], rowCount: 1 }
    }
    if (s.startsWith('UPDATE pl_adapter_guidance SET stage')) { const r = g.find((x) => x.id === p[0]); if (r) { r.stage = p[1]; r.posted = p[2] } return { rows: [], rowCount: r ? 1 : 0 } }
    if (s === RELEASE_SQL) { const i = g.findIndex((x) => x.id === p[0]); if (i >= 0) g.splice(i, 1); return { rows: [], rowCount: i >= 0 ? 1 : 0 } }
    if (s.startsWith('SELECT stage FROM pl_adapter_guidance')) { const r = g.find((x) => x.c === p[0] && x.h === p[1] && x.m === p[2] && x.e === p[3]); return { rows: r ? [{ stage: r.stage }] : [], rowCount: r ? 1 : 0 } }
    if (s.startsWith('SELECT 1 FROM pl_adapter_guidance') && s.includes("stage='proactive_first_call'")) { const r = g.find((x) => x.c === p[0] && x.h === p[1] && x.m === p[2] && x.stage === 'proactive_first_call'); return { rows: r ? [{}] : [], rowCount: r ? 1 : 0 } }
    if (s.startsWith('SELECT count(*)::int AS n FROM pl_adapter_guidance') && s.includes("event='act:my_account'")) { return { rows: [{ n: g.filter((r) => r.h === p[0] && r.e === 'act:my_account' && r.stage === 'my_account_link').length }], rowCount: 1 } }
    if (s.startsWith('INSERT INTO pl_adapter_preference')) { pref.set(p[0], p[1]); return { rows: [], rowCount: 1 } }
    if (s.startsWith('SELECT proactive_stopped')) { return { rows: pref.has(p[0]) ? [{ proactive_stopped: pref.get(p[0]) }] : [], rowCount: pref.has(p[0]) ? 1 : 0 } }
    throw new Error('unexpected SQL: ' + s.slice(0, 80))
  } }
}
const WA = '17670000001'
const LINK_URL = 'https://uplink.example.test/customer/pl-ws/wa-link?token=' + 'T'.repeat(43)
function world({ j = J.active, status = 'pending', messages = [], lastInboundAgoS = 60, contactSearch = null, portal = null } = {}) {
  const posts = [], calls = [], nowS = Math.floor(Date.now() / 1000)
  const conv = { id: 77, inbox_id: 11, status, meta: { sender: { id: 5 } } }
  const st = { j, status, portal: portal ?? { code: 'portal_link', status: 'ok', data: { url: LINK_URL, expires_at: new Date(Date.now() + 600000).toISOString(), single_use: true } } }
  const f = async (url, init) => {
    const u = String(url)
    const ok = (body) => ({ ok: true, status: 200, json: async () => body })
    if (u.startsWith('http://pl/')) {
      const ep = u.split('/v1/')[1]; calls.push(ep)
      if (ep === 'account/journey') return ok({ code: 'journey', data: st.j })
      if (ep === 'offer') return ok({ code: 'offer', data: OFFER })
      if (ep === 'account/balance') return ok(st.j.has_line ? { code: 'balance', data: { known: true, kind: 'included', minutes_included: 60, minutes_remaining: st.j.facts.minutes_remaining, low: st.j.facts.low, expires_date_pretty: 'October 17, 2026', wallet_xcd: '0.00' } } : { code: 'no_account' })
      if (ep === 'account/recent-calls') return ok({ code: 'recent_calls', data: { known: true, calls: [{ dir: 'out', number_masked: '***2300', duration_s: 65, started_at: '2026-10-10T14:00:56Z' }] } })
      if (ep === 'flows/launch') return ok({ code: 'flow_sent', data: { existing_line: st.j.has_line } })
      if (ep === 'account/portal-link') return ok(st.portal)
      return ok({ code: 'bad_response' })
    }
    if (u.startsWith('http://cw/')) {
      const path = u.split('/accounts/2')[1]
      if (init?.method === 'POST') { const b = JSON.parse(init.body); posts.push(b); return ok({ id: 9000 + posts.length }) }
      if (path.startsWith('/contacts/search')) return ok({ payload: contactSearch ?? [{ id: 5 }] })
      if (path === '/contacts/5/conversations') return ok({ payload: [{ id: 77, inbox_id: 11, last_activity_at: nowS }] })
      if (path === '/contacts/5') return ok({ payload: { id: 5, phone_number: '+' + WA, contact_inboxes: [{ inbox: { id: 11 }, source_id: WA }] } })
      if (path === '/conversations/77/messages') return ok({ payload: messages.length ? messages : [{ id: 100, message_type: 0, private: false, sender_type: 'Contact', source_id: 'wamid.ABCDEFGHIJKL', content: 'hi', created_at: nowS - lastInboundAgoS }] })
      if (path === '/conversations/77') return ok({ ...conv, status: st.status })
    }
    throw new Error('unexpected fetch ' + u)
  }
  const cfg = { plKey: 'k'.repeat(32), plKid: 'k1', plPnid: '1023804347491554', plBase: 'http://pl', cwBase: 'http://cw', cwAccount: 2, cwInbox: 11, cwToken: 't', timeoutMs: 1000, flowOnboarding: true, accountTools: true, bearer: 'b', sourceCidrs: [], ctxKid: 'c1', ctxKey: 'c'.repeat(32), workspaceId: 'w'.repeat(36), agentId: '28a55c69-ef04-416f-9c91-7d72e9e21345', agentSlug: 'slug' }
  const db = fakeDb()
  const h = A.makeHandlers(cfg, db, {}, f)
  return { posts, calls, db, h, cfg, f, st }
}
const who = (mid = 'm1') => ({ waId: WA, wamid: 'wamid.T1234567890', conversationId: '77', messageId: mid, content: '' })
const lastPost = (w) => w.posts[w.posts.length - 1]
const postTitles = (p) => (p?.content_attributes?.items ?? []).map((i) => i.title)

// 1. journey message + buttons per state (owner's examples)
const EXPECT = {
  no_line: ['Get my number', 'How it works', 'Plans & prices'],
  setup_not_activated: ['Continue setup', 'Talk to a person'],
  activated_not_registered: ['Check connection', 'Continue setup', 'Talk to a person'],
  registered_no_call: ['How to make a call', 'Troubleshoot', 'Talk to a person'],
  active: ['Balance', 'Recent calls', 'Calling help'],
  attention: ['Balance', 'Plans & prices', 'Talk to a person'],
}
// rc13 SUPERSEDES rc12 (PM 2026-10-10: the agent writes, tools return facts): pl_journey returns facts + buttons, posts NOTHING.
for (const [s, want] of Object.entries(EXPECT)) {
  const w = world({ j: J[s] }); const r = await w.h.pl_journey(who())
  check(`journey ${s}: facts returned, nothing posted, buttons ${want.join(' / ')}`, r.ok && r.result.code === 'facts' && w.posts.length === 0 && same(r.result.choices.map((c) => c.title), want) && r.result.choices.every((c) => typeof c.value === 'string'), JSON.stringify(r.result.choices))
}
{ const g = A.composeJourney(J.attention_topup_on); check('top_up never offered (no handler) even when the service says top-up is available', !titles(g).some((t) => /top ?up/i.test(t)) && titles(g).includes('Balance'), titles(g).join(' / ')) }
{ const g = A.composeJourney(J.attention); check('attention wording: reasons stated + honest "not available in this chat", no promise', /running low \(4 of 60 left\)/.test(g.text) && /ends October 17, 2026/.test(g.text) && /aren't available in this chat yet/.test(g.text) && !/will be|coming soon/i.test(g.text)) }
{ const g = A.composeJourney(J.active); check('active wording names the line, no signup copy', /\+1 767 818 5097 is working/.test(g.text) && !/free trial|get my number|sign ?up/i.test(g.text)) }
{ const g = A.composeJourney(J.no_line); check('no_line wording carries the voice-only disclosure', g.text.includes(A.VOICE_ONLY_DISCLOSURE)) }

// 2. every visible action runs and answers from verified state
const ACTIONS = ['get_number', 'how_it_works', 'plans', 'continue_setup', 'check_connection', 'how_to_call', 'troubleshoot', 'balance', 'recent_calls', 'calling_help']
for (const s of Object.keys(EXPECT)) {
  for (const a of ACTIONS) {
    const w = world({ j: J[s] }); const r = await w.h._runAction(who(`m-${s}-${a}`), a)
    const flow = r.ok && r.result.code === 'setup_flow_sent'
    const posted = w.posts.length === 1 && typeof lastPost(w).content === 'string' && lastPost(w).content.length > 10
    const tl = postTitles(lastPost(w))
    const sane = flow ? w.posts.length === 0 : posted && tl.length >= 1 && tl.length <= 3 && tl.every((t) => t.length <= 20) && !tl.some((t) => /top ?up/i.test(t))
    check(`action ${a} @ ${s}: ${flow ? 'Flow sent' : 'message ' + tl.join('/')}`, r.ok && sane, r.ok ? '' : JSON.stringify(r.result))
  }
}
for (const s of ['active', 'registered_no_call', 'attention']) {
  const w = world({ j: J[s] }); await w.h._runAction(who(), 'continue_setup')
  check(`continue_setup @ ${s}: NO Flow launched (setup not restarted), state message instead`, !w.calls.includes('flows/launch') && w.posts.length === 1)
}
{ const w = world({ j: J.setup_not_activated }); const r = await w.h._runAction(who(), 'continue_setup'); check('CONTROL continue_setup @ setup_not_activated: Flow IS launched', w.calls.includes('flows/launch') && r.result.code === 'setup_flow_sent') }
{ const w = world({ j: J.no_line }); await w.h._runAction(who(), 'balance'); check('no line + Balance tap: no-line menu, not an account error', w.posts.length === 1 && same(postTitles(lastPost(w)), EXPECT.no_line) && !w.calls.includes('account/balance')) }
{ const w = world({ j: J.active }); await w.h._runAction(who(), 'balance'); const p = lastPost(w); check('active + Balance: three facts + next actions without Balance', /Included minutes: 58 of 60 left/.test(p.content) && same(postTitles(p), ['Recent calls', 'Calling help', 'Talk to a person']), postTitles(p).join('/')) }
{ const w = world({ j: J.attention }); await w.h._runAction(who(), 'balance'); const p = lastPost(w); check('low balance: person always one tap away', postTitles(p).includes('Talk to a person') && /aren't available in this chat yet - tap \*Talk to a person\*/.test(p.content)) }
{ const w = world({ j: J.no_line }); await w.h._runAction(who(), 'plans'); const p = lastPost(w); check('plans (no line): figures from the catalogue, purchase honestly unavailable', /Free trial - 7 days, 60 Dominica minutes, EC\$0\.00/.test(p.content) && /Plus - 30 days, 1500 minutes for Dominica, US & Canada, EC\$99\.00/.test(p.content) && /can't be bought in this chat yet/.test(p.content)) }
{ const w = world({ j: J.activated_not_registered }); await w.h._runAction(who(), 'check_connection'); const p = lastPost(w); check('check connection, not registered: says so + Check again / Continue setup / person', /isn't connected to your line yet/.test(p.content) && same(postTitles(p), ['Check connection', 'Continue setup', 'Talk to a person'])) }
{ const w = world({ j: J.registered_no_call }); await w.h._runAction(who(), 'check_connection'); const p = lastPost(w); check('CONTROL check connection, registered: connected + first-call next step', /connected to your line right now\. Next step: make your first call/.test(p.content)) }
// rc13 SUPERSEDES rc12 wording: a failed call on a working line whose app is closed is diagnosed in order and never loops.
{ const w = world({ j: { ...J.active, facts: { ...F, registration: 'unregistered' } } }); await w.h._runAction(who(), 'troubleshoot'); const p = lastPost(w); check('troubleshoot, working line whose app is closed: not connected now, reconnects by itself, no setup restart, no loop', /isn't connected to your line - that's why/.test(p.content) && /reconnects by itself/.test(p.content) && same(postTitles(p), ['Check connection', 'Talk to a person']), postTitles(p).join('/')) }

// 2c. rc13: Calling help is ONE question; no path leads back into a tutorial loop
{ const w = world({ j: J.active }); await w.h._runAction(who(), 'calling_help'); const p = lastPost(w); check('calling help -> one question: Call Dominica / Call US/Canada / A call failed', /What do you need\?/.test(p.content) && same(postTitles(p), ['Call Dominica', 'Call US/Canada', 'A call failed']), postTitles(p).join('/')) }
const LOOPY = ['Calling help', 'How to make a call', 'Troubleshoot']
for (const a of ['call_dominica', 'call_uscan', 'call_failed', 'troubleshoot', 'check_connection']) {
  for (const s of ['active', 'registered_no_call', 'attention']) {
    const w = world({ j: J[s] }); await w.h._runAction(who(`loop-${a}-${s}`), a); const tl = postTitles(lastPost(w))
    const okLoop = a === 'check_connection' && s === 'registered_no_call' ? tl.includes('How to make a call') : !tl.some((t) => LOOPY.includes(t))
    check(`no loop: ${a} @ ${s} -> ${tl.join('/')}`, tl.length > 0 && okLoop && tl.includes('Talk to a person'))
  }
}
{ const w = world({ j: J.active }); await w.h._runAction(who(), 'call_uscan'); const p = lastPost(w); check('US/Canada on a Dominica-only plan with EC$0.00: cannot connect yet, honest no top-up, person', /includes Dominica calls only/.test(p.content) && /EC\$1\.49 a minute/.test(p.content) && /can't connect yet/.test(p.content) && /isn't available in this chat yet/.test(p.content)) }
{ const w = world({ j: J.active }); await w.h._runAction(who(), 'call_dominica'); const p = lastPost(w); check('Dominica: dialing + included minutes (58 left) + rate + wallet as separate facts', /\+1 767 and the 7-digit number/.test(p.content) && /included minutes \(58 left\)/.test(p.content) && /EC\$0\.135 a minute/.test(p.content) && /EC\$0\.00 wallet credit/.test(p.content)) }
{ const w = world({ j: J.active }); await w.h._runAction(who(), 'call_failed'); const p = lastPost(w); check('call failed, connected with minutes: line OK, causes in order, asks for number + what they heard', /connected to your line right now and you have 58 included minutes left and EC\$0\.00 wallet credit/.test(p.content) && /country code/.test(p.content) && /tell us the number you called and what you heard/.test(p.content)) }
// 2d. rc13: facts mode for the native agent
{ const w = world({ j: J.no_line }); const r = await w.h.pl_guide(who(), { topic: 'plans' }); const c = r.result.catalogue
  check('pl_guide plans: catalogue facts (EC$ prices, minutes, coverage), purchase not in chat, nothing posted', r.ok && w.posts.length === 0 && c.free_trial.price === 'EC$0' && c.plans.some((p) => p.name === 'Plus' && p.price === 'EC$99' && p.covers === 'Dominica, US and Canada') && c.after_included_minutes.dominica === '13.5 EC cents a minute' && r.result.purchase_in_chat === false && same(r.result.choices.map((x) => x.title), ['Get my number', 'How it works', 'Talk to a person'])) }
{ const w = world({ j: J.active }); const r = await w.h.pl_guide(who(), { topic: 'call_failed' }); check('pl_guide call_failed: live facts + diagnosis + Check connection / person, nothing posted', r.ok && w.posts.length === 0 && r.result.facts.registration_now === 'registered' && r.result.diagnosis === 'call_failed_connected' && same(r.result.choices.map((x) => x.title), ['Check connection', 'Talk to a person'])) }
{ const w = world({ j: J.active }); const r = await w.h.pl_guide(who(), { topic: 'calling' }); check('pl_guide calling: coverage + Dominica rate without $; choices = the 3 calling answers', r.ok && r.result.facts.plan_covers_us_canada === false && r.result.rates.dominica_after_included.startsWith('13.5 EC cents') && same(r.result.choices.map((x) => x.title), ['Call Dominica', 'Call US/Canada', 'A call failed'])) }
{ const w = world({ j: J.active }); const r = await w.h.pl_journey(who()); check('wallet credit handed to the agent WITHOUT a $ sign (Uplink price validator)', r.result.facts.wallet_credit === '0.00 EC dollars' && !/\$/.test(JSON.stringify(r.result.facts))) }
{ const w = world({ j: { ...J.active, facts: { ...F, did_masked: '+1 767 *** 5097' } } }); const r = await w.h.pl_journey(who()); check('rc13b: the agent gets the MASKED line only (no full number for the PII validator to reject)', r.result.facts.line === '+1 767 *** 5097' && !JSON.stringify(r.result).includes('818 5097')) }
{ const w = world({ j: J.active }); const r = await w.h.pl_journey(who()); const app = r.result.facts.app; check('rc13d: the agent knows the calling app (Cloud Softphone by Acrobits) and both store links from tool data', app.name === 'Cloud Softphone' && app.maker === 'Acrobits' && app.ios_app_store.startsWith('https://apps.apple.com/') && app.android_google_play.startsWith('https://play.google.com/')) }
{ const w = world({ j: J.no_line }); const r = await w.h.pl_guide(who(), { topic: 'call_failed' }); check('no line + call_failed: no account facts invented, no-line buttons', r.ok && r.result.facts === null && r.result.choices[0].title === 'Get my number') }
{ const w = world({ j: J.active }); const r = await w.h.pl_guide(who(), { topic: 'bogus' }); check('pl_guide unknown topic refused', !r.ok && r.result.code === 'invalid_arguments') }

// 3. ownership
{ const w = world({ j: J.active, status: 'open' }); const r = await w.h._runAction(who(), 'balance'); check('human-owned (open): action refused, NOTHING posted, row released', !r.ok && r.result.code === 'conversation_not_ai_owned' && w.posts.length === 0 && w.db.g.length === 0) }
{ const w = world({ j: J.active, status: 'pending' }); const r = await w.h._runAction(who(), 'balance'); check('CONTROL AI-owned (pending): action posts', r.ok && w.posts.length === 1) }

// 4. duplicate delivery
{ const w = world({ j: J.active }); await w.h._runAction(who('dup'), 'recent_calls'); const r2 = await w.h._runAction(who('dup'), 'recent_calls'); check('same message twice -> ONE post, second reports already', w.posts.length === 1 && r2.ok && r2.result.already === true) }

// 5. taps
const nowS = Math.floor(Date.now() / 1000)
const offered = (id, items) => ({ id, message_type: 1, private: false, content: 'x', content_attributes: { items }, created_at: nowS - 30 })
const cust = (id, content) => ({ id, message_type: 0, private: false, sender_type: 'Contact', source_id: 'wamid.ABCDEFGHIJK' + id, content, created_at: nowS - 5 })
{
  const msgs = [offered(10, [{ title: 'Get my number', value: 'pl_get_number' }]), offered(20, A.choicesFor(J.active.actions).map((c) => ({ title: c.title, value: c.value }))), cust(21, 'Recent calls')]
  check('tap "Recent calls" offered by the latest choices message -> recent_calls', A.resolveTap(msgs, 21, 'Recent calls')?.action === 'recent_calls')
  check('stale title from an OLDER message ("Get my number") -> not a tap (goes to the model)', A.resolveTap(msgs, 21, 'Get my number') === null)
  check('typed text that was never offered -> not a tap', A.resolveTap(msgs, 21, 'Balance please') === null)
  check('legacy rc10 button value still maps (check_balance -> balance)', A.resolveTap([offered(30, [{ title: 'Check my balance', value: 'check_balance' }])], 31, 'check my balance ')?.action === 'balance')
  check('"Talk to a person" is never an adapter action (the relay hands off)', A.resolveTap([offered(40, [A.BTN.human])], 41, 'Talk to a person') === null)
  check('STOP / START keywords recognised; "stop calling me" is not', A.STOP_RE.test('STOP') && A.STOP_RE.test(' unsubscribe ') && A.START_RE.test('Start') && !A.STOP_RE.test('stop calling me'))
}

// 6. Flow Done from VERIFIED state
for (const [s, re] of [['active', /All set - your line \+1 767 818 5097 is working/], ['setup_not_activated', /isn't set up in Cloud Softphone yet/], ['activated_not_registered', /isn't connected yet - so setup isn't finished/], ['no_line', /wasn't set up/], ['registered_no_call', /make your first call/]]) {
  const w = world({ j: J[s] }); const r = await w.h._runAction(who(`fd-${s}`), 'flow_done'); const p = lastPost(w)
  check(`Flow Done @ ${s}: ${re}`, r.ok && re.test(p?.content ?? '') && (s === 'active' || !/all set/i.test(p.content)))
}

// 7. STOP / START and the proactive path
const sign = (cfg, body) => crypto.createHmac('sha256', Buffer.from(cfg.plKey, 'utf8')).update(`${A.PROACTIVE_PURPOSE}.${body}`, 'utf8').digest('base64url')
const req = (cfg, key, ref = 'row1', over = {}) => { const body = JSON.stringify({ kid: cfg.plKid, wa_id: WA, key, ref, iat: Math.floor(Date.now() / 1000), nonce: 'n'.repeat(22), ...over }); return { body, sig: sign(cfg, body) } }
async function proactive(w, key, ref = 'row1', over = {}) { const { body, sig } = req(w.cfg, key, ref, over); const v = A.verifyProactive(body, sig, w.cfg); if (!v.ok) return { code: 'unauthorized:' + v.why }; return A.handleProactive(w.cfg, w.db, {}, v.b, w.f) }
{ const w = world({ j: J.registered_no_call }); const r = await proactive(w, 'activated'); const p = lastPost(w)
  check('proactive activated @ registered_no_call: sent, first-call nudge with the state buttons', r.code === 'sent' && /now connected to your line/.test(p.content) && same(postTitles(p), EXPECT.registered_no_call)) }
{ const w = world({ j: J.active }); const r = await proactive(w, 'activated'); check('proactive activated @ active: ONE first-call message, covers first_call', r.code === 'sent' && same(r.covered, ['activated', 'first_call']) && /first call went through/.test(lastPost(w).content))
  const r2 = await proactive(w, 'first_call'); check('...then first_call for the same hand-off -> duplicate, nothing posted', r2.code === 'duplicate' && w.posts.length === 1) }
{ const w = world({ j: J.active }); await proactive(w, 'activated'); const r2 = await proactive(w, 'activated'); check('same verdict twice -> duplicate (one message)', r2.code === 'duplicate' && w.posts.length === 1) }
{ const w = world({ j: J.active }); const r = await proactive(w, 'stalled:handoff_no_register'); check('stale stall verdict after the customer moved on -> superseded_by_state, nothing sent', r.code === 'superseded_by_state' && w.posts.length === 0) }
{ const w = world({ j: J.activated_not_registered }); const r = await proactive(w, 'stalled:handoff_no_register'); check('CONTROL stall verdict while still not registered -> sent', r.code === 'sent' && w.posts.length === 1) }
{ const w = world({ j: J.setup_not_activated }); const r = await proactive(w, 'stalled:link_not_opened'); check('link expired @ setup_not_activated -> sent with Continue setup', r.code === 'sent' && postTitles(lastPost(w))[0] === 'Continue setup') }
{ const w = world({ j: J.active, status: 'open' }); const r = await proactive(w, 'first_call'); check('person holds the conversation -> held, nothing posted', r.code === 'held' && w.posts.length === 0) }
{ const w = world({ j: J.active, lastInboundAgoS: 25 * 3600 }); const r = await proactive(w, 'first_call'); check('outside the 24 h window -> outside_window, nothing posted', r.code === 'outside_window' && w.posts.length === 0) }
{ const w = world({ j: J.active, lastInboundAgoS: 3600 }); const r = await proactive(w, 'first_call'); check('CONTROL inside the window -> sent', r.code === 'sent') }
{ const w = world({ j: J.active }); await w.h._setPreference({ ...who('stop1') }, true); const p = lastPost(w)
  check('STOP: confirmation says no more automatic updates, chat still open', /won't get any more automatic updates/.test(p.content))
  const r = await proactive(w, 'first_call'); check('after STOP -> proactive stopped, nothing more posted', r.code === 'stopped' && w.posts.length === 1)
  await w.h._setPreference({ ...who('start1') }, false); const r2 = await proactive(w, 'first_call'); check('after START -> proactive sent again', r2.code === 'sent') }
{ const w = world({ j: J.active }); const r = await proactive(w, 'stalled:peer_absent_from_conf'); check('peer absent -> PRIVATE staff note only', r.code === 'sent' && lastPost(w).private === true) }
{ const w = world({ j: { ...J.active, consent: { estate_suppressed: true, known: true } } }); const r = await proactive(w, 'first_call'); check('estate STOP (Meta STOP / doNotContact / revoked opt-in) -> stopped, nothing posted', r.code === 'stopped' && r.detail === 'estate_suppressed' && w.posts.length === 0) }
{ const w = world({ j: { ...J.active, consent: { estate_suppressed: false, known: false } } }); const r = await proactive(w, 'first_call'); check('consent unreadable -> HELD (retried later), never assumed, nothing posted', r.code === 'held' && r.detail === 'consent_unknown' && w.posts.length === 0) }
{ const w = world({ j: J.active, contactSearch: [] }); const r = await proactive(w, 'first_call'); check('no Chatwoot contact for the number -> no_conversation', r.code === 'no_conversation') }
{ const w = world({ j: J.active }); const { body } = req(w.cfg, 'first_call'); check('forged signature -> refused', !A.verifyProactive(body, 'x'.repeat(43), w.cfg).ok)
  const old = req(w.cfg, 'first_call', 'r', { iat: Math.floor(Date.now() / 1000) - 600 }); check('stale request (iat 10 min old) -> refused', !A.verifyProactive(old.body, old.sig, w.cfg).ok)
  const fresh = req(w.cfg, 'first_call'); check('CONTROL fresh signed request verifies', A.verifyProactive(fresh.body, fresh.sig, w.cfg).ok) }

// 9a. rc13g launch scope wording (PM 2026-10-11): outgoing-calling offer; no blanket "incoming unavailable"; EPIC brand
{ const SENT = 'This launch offer covers outgoing calling.'
  const off = A.composeGuidance('next_step', { stage: 'connected', facts: { inbound_enabled: false, did_pretty: '+1 767 818 5099' } })
  check('connected (inbound flag off): says the launch offer covers outgoing calling', off && off.text.includes(SENT) && off.text.includes('make calls now'), off?.text)
  check('connected (inbound flag off): NO blanket "incoming ... not available" assertion and no promise of rings', off && !/not available|rings in|receive/i.test(off.text))
  const on = A.composeGuidance('next_step', { stage: 'connected', facts: { inbound_enabled: true, did_pretty: '+1 767 818 5099' } })
  check('CONTROL: the flag-on branch is still the other text (the test can tell the branches apart)', on && /rings in Cloud Softphone now/.test(on.text) && !on.text.includes(SENT))
  const af = JSON.stringify(A.APP_FACTS)
  check('APP_FACTS (handed to the agent): approved sentence present, no "NOT available" assertion', af.includes('Make calls from the free Cloud Softphone app. This launch offer covers outgoing calling.') && !/NOT available/i.test(af) && /never promise or advertise/.test(af))
  check('APP_FACTS keeps the guard against promising receiving calls (positive twin of the removed assertion)', /never state that incoming calls are unavailable/.test(af) && /never promise or advertise that the number rings/.test(af))
  const fc = A.composeGuidance('next_step', { stage: 'first_call_done', facts: {} })
  check('first call: EPIC brand, no "Isola"', fc && /welcome to EPIC/.test(fc.text) && !/isola/i.test(fc.text))
  const ins = A.composeGuidance('next_step', { stage: 'install', facts: { inbound_enabled: true }, store_links: { ios: 'https://i', android: 'https://a' } })
  check('install (flag on) branch: EPIC not Isola', ins && /EPIC number rings in/.test(ins.text) && !/isola/i.test(ins.text)) }

// 9. rc13f contextual menu (PM 2026-10-11): menu taps carry their own values, recovered by readback; Flow entries send the existing Flow
check('MENU keyword: menu / Menu! / options recognised; a sentence containing "menu" is not', A.MENU_RE.test('menu') && A.MENU_RE.test('Menu!') && A.MENU_RE.test(' options ') && !A.MENU_RE.test('show me the menu of plans'))
check('menu titles <= 20 chars (WhatsApp reply-button limit) and values unique', Object.values(A.MENU_BTN).every((b) => b.title.length <= 20) && A.MENU_VALUES.size === Object.keys(A.MENU_BTN).length)
{ const w = world({ j: J.no_line }); const r = await w.h._runAction(who('menu-nl'), 'menu'); const p = lastPost(w)
  check('menu @ no_line: Get my number / How it works / Talk to a person (one message)', r.ok && w.posts.length === 1 && same(postTitles(p), ['Get my number', 'How it works', 'Talk to a person']), postTitles(p).join('/')) }
{ const w = world({ j: J.active }); const r = await w.h._runAction(who('menu-ac'), 'menu'); const p = lastPost(w)
  check('menu @ active line: Manage my line / How it works / Talk to a person', r.ok && same(postTitles(p), ['Manage my line', 'How it works', 'Talk to a person']), postTitles(p).join('/')) }
{
  const msgs = [offered(50, [A.MENU_BTN.signup, A.MENU_BTN.how, A.BTN.human]), cust(51, 'Get my number')]
  check('menu tap "Get my number" maps by its MENU value -> menu_flow', A.resolveTap(msgs, 51, 'Get my number')?.action === 'menu_flow' && A.resolveTap(msgs, 51, 'Get my number')?.value === 'menu_signup')
  check('menu tap "How it works" -> how_it_works (static facts, deterministic)', A.resolveTap([offered(60, [A.MENU_BTN.manage, A.MENU_BTN.how, A.BTN.human])], 61, 'How it works')?.value === 'menu_how')
  check('menu "Talk to a person" stays the relay\'s direct handoff (not an adapter action)', A.resolveTap([offered(70, [A.MENU_BTN.manage, A.MENU_BTN.how, A.BTN.human])], 71, 'Talk to a person') === null)
  check('CONTROL the journey\'s own "Get my number" keeps its non-menu value (agent path unchanged)', A.resolveTap([offered(80, A.choicesFor(J.no_line.actions))], 81, 'Get my number')?.value !== 'menu_signup')
}
{ const w = world({ j: J.no_line }); const r = await w.h._runAction(who('mf-nl'), 'menu_flow')
  check('menu_flow @ no_line: sends the signup Flow launch message, posts nothing else', r.ok && r.result.code === 'menu_flow_sent' && w.calls.includes('flows/launch') && w.posts.length === 0) }
{ const w = world({ j: J.active }); const r = await w.h._runAction(who('mf-ac'), 'menu_flow')
  check('menu_flow @ active line: sends the SAME Flow (opens as "Manage your line")', r.ok && r.result.code === 'menu_flow_sent' && r.result.existing_line === true && w.calls.includes('flows/launch')) }
{ const w = world({ j: J.active }); await w.h._runAction(who('gn-ac'), 'get_number')
  check('CONTROL get_number @ active does NOT relaunch setup (unchanged)', !w.calls.includes('flows/launch')) }
{ const w = world({ j: J.active, status: 'open' }); const r = await w.h._runAction(who('menu-open'), 'menu')
  check('menu while a person holds the conversation -> refused, nothing posted', !r.ok && w.posts.length === 0) }

// 8. controls + MCP exposure + routes
check('every action title <= 20 chars and unique', Object.values(A.ACT).every((c) => c.title.length <= 20) && new Set(Object.values(A.ACT).map((c) => c.title)).size === Object.keys(A.ACT).length)
{
  const { server } = A.makeServer({ plKey: 'k'.repeat(32), plKid: 'k1', accountTools: true, bearer: 'b', sourceCidrs: [], ctxKid: 'c1', ctxKey: 'c'.repeat(32) }, { async query() { return { rows: [], rowCount: 0 } } }, fetch)
  await new Promise((res) => server.listen(0, '127.0.0.1', res))
  const port = server.address().port
  const j = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', headers: { authorization: 'Bearer b', 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) }).then((x) => x.json())
  const names = j.result.tools.map((x) => x.name)
  check('tools/list exposes pl_journey + pl_guide, never pl_explain or internal actions', names.includes('pl_journey') && names.includes('pl_guide') && !names.includes('pl_explain') && !names.some((x) => x.startsWith('_')), names.join(','))
  const noBearer = await fetch(`http://127.0.0.1:${port}/v1/action`, { method: 'POST', body: '{}' })
  const withBearer = await fetch(`http://127.0.0.1:${port}/v1/action`, { method: 'POST', headers: { authorization: 'Bearer b' }, body: JSON.stringify({ action: 'auto', context: 'x' }) }).then((x) => x.json())
  check('/v1/action without the bearer -> 401; with it, a bad context is identity_unverified', noBearer.status === 401 && withBearer.code === 'identity_unverified')
  const pro = await fetch(`http://127.0.0.1:${port}/v1/proactive`, { method: 'POST', body: '{}' })
  check('/v1/proactive unsigned -> 401', pro.status === 401)
  server.close()
}
// 10. rc13h send-eligibility (/v1/eligibility): ownership + STOP + the real 24 h window + consent, answering only. Positive twin for each negative.
const esign = (cfg, body) => crypto.createHmac('sha256', Buffer.from(cfg.plKey, 'utf8')).update(`${A.ELIGIBILITY_PURPOSE}.${body}`, 'utf8').digest('base64url')
const ereq = (cfg, over = {}) => { const body = JSON.stringify({ kid: cfg.plKid, wa_id: WA, ref: 'cw-77', iat: Math.floor(Date.now() / 1000), nonce: crypto.randomBytes(16).toString('base64url'), ...over }); return { body, sig: esign(cfg, body) } }
async function elig(w, over = {}, wrap = null) { const { body, sig } = ereq(w.cfg, over); const v = A.verifyEligibility(body, sig, w.cfg); if (!v.ok) return { eligible: false, reason: 'unauthorized:' + v.why }; return A.handleEligibility(w.cfg, w.db, {}, v.b, wrap ? wrap(w.f) : w.f) }
const failing = (re) => (f) => async (url, init) => { if (re.test(String(url))) return { ok: false, status: 500, json: async () => ({}) }; return f(url, init) }
{ const w = world({ j: J.active }); const r = await elig(w); check('elig: pending + window open + consent known + no STOP -> eligible/ok (conversation echoed)', r.eligible === true && r.reason === 'ok' && r.conversation_id === '77', JSON.stringify(r)); check('elig: answers only - nothing posted, no guidance/claim row written', w.posts.length === 0 && w.db.g.length === 0) }
{ const w = world({ j: J.active }); const hdrs = []; const spy = (f) => async (url, init) => { if (String(url).startsWith('http://pl/')) hdrs.push({ a: init.headers['x-isola-assertion'], c: init.headers['x-conversation-id'] }); return f(url, init) }
  await elig(w, {}, spy); const pj = hdrs.length ? JSON.parse(Buffer.from(hdrs[0].a.split('.')[1], 'base64url').toString('utf8')) : null
  check('elig: the consent read it makes carries rid elig-77 (== X-Conversation-Id), NOT cw-77, so it cannot refresh the PL service inbound-window proxy', hdrs.length === 1 && pj.rid === 'elig-77' && hdrs[0].c === 'elig-77', JSON.stringify(pj)) }
{ const w = world({ j: J.active, status: 'open' }); const r = await elig(w); check('elig: human-owned (open) -> not eligible, human_owned', r.eligible === false && r.reason === 'human_owned' && r.detail === 'status_open', JSON.stringify(r)) }
{ const w = world({ j: J.active, status: 'resolved' }); const r = await elig(w); check('elig: resolved conversation is not AI-owned -> human_owned (same rule as /v1/proactive)', r.eligible === false && r.reason === 'human_owned') }
{ const w = world({ j: J.active }); await w.h._setPreference({ ...who('stop-e') }, true); const r = await elig(w); check('elig: adapter STOP -> stopped', r.eligible === false && r.reason === 'stopped' && r.detail === 'adapter_stop')
  await w.h._setPreference({ ...who('start-e') }, false); const r2 = await elig(w); check('elig: CONTROL after START -> eligible again', r2.eligible === true) }
{ const w = world({ j: { ...J.active, consent: { estate_suppressed: true, known: true } } }); const r = await elig(w); check('elig: estate STOP (doNotContact / revoked opt-in) -> stopped/estate_suppressed', r.eligible === false && r.reason === 'stopped' && r.detail === 'estate_suppressed') }
{ const w = world({ j: { ...J.active, consent: { estate_suppressed: false, known: false } } }); const r = await elig(w); check('elig: consent unreadable -> consent_unknown (fail closed)', r.eligible === false && r.reason === 'consent_unknown') }
{ const w = world({ j: J.active, lastInboundAgoS: 25 * 3600 }); const r = await elig(w); check('elig: last inbound 25 h ago -> window_closed', r.eligible === false && r.reason === 'window_closed') }
{ const w = world({ j: J.active, lastInboundAgoS: 23 * 3600 }); const r = await elig(w); check('elig: CONTROL last inbound 23 h ago -> eligible', r.eligible === true) }
{ const w = world({ j: J.active, messages: [{ id: 1, message_type: 1, private: false, sender_type: 'User', content: 'agent reply', created_at: Math.floor(Date.now() / 1000) - 10 }] }); const r = await elig(w); check('elig: only OUTGOING messages on record (no customer inbound) -> window_unknown, not eligible', r.eligible === false && r.reason === 'window_unknown') }
{ const w = world({ j: J.active }); const r = await elig(w, {}, failing(/\/conversations\/77\/messages$/)); check('elig: Chatwoot messages unreadable -> window_unknown (fail closed)', r.eligible === false && r.reason === 'window_unknown' && r.detail === 'messages_unreadable') }
{ const w = world({ j: J.active }); const r = await elig(w, {}, failing(/\/conversations\/77$/)); check('elig: Chatwoot conversation unreadable -> unavailable (fail closed)', r.eligible === false && r.reason === 'unavailable') }
{ const w = world({ j: J.active }); const r = await elig(w, {}, failing(/\/contacts\/search/)); check('elig: Chatwoot unreachable at lookup -> unavailable', r.eligible === false && r.reason === 'unavailable') }
{ const w = world({ j: J.active, contactSearch: [] }); const r = await elig(w); check('elig: no Chatwoot contact -> no_conversation', r.eligible === false && r.reason === 'no_conversation') }
{ const w = world({ j: J.active }); const r = await elig(w, {}, failing(/^http:\/\/pl\//)); check('elig: PL service (consent source) down -> unavailable (fail closed)', r.eligible === false && r.reason === 'unavailable') }
{ const w = world({ j: J.active }); let n = 0; const flip = (f) => async (url, init) => { const u = String(url); if (/\/conversations\/77$/.test(u) && ++n === 2) return { ok: true, status: 200, json: async () => ({ id: 77, inbox_id: 11, status: 'open', meta: { sender: { id: 5 } } }) }; return f(url, init) }
  const r = await elig(w, {}, flip); check('elig: person takes the conversation between the checks (final re-read) -> human_owned', r.eligible === false && r.reason === 'human_owned') }
{ const w = world({ j: J.active }); const a = ereq(w.cfg, { ref: 'cw-77' })
  check('elig auth: valid signed request verifies', A.verifyEligibility(a.body, a.sig, w.cfg).ok)
  check('elig auth: forged signature refused', A.verifyEligibility(a.body, 'x'.repeat(43), w.cfg).why === 'bad_signature')
  check('elig auth: tampered body (other wa_id) refused', A.verifyEligibility(a.body.replace(WA, '17670000002'), a.sig, w.cfg).why === 'bad_signature')
  const old = ereq(w.cfg, { iat: Math.floor(Date.now() / 1000) - 600 }); check('elig auth: expired (iat 10 min old) refused', A.verifyEligibility(old.body, old.sig, w.cfg).why === 'stale_or_wrong_key')
  const fut = ereq(w.cfg, { iat: Math.floor(Date.now() / 1000) + 600 }); check('elig auth: future iat refused', !A.verifyEligibility(fut.body, fut.sig, w.cfg).ok)
  const wk = ereq(w.cfg, { kid: 'other' }); check('elig auth: wrong key id refused', !A.verifyEligibility(wk.body, wk.sig, w.cfg).ok)
  const nn = ereq(w.cfg, { nonce: 'short' }); check('elig auth: missing/short nonce refused', A.verifyEligibility(nn.body, nn.sig, w.cfg).why === 'bad_fields')
  const bw = ereq(w.cfg, { wa_id: '12ab' }); check('elig auth: bad wa_id refused', A.verifyEligibility(bw.body, bw.sig, w.cfg).why === 'bad_fields')
  const pro = req(w.cfg, 'first_call'); check('elig auth: a /v1/proactive signature (other purpose) cannot be replayed as an eligibility request', !A.verifyEligibility(pro.body, pro.sig, w.cfg).ok)
  const nc = A.makeNonceCache(); check('elig nonce: first use accepted, replay refused, another nonce accepted', nc.claim('a'.repeat(22), 1000) === true && nc.claim('a'.repeat(22), 2000) === false && nc.claim('b'.repeat(22), 2000) === true)
  check('elig nonce: expired entries are forgotten (cache cannot grow without bound)', nc.claim('a'.repeat(22), 1000 + 300000) === true) }
{ // over HTTP, through the real server: own signature (no bearer), unsigned 401, replay 409, bearer alone 401, positive twin 200
  const w = world({ j: J.active }); const { server } = A.makeServer(w.cfg, w.db, w.f)
  await new Promise((res) => server.listen(0, '127.0.0.1', res)); const port = server.address().port
  const post = (body, sig) => fetch(`http://127.0.0.1:${port}/v1/eligibility`, { method: 'POST', headers: sig ? { 'x-pl-eligibility-signature': sig } : {}, body })
  const un = await post('{}'); check('elig http: unsigned -> 401', un.status === 401)
  const a = ereq(w.cfg); const ok1 = await post(a.body, a.sig); const j1 = await ok1.json(); check('elig http: CONTROL signed -> 200 eligible', ok1.status === 200 && j1.eligible === true && j1.reason === 'ok', JSON.stringify(j1))
  const again = await post(a.body, a.sig); check('elig http: the SAME signed request replayed -> 409, no answer', again.status === 409)
  const bearerOnly = await fetch(`http://127.0.0.1:${port}/v1/eligibility`, { method: 'POST', headers: { authorization: 'Bearer b' }, body: a.body }); check('elig http: the bearer alone does not authenticate it -> 401', bearerOnly.status === 401)
  server.close() }
// 11. rc13i (R1 slice S-c): the 'My account' menu button -> a one-time portal sign-in link, posted ONLY into the verified sender's own conversation.
// Every refusal has a positive twin in the same run. The feature is dark unless cfg.myAccountLink is on (PL_MY_ACCOUNT_LINK=1).
const on = (w) => { w.cfg.myAccountLink = true; return w }
const urlPosts = (w) => w.posts.filter((p) => String(p.content).includes(LINK_URL))
{ const w = world({ j: J.active }); const r = await w.h._runAction(who('menu-off'), 'menu'); check('rc13i OFF (default): line-holder menu is exactly rc13h - Manage my line / How it works / Talk to a person', same(postTitles(lastPost(w)), ['Manage my line', 'How it works', 'Talk to a person']), postTitles(lastPost(w)).join('/')) }
{ const w = on(world({ j: J.active })); await w.h._runAction(who('menu-on'), 'menu'); check('rc13i ON: line-holder menu offers My account in place of How it works, still exactly 3 reply buttons', same(postTitles(lastPost(w)), ['Manage my line', 'My account', 'Talk to a person']), postTitles(lastPost(w)).join('/')) }
{ const w = on(world({ j: J.no_line })); await w.h._runAction(who('menu-nl2'), 'menu'); check('rc13i ON: a customer with NO line never sees My account', same(postTitles(lastPost(w)), ['Get my number', 'How it works', 'Talk to a person'])) }
check('rc13i: My account title <= 20 chars, value unique, tap resolves to my_account by readback', A.MENU_BTN.account.title.length <= 20 && A.MENU_VALUES.has('menu_account') && A.resolveTap([offered(80, [A.MENU_BTN.manage, A.MENU_BTN.account, A.BTN.human])], 81, 'My account')?.action === 'my_account')
{ const w = world({ j: J.active }); const r = await w.h._runAction(who('acct-off'), 'my_account'); check('rc13i OFF: the action is refused (feature_disabled), nothing minted, nothing posted', !r.ok && r.result.code === 'feature_disabled' && w.posts.length === 0 && !w.calls.includes('account/portal-link')) }
{ const w = on(world({ j: J.active })); const r = await w.h._runAction(who('acct-ok'), 'my_account')
  check('rc13i: eligible verified sender -> exactly ONE message in conversation 77 carrying the link + My account / person buttons', r.ok && r.result.code === 'message_sent' && w.posts.length === 1 && urlPosts(w).length === 1 && same(postTitles(lastPost(w)), ['My account', 'Talk to a person']), JSON.stringify(r.result))
  check('rc13i: the PL service was asked once, with NO body (identity is the assertion only: no typed phone/email/account id)', w.calls.filter((c) => c === 'account/portal-link').length === 1)
  check('rc13i: the reply tells the truth about the link (once, ~10 minutes, do not forward) and names no number', /works once/.test(lastPost(w).content) && /10 minutes/.test(lastPost(w).content) && !/\+1 767|17670000001/.test(lastPost(w).content))
  const again = await w.h._runAction(who('acct-ok'), 'my_account'); check('rc13i: the SAME customer message replayed -> not re-sent, not re-minted', again.ok && again.result.already === true && w.posts.length === 1 && w.calls.filter((c) => c === 'account/portal-link').length === 1)
  const next = await w.h._runAction(who('acct-ok-2'), 'my_account'); check('rc13i: a later tap (new message) sends a fresh link (positive twin of the replay refusal)', next.ok && w.posts.length === 2) }
{ const w = on(world({ j: J.active })); for (let i = 0; i < 3; i++) await w.h._runAction(who(`acct-r${i}`), 'my_account')
  const r = await w.h._runAction(who('acct-r3'), 'my_account'); check('rc13i: more than 3 links in 10 minutes -> honest rate-limit message, no 4th mint', r.ok && w.calls.filter((c) => c === 'account/portal-link').length === 3 && /moment ago/.test(lastPost(w).content) && urlPosts(w).length === 3) }
{ const w = on(world({ j: J.active, status: 'open' })); const r = await w.h._runAction(who('acct-human'), 'my_account'); check('rc13i: a person owns the conversation (open) -> nothing minted, nothing posted', !r.ok && r.result.code === 'not_eligible' && r.result.reason === 'human_owned' && w.posts.length === 0 && !w.calls.includes('account/portal-link')) }
{ const w = on(world({ j: J.active })); await w.h._setPreference(who('acct-stop-pref'), true); const before = w.posts.length; const r = await w.h._runAction(who('acct-stop'), 'my_account'); check('rc13i: customer sent STOP -> nothing minted, nothing posted (twin: START re-enables)', !r.ok && r.result.reason === 'stopped' && w.posts.length === before && !w.calls.includes('account/portal-link'))
  await w.h._setPreference(who('acct-start-pref'), false); const r2 = await w.h._runAction(who('acct-start'), 'my_account'); check('rc13i: after START the same action sends the link', r2.ok && urlPosts(w).length === 1) }
{ const w = on(world({ j: { ...J.active, consent: { estate_suppressed: true, known: true } } })); const r = await w.h._runAction(who('acct-estate'), 'my_account'); check('rc13i: estate STOP (Meta STOP / doNotContact) -> nothing minted', !r.ok && r.result.reason === 'stopped' && !w.calls.includes('account/portal-link') && w.posts.length === 0) }
{ const w = on(world({ j: { ...J.active, consent: { estate_suppressed: false, known: false } } })); const r = await w.h._runAction(who('acct-consent'), 'my_account'); check('rc13i: consent unreadable -> fail closed, nothing minted', !r.ok && r.result.reason === 'consent_unknown' && !w.calls.includes('account/portal-link')) }
{ const w = on(world({ j: J.active, lastInboundAgoS: 25 * 3600 })); const r = await w.h._runAction(who('acct-window'), 'my_account'); check('rc13i: 24 h window closed -> nothing minted, nothing posted', !r.ok && r.result.reason === 'window_closed' && !w.calls.includes('account/portal-link') && w.posts.length === 0) }
{ const w = on(world({ j: J.active })); const bad = (f) => async (url, init) => { if (/\/conversations\/77\/messages$/.test(String(url)) && !init?.method) throw new Error('down'); return f(url, init) }
  w.h = A.makeHandlers(w.cfg, w.db, {}, bad(w.f)); const r = await w.h._runAction(who('acct-cwdown'), 'my_account'); check('rc13i: Chatwoot messages unreadable -> window_unknown, nothing minted (fail closed)', !r.ok && !w.calls.includes('account/portal-link')) }
{ const w = on(world({ j: J.no_line })); const r = await w.h._runAction(who('acct-noline'), 'my_account'); check('rc13i: no line -> the no-line menu, never an account link or error', r.ok && !w.calls.includes('account/portal-link') && same(postTitles(lastPost(w)), EXPECT.no_line)) }
{ for (const [label, portal] of [['portal_link_unavailable', { code: 'portal_link_unavailable', status: 'error', data: {} }], ['rate_limited by the PL service', { code: 'rate_limited', status: 'rate_limited', data: { retry_after_s: 600 } }], ['bad_response', { code: 'bad_response' }], ['malformed url (http, not https)', { code: 'portal_link', data: { url: 'http://uplink.example.test/customer/pl-ws/wa-link?token=x', expires_at: new Date(Date.now() + 600000).toISOString() } }], ['missing url', { code: 'portal_link', data: {} }]]) {
    const w = on(world({ j: J.active, portal })); const r = await w.h._runAction(who('acct-' + label.replace(/\W/g, '')), 'my_account')
    check(`rc13i fail closed: PL service ${label} -> one honest message, no link, no "on its way"`, r.ok && w.posts.length === 1 && !/https?:\/\//.test(lastPost(w).content) && !/on its way|coming|shortly sent/i.test(lastPost(w).content) && /(can't open your account page|moment ago)/.test(lastPost(w).content)) } }
{ const w = on(world({ j: J.active })); const bad = (f) => async (url, init) => { if (/\/conversations\/77\/messages$/.test(String(url)) && init?.method === 'POST') return { ok: false, status: 500, json: async () => ({}) }; return f(url, init) }
  w.h = A.makeHandlers(w.cfg, w.db, {}, bad(w.f)); const r = await w.h._runAction(who('acct-sendfail'), 'my_account'); check('rc13i: Chatwoot send fails after the mint -> refusal, claim released (the tap can be retried), nothing recorded as sent', !r.ok && w.db.g.length === 0) }
{ // over the real HTTP server: the tap is deterministic (menu values are always deterministic, even with PL_DETERMINISTIC_TAPS=0)
  const w = on(world({ j: J.active, messages: [{ id: 100, message_type: 0, private: false, sender_type: 'Contact', source_id: 'wamid.ABCDEFGHIJKL', content: 'My account', created_at: Math.floor(Date.now() / 1000) - 30 }, offered(90, [A.MENU_BTN.manage, A.MENU_BTN.account, A.BTN.human])] }))
  check('rc13i: the tap resolves by readback of what WE offered (a customer typing "My account" with no offered button is not a tap)', A.resolveTap(w.cfg && [offered(90, [A.MENU_BTN.manage, A.MENU_BTN.account, A.BTN.human])], 91, 'My account')?.action === 'my_account' && A.resolveTap([], 91, 'My account') === null) }
console.log(`${n - fails}/${n} ` + (fails ? 'FAILED' : 'ALL PASSED')); setTimeout(() => process.exit(fails ? 1 : 0), 50)
