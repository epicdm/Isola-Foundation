#!/usr/bin/env python3
# Build agent 28a55c69 v20 from v19: store links ONLY when the customer needs to install (rule change 2026-10-13, PM): otherwise give the relevant next action.
# v19 forced both links on EVERY calling answer; v20 makes the links conditional on app.install_needed (pl_guide fact, added by the adapter delta) or the customer saying they
# do not have / cannot find the app. FAQ[1] ('What app do I need?') keeps the links: that question IS the install question.
# usage: python3 mk-v20.py <v19.json> <out v20.json>
import json, io, sys, difflib, hashlib, re
src, out = sys.argv[1], sys.argv[2]
c19 = json.load(io.open(src, encoding='utf-8'))
c20 = json.loads(json.dumps(c19, ensure_ascii=False))
IOS = 'https://apps.apple.com/us/app/cloud-softphone/id567475545'
AND = 'https://play.google.com/store/apps/details?id=cz.acrobits.softphone.cloudphone'
s = c19['customSkillMd']
a = s.index('- Every call happens in the Cloud Softphone app (by Acrobits) on their phone.')
b = s.index('PLAYBOOKS')
old = s[a:b]
assert 'ALWAYS point the customer to it' in old and old.count('\n') == 2 and old.endswith('\n\n'), 'unexpected old bullet shape'
new = ("- Every call happens in the Cloud Softphone app (by Acrobits) on their phone. Whenever you answer anything about calling (including 'Calling help', 'How to make a call', 'Call Dominica' and 'Call US/Canada'), "
       "point the customer to the app with the NEXT ACTION that fits them. If their line is already set up in the app (pl_guide app.install_needed is false, or their state is registered_no_call, active, activated_not_registered or attention), "
       "tell them to open Cloud Softphone, check it shows connected, then make the call, and do NOT give store links. "
       "Give the store links ONLY when they need to install (app.install_needed is true) or they say they do not have the app or cannot find it, and give them exactly these, never invent or alter a link: "
       f"iPhone {IOS} and Android {AND} (each link opens the app page: Open if installed, Install if not). "
       "If they have no line yet, the order is: sign up first (pl_present_offer), then download Cloud Softphone, then open it. "
       "If their setup is not finished, send the setup form with pl_next_step instead of explaining dialing.\n\n")
c20['customSkillMd'] = s[:a] + new + s[b:]
print('== field-level comparison v19 -> v20')
for k in c19:
    if k == 'faq': print('faq:', 'identical' if c19['faq'] == c20['faq'] else 'CHANGED')
    else: print(f'{k}:', 'CHANGED' if c19[k] != c20[k] else 'identical')
t19, t20 = c19['customSkillMd'], c20['customSkillMd']
assert t19[:a] == t20[:a] and t19[b:] == t20[a + len(new):], 'skill outside the one bullet must be identical'
print('customSkillMd: prefix and suffix around the single bullet are byte-identical')
for l in difflib.unified_diff(old.split('. '), new.split('. '), 'bullet v19', 'bullet v20', lineterm='', n=0): print(l[:300])
json.dump(c20, io.open(out, 'w', encoding='utf-8', newline='\n'), ensure_ascii=False)
print('v19 sha12', hashlib.sha256(open(src, 'rb').read()).hexdigest()[:12], 'v20 sha12', hashlib.sha256(open(out, 'rb').read()).hexdigest()[:12])
urls = sorted(set(re.findall(r'https?://\S+?(?=[\s,)"]|$)', json.dumps(c20, ensure_ascii=False))))
print('links present in v20:', urls); assert set(urls) <= {IOS, AND}
