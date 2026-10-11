#!/usr/bin/env python3
# Derives rc13_test.mjs from rc12_test.mjs: supersedes the rc12 assertions the owner/PM changed (pl_journey posted; old troubleshoot
# wording) and adds rc13 tests (no tutorial loop, calling menu, facts mode, consent hold). Every replaced assertion is named here.
import re, os
d = os.path.dirname(os.path.abspath(__file__))
s = open(os.path.join(d, 'rc12_test.mjs'), encoding='utf-8').read()
s = s.replace("// adapter rc12 - isolated fixtures", "// adapter rc13 - isolated fixtures")
s = s.replace("const PAY = { topup_available: false, rail: 'fiserv', reason: 'fiserv_topup_not_available_in_chat' }",
              "const PAY = { topup_available: false, rail: 'fiserv', reason: 'fiserv_topup_not_available_in_chat' }\nconst OKC = { estate_suppressed: false, known: true }")
n = 0
for k in ['setup_not_activated', 'activated_not_registered', 'registered_no_call', 'active', 'attention', 'attention_topup_on']:
    s, c = re.subn(r"(\n  %s: \{ state: [^\n]*?payment: (?:PAY|\{ \.\.\.PAY, topup_available: true \}) )\}," % k, r"\1, consent: OKC },", s)
    n += c
assert n == 6, n

old1 = """for (const [s, want] of Object.entries(EXPECT)) {
  const w = world({ j: J[s] }); const r = await w.h.pl_journey(who())
  check(`journey ${s}: one message, buttons ${want.join(' / ')}`, r.ok && w.posts.length === 1 && same(postTitles(lastPost(w)), want), postTitles(lastPost(w)).join(' / '))
}"""
new1 = """// rc13 SUPERSEDES rc12 (PM 2026-10-10: the agent writes, tools return facts): pl_journey returns facts + buttons, posts NOTHING.
for (const [s, want] of Object.entries(EXPECT)) {
  const w = world({ j: J[s] }); const r = await w.h.pl_journey(who())
  check(`journey ${s}: facts returned, nothing posted, buttons ${want.join(' / ')}`, r.ok && r.result.code === 'facts' && w.posts.length === 0 && same(r.result.choices.map((c) => c.title), want) && r.result.choices.every((c) => typeof c.value === 'string'), JSON.stringify(r.result.choices))
}"""
assert s.count(old1) == 1
s = s.replace(old1, new1)

old2 = """{ const w = world({ j: { ...J.active, facts: { ...F, registration: 'unregistered' } } }); await w.h._runAction(who(), 'troubleshoot'); const p = lastPost(w); check('troubleshoot, working line whose app is closed: "normal while closed", no setup restart offered', /normal while Cloud Softphone is closed/.test(p.content) && !postTitles(p).includes('Continue setup')) }"""
new2 = """// rc13 SUPERSEDES rc12 wording: a failed call on a working line whose app is closed is diagnosed in order and never loops.
{ const w = world({ j: { ...J.active, facts: { ...F, registration: 'unregistered' } } }); await w.h._runAction(who(), 'troubleshoot'); const p = lastPost(w); check('troubleshoot, working line whose app is closed: not connected now, reconnects by itself, no setup restart, no loop', /isn't connected to your line - that's why/.test(p.content) && /reconnects by itself/.test(p.content) && same(postTitles(p), ['Check connection', 'Talk to a person']), postTitles(p).join('/')) }"""
assert s.count(old2) == 1
s = s.replace(old2, new2)

extra = r"""// 2c. rc13: Calling help is ONE question; no path leads back into a tutorial loop
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
{ const w = world({ j: J.no_line }); const r = await w.h.pl_guide(who(), { topic: 'call_failed' }); check('no line + call_failed: no account facts invented, no-line buttons', r.ok && r.result.facts === null && r.result.choices[0].title === 'Get my number') }
{ const w = world({ j: J.active }); const r = await w.h.pl_guide(who(), { topic: 'bogus' }); check('pl_guide unknown topic refused', !r.ok && r.result.code === 'invalid_arguments') }

"""
marker = "// 3. ownership"
assert s.count(marker) == 1
s = s.replace(marker, extra + marker)

cons = r"""{ const w = world({ j: { ...J.active, consent: { estate_suppressed: true, known: true } } }); const r = await proactive(w, 'first_call'); check('estate STOP (Meta STOP / doNotContact / revoked opt-in) -> stopped, nothing posted', r.code === 'stopped' && r.detail === 'estate_suppressed' && w.posts.length === 0) }
{ const w = world({ j: { ...J.active, consent: { estate_suppressed: false, known: false } } }); const r = await proactive(w, 'first_call'); check('consent unreadable -> HELD (retried later), never assumed, nothing posted', r.code === 'held' && r.detail === 'consent_unknown' && w.posts.length === 0) }
"""
m2 = "{ const w = world({ j: J.active, contactSearch: [] });"
assert s.count(m2) == 1
s = s.replace(m2, cons + m2)
open(os.path.join(d, 'rc13_test.mjs'), 'w', encoding='utf-8', newline='\n').write(s)
print('wrote rc13_test.mjs')
