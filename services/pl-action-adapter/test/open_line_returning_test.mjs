// adapter - returning, CONNECTED line holder gets the supported "Open my line" action (owner Android walkthrough 2026-10-22).
// Isolated: no model, no network, no real customer. argv: <abs path to pl-action-adapter.mjs>
// Fakes the PL service (records every endpoint + body it is asked), Chatwoot (status, posts) and the adapter DB.
// Every absence assertion has a positive twin in the same run.
const [, , adapterPath] = process.argv
const A = await import('file:///' + adapterPath.replace(/\\/g, '/'))
let fails = 0, n = 0
const check = (name, ok, x = '') => { n++; if (!ok) fails++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (x ? ' | ' + x : '')) }

const F = { did_pretty: '+1 767 818 5108', registration: 'registered', softphone_activated: true, first_call_done: true, minutes_remaining: 0, minutes_included: 60, low: false, expires_date_pretty: 'October 21, 2026', wallet_xcd: '5.00' }
const PAY = { topup_available: false, rail: 'fiserv', reason: 'fiserv_topup_not_available_in_chat' }
const J = {
  // the owner's returning customer: connected, wallet 5.00, no active plan -> plan_ended -> state 'attention'
  attention: { state: 'attention', next_action: 'balance', actions: ['balance', 'plans', 'human'], attention: ['plan_ended'], registration_known: true, has_line: true, facts: F, payment: PAY, consent: { estate_suppressed: false, known: true } },
  active: { state: 'active', next_action: 'balance', actions: ['balance', 'recent_calls', 'calling_help'], attention: [], registration_known: true, has_line: true, facts: F, payment: PAY, consent: { estate_suppressed: false, known: true } },
  no_line: { state: 'no_line', next_action: 'get_number', actions: ['get_number', 'how_it_works', 'plans'], attention: [], registration_known: false, has_line: false, facts: null, payment: PAY },
}
const RELEASE_SQL = 'DELETE FROM pl_adapter_guidance WHERE id=$1'
function fakeDb() {
  const g = []; let seq = 0
  return { g, async query(sql, p = []) {
    const s = sql.replace(/\s+/g, ' ').trim()
    if (s.startsWith('INSERT INTO pl_adapter_guidance')) {
      if (g.some((r) => r.c === p[0] && r.h === p[1] && r.m === p[2] && r.e === p[3])) return { rows: [], rowCount: 0 }
      const r = { id: ++seq, c: p[0], h: p[1], m: p[2], e: p[3], stage: null }; g.push(r); return { rows: [{ id: r.id }], rowCount: 1 }
    }
    if (s.startsWith('UPDATE pl_adapter_guidance SET stage')) { const r = g.find((x) => x.id === p[0]); if (r) r.stage = p[1]; return { rows: [], rowCount: r ? 1 : 0 } }
    if (s === RELEASE_SQL) { const i = g.findIndex((x) => x.id === p[0]); if (i >= 0) g.splice(i, 1); return { rows: [], rowCount: i >= 0 ? 1 : 0 } }
    throw new Error('unexpected SQL: ' + s.slice(0, 80))
  } }
}
const WA = '17670000001'
function world({ j, status = 'pending', nextStep = null } = {}) {
  const posts = [], calls = [], bodies = []
  const f = async (url, init) => {
    const u = String(url); const ok = (b) => ({ ok: true, status: 200, json: async () => b })
    if (u.startsWith('http://pl/')) {
      const ep = u.split('/v1/')[1]; calls.push(ep); try { bodies.push([ep, JSON.parse(init?.body ?? '{}')]) } catch { bodies.push([ep, null]) }
      if (ep === 'account/journey') return ok({ code: 'journey', data: j })
      if (ep === 'account/next-step') return ok(nextStep ?? { code: 'buttons_sent', data: { stage: 'connected', buttons: 1, include_app: false } })
      return ok({ code: 'bad_response' })
    }
    if (u.startsWith('http://cw/')) {
      const path = u.split('/accounts/2')[1]
      if (init?.method === 'POST') { posts.push(JSON.parse(init.body)); return ok({ id: 9000 + posts.length }) }
      if (path === '/conversations/77') return ok({ id: 77, inbox_id: 11, status })
    }
    throw new Error('unexpected fetch ' + u)
  }
  const cfg = { plKey: 'k'.repeat(32), plKid: 'k1', plPnid: '1023804347491554', plBase: 'http://pl', cwBase: 'http://cw', cwAccount: 2, cwInbox: 11, cwToken: 't', timeoutMs: 1000, flowOnboarding: true, accountTools: true, bearer: 'b', sourceCidrs: [], ctxKid: 'c1', ctxKey: 'c'.repeat(32), workspaceId: 'w'.repeat(36), agentId: '28a55c69-ef04-416f-9c91-7d72e9e21345', agentSlug: 'slug' }
  const h = A.makeHandlers(cfg, fakeDb(), {}, f)
  return { posts, calls, bodies, h }
}
const who = (mid = 'm1') => ({ waId: WA, wamid: 'wamid.T1234567890', conversationId: '77', messageId: mid, content: '' })
const titles = (cs) => (cs ?? []).map((c) => c.title)
const PROVISION_EPS = ['lines/provision', 'links/activation']

// 1. the buttons attached to the reply for a returning connected customer (pl_journey = what the model reply carries)
for (const [name, jn, want] of [
  ['attention (owner case: connected, no active plan, wallet 5.00)', J.attention, ['Open my line', 'Plans & prices', 'Talk to a person']],
  ['CONTROL active (unchanged)', J.active, ['Open my line', 'Balance', 'Calling help']],
  ['CONTROL no line (must NOT offer Open my line)', J.no_line, ['Get my number', 'How it works', 'Plans & prices']],
]) {
  const w = world({ j: jn }); const r = await w.h.pl_journey(who())
  check(`journey buttons - ${name}`, r.ok && JSON.stringify(titles(r.result.choices)) === JSON.stringify(want) && w.posts.length === 0, titles(r.result?.choices).join(' / '))
}
check('attention keeps a person reachable (last button)', titles(A.stateChoices(J.attention)).at(-1) === 'Talk to a person')
check('attention with has_line false never offers Open my line', !titles(A.stateChoices({ ...J.attention, has_line: false })).includes('Open my line'))

// 2. tapping it: one next-step call asking for the buttons, NO provisioning, no link/credential in what the adapter returns or posts
{
  const w = world({ j: J.attention }); const r = await w.h._runAction(who('m-tap'), 'open_line')
  const ns = w.bodies.filter(([ep]) => ep === 'account/next-step')
  check('tap Open my line: ONE account/next-step asking deliver=buttons', ns.length === 1 && ns[0][1].deliver === 'buttons' && ns[0][1].event === 'resend', JSON.stringify(ns))
  check('tap Open my line: NO provisioning / activation-mint endpoint is called by the adapter', !w.calls.some((c) => PROVISION_EPS.includes(c)), w.calls.join(','))
  check('tap Open my line: result is buttons_sent, include_app=false (existing line: Open my line only)', r.ok && r.result.code === 'buttons_sent' && r.result.include_app === false, JSON.stringify(r.result).slice(0, 160))
  const blob = JSON.stringify([r, w.posts])
  check('tap Open my line: no URL, token or credential in what the adapter returns/posts', !/https?:\/\/|go\.uplink|token|password|sip_pass|csc:/i.test(blob), blob.slice(0, 120))
  check('POSITIVE CONTROL of the leak scan: a result that did contain a link WOULD be caught', /https?:\/\//i.test(JSON.stringify({ x: 'https://go.uplink.epic.dm/go/abc' })))
}
// 3. replay of the same customer message: no second send
{
  const w = world({ j: J.attention }); await w.h._runAction(who('m-replay'), 'open_line'); const r2 = await w.h._runAction(who('m-replay'), 'open_line')
  check('replay of the same message: no second account/next-step', w.calls.filter((c) => c === 'account/next-step').length === 1 && r2.result?.already === true)
  const w2 = world({ j: J.attention }); await w2.h._runAction(who('m-a'), 'open_line'); await w2.h._runAction(who('m-b'), 'open_line')
  check('CONTROL: a different customer message DOES ask again (the claim is per message)', w2.calls.filter((c) => c === 'account/next-step').length === 2)
}
// 4. a human-owned conversation gets nothing
{
  const w = world({ j: J.attention, status: 'open' }); const r = await w.h._runAction(who('m-open'), 'open_line')
  check('conversation owned by a person: nothing requested', !w.calls.includes('account/next-step') && JSON.stringify(r).includes('buttons_sent') === false, JSON.stringify(r).slice(0, 120))
}
// 5. service refusals are reported, never a fake success
{
  const w = world({ j: J.attention, nextStep: { code: 'link_rate_limited', data: { retry_after_s: 900 } } }); const r = await w.h._runAction(who('m-rl'), 'open_line')
  check('rate limited: no buttons_sent claimed', JSON.stringify(r).includes('"buttons_sent"') === false)
}
console.log(`\n${n - fails}/${n} passed`)
process.exit(fails ? 1 : 0)
