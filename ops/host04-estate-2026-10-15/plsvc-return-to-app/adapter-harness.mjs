// Drives the REAL makeHandlers of an adapter file with stubbed plsvc / Chatwoot / database. Usage: node adapter-harness.mjs <path-to-adapter.mjs>
// The in-memory DB stub answers the adapter's own statements exactly (claim INSERT, scoped release, stage UPDATE, prior-stage SELECT).
import { pathToFileURL } from 'node:url'
const M = await import(pathToFileURL(process.argv[2]).href)
let pass = 0, fail = 0
const check = (id, ok, d = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'} ${id}${d ? ' :: ' + d : ''}`) }

function world({ state = 'active', hasLine = true, conv = 'pending', buttons = { code: 'buttons_sent', data: { include_app: false, buttons: 1 } }, plThrows = false } = {}) {
  const calls = [], posts = [], rows = new Map()
  const RELEASE = 'DELETE FROM pl_adapter_guidance WHERE id=$1'
  const db = { async query(sql, params) {
    if (sql.startsWith('INSERT INTO pl_adapter_guidance')) { const k = params.join('|'); if (rows.has(k)) return { rowCount: 0, rows: [] }; const id = rows.size + 1 + Math.random(); rows.set(k, { id, stage: null }); return { rowCount: 1, rows: [{ id }] } }
    if (sql === RELEASE) { for (const [k, v] of rows) if (v.id === params[0]) rows.delete(k); return { rowCount: 1 } }
    if (sql.startsWith('UPDATE pl_adapter_guidance')) { for (const v of rows.values()) if (v.id === params[0]) v.stage = params[1]; return { rowCount: 1 } }
    if (sql.startsWith('SELECT')) return { rows: [{ stage: null }] }
    return { rowCount: 0, rows: [] }
  } }
  const f = async (url, init = {}) => {
    const u = String(url)
    if (u.includes('/pl-concierge/v1/')) {
      const ep = u.split('/pl-concierge/v1/')[1]; const body = JSON.parse(init.body || '{}'); calls.push({ ep, body })
      if (ep === 'account/journey') return new Response(JSON.stringify({ code: 'journey', data: { state, has_line: hasLine, facts: { did_pretty: '+1 (767) 818-5102' }, actions: ['balance', 'recent_calls', 'calling_help'] } }))
      if (ep === 'account/next-step' && body.deliver === 'buttons') { if (plThrows) throw new Error('timeout'); return new Response(JSON.stringify(buttons)) }
      if (ep === 'flows/launch') return new Response(JSON.stringify({ code: 'flow_sent', data: {} }))
      return new Response(JSON.stringify({ code: 'bad_response' }))
    }
    if (u.endsWith('/conversations/526') && (init.method ?? 'GET') === 'GET') return new Response(JSON.stringify({ status: conv }))
    if (u.endsWith('/conversations/526/messages') && init.method === 'POST') { posts.push(JSON.parse(init.body)); return new Response(JSON.stringify({ id: 9000 + posts.length })) }
    return new Response('{}', { status: 404 })
  }
  const cfg = { plBase: 'http://pl', plKid: 'pl2', plKey: 'k'.repeat(40), plPnid: '1023804347491554', cwBase: 'http://cw', cwAccount: 2, cwToken: 't', timeoutMs: 2000, flowOnboarding: true }
  return { h: M.makeHandlers(cfg, db, {}, f), calls, posts, rows }
}
const who = (mid = '6100') => ({ waId: '17672859610', conversationId: '526', messageId: mid, wamid: `wamid.HBgL${mid}AAAA` })
const nButtons = (calls) => calls.filter((c) => c.ep === 'account/next-step' && c.body.deliver === 'buttons').length

{ // 1. Calling help offers Open my line (not the looping pair); legacy values still resolve
  const w = world(); await w.h._runAction(who('6101'), 'calling_help')
  const titles = (w.posts[0]?.content_attributes?.items ?? []).map((i) => i.title)
  check('calling help buttons are Open my line / A call failed / Talk to a person', JSON.stringify(titles) === JSON.stringify(['Open my line', 'A call failed', 'Talk to a person']), JSON.stringify(titles))
  check('legacy pl_call_dm still maps', M.VALUE_TO_ACTION.pl_call_dm === 'call_dominica')
  check('pl_open_line maps to open_line', M.VALUE_TO_ACTION.pl_open_line === 'open_line')
}
{ // 2. Open my line: exactly one plsvc delivery per customer message, no Chatwoot text
  const w = world(); await w.h._runAction(who('6102'), 'open_line'); const b = await w.h._runAction(who('6102'), 'open_line')
  check('open_line delivers once per customer message', nButtons(w.calls) === 1 && w.posts.length === 0, `deliveries=${nButtons(w.calls)} posts=${w.posts.length}`)
  check('a repeat for the same message reports already-sent', JSON.stringify(b).includes('already'))
}
{ // 3. A person owns the conversation: nothing is sent
  const w = world({ conv: 'open' }); await w.h._runAction(who('6103'), 'open_line')
  check('human-owned: no delivery and no post', nButtons(w.calls) === 0 && w.posts.length === 0)
}
// 4. pl_next_step for a line holder whose buttons fail must NEVER fall back to the Manage Flow
for (const [label, opts] of [['human-owned', { conv: 'open' }], ['partial send', { buttons: { code: 'buttons_unavailable', data: { buttons: 2 } } }], ['timeout', { plThrows: true }], ['mint failed', { buttons: { code: 'internal_error', data: {} } }]]) {
  const w = world(opts); await w.h.pl_next_step(who('6104'), {})
  check(`pl_next_step line holder, ${label}: no Flow launch`, !w.calls.some((c) => c.ep === 'flows/launch'))
}
{ const w = world({ hasLine: false, state: 'no_line' }); await w.h.pl_next_step(who('6105'), {}); check('CONTROL: a new customer still gets the signup Flow', w.calls.some((c) => c.ep === 'flows/launch')) }
{ // 5. flow_done after the v8 signup
  const w = world({ state: 'setup_not_activated', buttons: { code: 'buttons_sent', data: { include_app: true, buttons: 3 } } }); await w.h._runAction(who('6106'), 'flow_done')
  check('flow_done fresh line: setup buttons, no text', nButtons(w.calls) === 1 && w.posts.length === 0)
}
{ const w = world({ state: 'setup_not_activated', plThrows: true }); await w.h._runAction(who('6107'), 'flow_done'); check('flow_done timeout: adapter adds no second message', w.posts.length === 0) }
{ const w = world({ state: 'setup_not_activated', buttons: { code: 'internal_error', data: {} } }); await w.h._runAction(who('6110'), 'flow_done'); check('flow_done mint failed (nothing sent): completion text fallback', w.posts.length === 1) }
{ const w = world({ state: 'setup_not_activated', buttons: { code: 'link_rate_limited', data: {} } }); await w.h._runAction(who('6108'), 'flow_done'); check('flow_done rate-limited (nothing sent): completion text fallback', w.posts.length === 1) }
{ const w = world({ state: 'active' }); await w.h._runAction(who('6109'), 'flow_done'); check('flow_done active line: unchanged completion text, no buttons', w.posts.length === 1 && nButtons(w.calls) === 0) }
{ // 6. product-choice copy (defects 2-4 of ev-laneA-product-choice-touchpoints-check-2026-10-14), from a live-shaped catalogue
  const o = { trial_days: 7, trial_minutes: 60, trial_price_xcd: '0.00', overage_dominica_xcd: '0.135', overage_uscan_xcd: '1.49',
    plans: [{ name: 'Day Pass', days: 1, minutes: 200, price_xcd: '5.00', pool: 'dominica' }, { name: 'Week Pass', days: 7, minutes: 600, price_xcd: '15.00', pool: 'shared' }] }
  const newP = M.composePlans(o, false), holderP = M.composePlans(o, true), how = M.composeExplainerRc12(o)
  check('plans (new customer): no wallet-credit charging sentence', !/wallet credit/i.test(newP))
  check('plans (new customer): says paid plans and top-ups cannot be bought', /top-ups can't be bought/.test(newP))
  check('plans (line holder): wallet-credit rates only as a conditional', /If you have wallet credit/.test(holderP))
  // 2026-10-15: card top-up is live (real EC$10 credited). A line holder must not be told it is unavailable, and chat must not promise it.
  check('plans (line holder): says credit can be added by card in the app', /add credit by card from within your Cloud Softphone app/.test(holderP))
  check('plans (line holder): does not claim top-up is unavailable outright', !/Buying a plan or topping up isn't available yet\.(?!.*chat)/.test(holderP) && /from this chat isn't available/.test(holderP))
  check('CONTROL: the old false sentence would be caught by that pattern', /Buying a plan or topping up isn't available yet\./.test(`x Buying a plan or topping up isn't available yet.`))
  check('plans (line holder): customer copy has no Isola brand word in the top-up sentence', !/Isola/.test(holderP))
  const att = M.composeJourney({ state: 'attention', attention: ['minutes_low'], facts: { minutes_remaining: 5, minutes_included: 60 }, actions: ['balance'], payment: { topup_available: false } })
  check('attention: no "aren\'t available yet" claim, points to the app', att && !/aren't available yet/.test(att.text) && /add credit by card from within your Cloud Softphone app/.test(att.text))
  check('plans: "1 day" not "1 days"', /Day Pass - 1 day,/.test(newP) && !/1 days/.test(newP))
  check('plans: still lists the ladder price and minutes (control)', /Week Pass - 7 days, 600 minutes for Dominica, US & Canada, EC\$15\.00/.test(newP))
  check('how it works: describes the chat buttons, not the old form', /Set up my line/.test(how) && !/same form helps/.test(how))
  check('how it works: EPIC brand, no Isola', /EPIC Personal Line/.test(how) && !/Isola/.test(how))
}
console.log(`TALLY ${pass} pass / ${fail} fail`)
process.exit(fail ? 1 : 0)
