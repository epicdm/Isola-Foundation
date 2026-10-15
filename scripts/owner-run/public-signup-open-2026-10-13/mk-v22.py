#!/usr/bin/env python3
# Build agent 28a55c69 v22 from v21. ONE edit, anchor-asserted: the "TAPS AND THE APP" bullet.
# Owner walkthrough 2026-10-14 (msg 3 on ...9610): the agent tells the customer to open Cloud Softphone but never gives a link. v21 deliberately said "NO store links" when the line is already in the app
# (the PM's conditional rule). New rule: whenever the reply tells the customer to open or use Cloud Softphone, finish it with the two verified links from facts.app (public store pages; on a phone that has the app
# they show an Open button), as plain https URLs on their own lines (WhatsApp makes them tappable). Never a tokenised link (pl_setup_link is NOT granted and stays ungranted). Wording about INSTALLING only when they need it.
# usage: python3 mk-v22.py <v21.json> <out v22.json>
import json, io, sys, difflib, hashlib
src, out = sys.argv[1], sys.argv[2]
c21 = json.load(io.open(src, encoding='utf-8')); c22 = json.loads(json.dumps(c21, ensure_ascii=False))
s = c21['customSkillMd']
a = s.index('- Every call happens in the Cloud Softphone app (by Acrobits) on their phone.'); b = s.index('PLAYBOOKS')
old = s[a:b]; assert old.endswith('\n\n') and 'with NO store links' in old
new = ("- Every call happens in the Cloud Softphone app (by Acrobits) on their phone. Whenever you answer anything about calling, give the next step that fits them. "
       "If their line is already in the app (journey_state registered_no_call, active, activated_not_registered or attention): tell them to open Cloud Softphone, check it shows connected, then make the call. "
       "If they still need to install (journey_state setup_not_activated) or lack the app, tell them to install it first. "
       "LINKS: whenever you tell them to open or use Cloud Softphone, end with the facts.app links (call pl_guide calling first if you have none), as plain https URLs on lines starting 'iPhone:' and 'Android:'; copy them exactly, add no other link. "
       "No line yet: sign up first (pl_present_offer), then download Cloud Softphone, then open it. If setup is not finished, send the setup form with pl_next_step.\n\n")
t = s[:a] + new + s[b:]
c22['customSkillMd'] = t
print('== field-level comparison v21 -> v22')
for k in c21:
    if k == 'faq': print('faq:', 'identical' if c21['faq'] == c22['faq'] else 'CHANGED')
    else: print(f'{k}:', 'CHANGED' if c21[k] != c22[k] else 'identical')
b21, b22 = len(s.encode()), len(t.encode()); print(f'skill bytes v21 {b21} -> v22 {b22} ({b22 - b21:+d}); every request carries the skill, so +{b22 - b21} B per model call (verified ceiling 98,304 B)')
assert b22 - b21 <= 260, 'skill grew more than expected'
print('--- bullet diff (sentence level)')
for l in difflib.unified_diff(old.split('. '), new.split('. '), 'bullet v21', 'bullet v22', lineterm='', n=0): print(l[:330])
json.dump(c22, io.open(out, 'w', encoding='utf-8', newline='\n'), ensure_ascii=False)
print('v21 sha12', hashlib.sha256(open(src, 'rb').read()).hexdigest()[:12], 'v22 sha12', hashlib.sha256(open(out, 'rb').read()).hexdigest()[:12])
