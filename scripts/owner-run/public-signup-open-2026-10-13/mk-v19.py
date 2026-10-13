#!/usr/bin/env python3
# Build agent 28a55c69 v19 from v18: ALWAYS point the customer to the calling app (Cloud Softphone) with the verified store links.
# Owner rule (2026-10-13 walkthrough defect 4): "Calling help" (and every calling answer) must say how to open the app and give a link to open or install it;
# no account yet -> sign up first, then download, then open. Links are the SAME constants the live adapter (IOS_URL/ANDROID_URL) and plsvc (service.ts store_links)
# already send; both return HTTP 200 (checked 2026-10-13). Root cause: the skill said "your facts include where to get it" but pl_guide calling facts carry no links.
# usage: python3 mk-v19.py <v18.json> <out v19.json>
import json, io, sys, difflib, hashlib
src, out = sys.argv[1], sys.argv[2]
c18 = json.load(io.open(src, encoding='utf-8'))
c19 = json.loads(json.dumps(c18, ensure_ascii=False))
IOS = 'https://apps.apple.com/us/app/cloud-softphone/id567475545'
AND = 'https://play.google.com/store/apps/details?id=cz.acrobits.softphone.cloudphone'

s = c18['customSkillMd']
old = ("- Every call happens in the Cloud Softphone app (by Acrobits) on their phone - your facts include where to get it. Whenever you explain calling, make sure they know to open Cloud Softphone; "
       "if they don't have it, give the store link for their phone from the facts; if their setup is not finished, send the setup form with pl_next_step instead of explaining dialing.")
assert s.count(old) == 1, "anchor paragraph not found exactly once"
new = ("- Every call happens in the Cloud Softphone app (by Acrobits) on their phone. ALWAYS point the customer to it whenever you answer anything about calling, including 'Calling help', 'How to make a call', 'Call Dominica' and 'Call US/Canada': "
       "tell them to open Cloud Softphone on their phone, and give both store links, which are exactly these and no others (never invent or alter a link): "
       f"iPhone {IOS} and Android {AND} - the link opens the app page, which shows Open if they already have it and Install if they do not. "
       "If they do not have a line yet, give the order: sign up first (pl_present_offer), then download Cloud Softphone, then open it. "
       "If their setup is not finished, send the setup form with pl_next_step instead of explaining dialing.")
c19['customSkillMd'] = s.replace(old, new)

a1 = c18['faq'][1]['a']
assert c18['faq'][1]['q'] == 'What app do I need?'
c19['faq'][1]['a'] = a1.rstrip() + f" To open or install it: iPhone {IOS} and Android {AND} (each link opens the app page). No line yet? Sign up first, then download the app, then open it."

print("== field-level comparison v18 -> v19")
for k in c18:
    if k == 'faq':
        for i, (a, b) in enumerate(zip(c18['faq'], c19['faq'])): print(f"faq[{i}]:", 'CHANGED' if a != b else 'identical')
        print('faq length:', len(c18['faq']), len(c19['faq']))
    else: print(f"{k}:", 'CHANGED' if c18[k] != c19[k] else 'identical')
t18, t19 = c18['customSkillMd'], c19['customSkillMd']
i = t18.index(old)
assert t18[:i] == t19[:i] and t18[i + len(old):] == t19[i + len(new):], 'skill text outside the one bullet must be identical'
print('customSkillMd: prefix and suffix around the single bullet are byte-identical')
for name, a, b in (('skill-bullet', old, new), ('faq[1]', a1, c19['faq'][1]['a'])):
    for l in difflib.unified_diff(a.split('. '), b.split('. '), name + ' v18', name + ' v19', lineterm='', n=0): print(l[:420])
json.dump(c19, io.open(out, 'w', encoding='utf-8', newline='\n'), ensure_ascii=False)
print('v18 sha12', hashlib.sha256(open(src, 'rb').read()).hexdigest()[:12], 'v19 sha12', hashlib.sha256(open(out, 'rb').read()).hexdigest()[:12])
# only the two verified URLs appear as links in v19
import re
urls = sorted(set(re.findall(r'https?://\S+?(?=[\s,)"]|$)', json.dumps(c19, ensure_ascii=False))))
print('links present in v19:', urls)
assert set(urls) <= {IOS, AND}, 'unexpected link'
