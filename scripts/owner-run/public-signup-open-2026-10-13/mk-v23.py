#!/usr/bin/env python3
# Build agent 28a55c69 v23 from v22. ONE edit, anchor-asserted: the LINKS sentence in the "TAPS AND THE APP" bullet.
# PM v1.7 2026-10-14: reuse the existing verified-customer setup-link delivery (pl_next_step sends the customer's OWN tappable
# "Manage my line" setup message; the minted activation link stays server-side in the Flow, never in model text, Port or logs).
# v22 told the model to paste store links whenever it said "open Cloud Softphone"; for a customer whose line already exists that is an INSTALL link, not an open/setup link.
# v23: open/use/set up Cloud Softphone -> call pl_next_step; store links only when they must INSTALL. Also a no-plan guard (plan none): no trial/60-minute talk, no per-minute rate quote.
# usage: python3 mk-v23.py <v22.json> <out v23.json>
import json, io, sys, difflib, hashlib
src, out = sys.argv[1], sys.argv[2]
c22 = json.load(io.open(src, encoding='utf-8')); c23 = json.loads(json.dumps(c22, ensure_ascii=False))
s = c22['customSkillMd']
a = s.index("LINKS: whenever you tell them to open or use Cloud Softphone"); b = s.index("No line yet: sign up first")
old = s[a:b]
new = ("SETUP LINK: whenever you tell them to open, use or set up Cloud Softphone and they already have a line, call pl_next_step so their own tappable setup message is sent to them; "
       "NEVER write a setup, activation or sign-in link yourself, and if it says a setup message was sent recently, tell them to use the latest one. "
       "Give the facts.app store links (iPhone:/Android: plain https URLs, from pl_guide calling) ONLY when they must INSTALL the app first. "
       "NO PLAN: if pl_status/pl_balance show their line has no plan, never mention the free trial or its 60 minutes and never quote a per-minute rate; their calls use their wallet credit, offer a teammate for rates. ")
t = s[:a] + new + s[b:]
c23['customSkillMd'] = t
print('== field-level comparison v22 -> v23')
for k in c22:
    if k == 'faq': print('faq:', 'identical' if c22['faq'] == c23['faq'] else 'CHANGED')
    else: print(f'{k}:', 'CHANGED' if c22[k] != c23[k] else 'identical')
b22, b23 = len(s.encode()), len(t.encode()); print(f'skill bytes v22 {b22} -> v23 {b23} ({b23 - b22:+d}) (verified ceiling 98,304 B per request)')
print('--- diff')
for l in difflib.unified_diff(old.split('. '), new.split('. '), 'v22', 'v23', lineterm='', n=0): print(l[:340])
json.dump(c23, io.open(out, 'w', encoding='utf-8', newline='\n'), ensure_ascii=False)
print('v22 sha12', hashlib.sha256(open(src, 'rb').read()).hexdigest()[:12], 'v23 sha12', hashlib.sha256(open(out, 'rb').read()).hexdigest()[:12])
