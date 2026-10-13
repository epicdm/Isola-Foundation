#!/usr/bin/env python3
# Build agent 28a55c69 v21 from v20. Three edits, all anchor-asserted, net size kept near v20 because the public-pilot request cap (32,768 B) is tight (see the 2026-10-13 18:31Z request_too_large incident):
#  1. TAPS AND THE APP bullet COMPRESSED: no hard-coded URLs (the verified links already ride in facts.app of pl_journey / pl_guide and in FAQ[1]); decision by journey_state, not by an adapter field that no longer exists
#  2. one playbook line for "is my phone connected?": registration unknown / not registered is NOT a reason to hand off - give the next action, offer a teammate only if that fails
#  3. one sentence: never state or estimate install/setup/activation time (eval scenario bp_synthesized_faq_hedged_phrasing failed 2/2 on v17 and v20)
# usage: python3 mk-v21.py <v20.json> <out v21.json>
import json, io, sys, difflib, hashlib
src, out = sys.argv[1], sys.argv[2]
c20 = json.load(io.open(src, encoding='utf-8')); c21 = json.loads(json.dumps(c20, ensure_ascii=False))
s = c20['customSkillMd']
# 1. compress the app bullet
a = s.index('- Every call happens in the Cloud Softphone app (by Acrobits) on their phone.'); b = s.index('PLAYBOOKS')
old = s[a:b]; assert old.endswith('\n\n') and 'app.install_needed' in old
new = ("- Every call happens in the Cloud Softphone app (by Acrobits) on their phone. Whenever you answer anything about calling, give the next step that fits them. "
       "If their line is already in the app (journey_state registered_no_call, active, activated_not_registered or attention): tell them to open Cloud Softphone, check it shows connected, then make the call, with NO store links. "
       "Give the store links from the facts (facts.app) ONLY if they still need to install (journey_state setup_not_activated) or say they do not have the app or cannot find it. "
       "No line yet: sign up first (pl_present_offer), then download Cloud Softphone, then open it. If setup is not finished, send the setup form with pl_next_step.\n\n")
t = s[:a] + new + s[b:]
# 2. connection-check playbook line, right after the 'Connected, no call yet' line
anchor2 = '- Connected, no call yet: encourage a first call to a Dominica number; explain dialing if asked.\n'
assert t.count(anchor2) == 1
line2 = ("- Asked whether their phone is connected: use pl_guide check_connection. Only say it is connected if the facts say so. If registration is unknown or not registered, say plainly that you cannot see the phone's connection from here, "
         "then give the steps: open Cloud Softphone, check its status shows registered or connected, make a short test call; offer a teammate only if that fails. Never hand off just because the state is unknown.\n")
t = t.replace(anchor2, anchor2 + line2)
# 3. install-time sentence
anchor3 = 'Write catalogue prices exactly as the tool gives them (EC$5); write wallet credit and the Dominica rate exactly as given, without a $ sign ("0.00 EC dollars", "13.5 EC cents a minute").'
assert t.count(anchor3) == 1
add3 = " Never state or estimate how long installing the app, setting up or activating a line takes (no 'a few minutes', no 'quick'); if asked, say you do not have a set time."
t = t.replace(anchor3, anchor3 + add3)
c21['customSkillMd'] = t
print('== field-level comparison v20 -> v21')
for k in c20:
    if k == 'faq': print('faq:', 'identical' if c20['faq'] == c21['faq'] else 'CHANGED')
    else: print(f'{k}:', 'CHANGED' if c20[k] != c21[k] else 'identical')
b20, b21 = len(s.encode()), len(t.encode()); print(f'skill bytes v20 {b20} -> v21 {b21} ({b21 - b20:+d}); request-size effect also includes the adapter v3 (-524 B x1.3 per pl_guide result)')
assert b21 - b20 <= 250, 'skill grew too much for the 32,768 B request cap'
for l in difflib.unified_diff(old.split('. '), new.split('. '), 'bullet v20', 'bullet v21', lineterm='', n=0): print(l[:260])
print('+', line2.strip()[:200]); print('+', add3.strip())
json.dump(c21, io.open(out, 'w', encoding='utf-8', newline='\n'), ensure_ascii=False)
print('v20 sha12', hashlib.sha256(open(src, 'rb').read()).hexdigest()[:12], 'v21 sha12', hashlib.sha256(open(out, 'rb').read()).hexdigest()[:12])
