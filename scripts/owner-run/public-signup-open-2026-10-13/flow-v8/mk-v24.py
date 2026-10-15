#!/usr/bin/env python3
# Build agent 28a55c69 v24 from v23 (PREPARED, NOT APPLIED; owner authorized bundling it with the Flow v8 cut-over, 2026-10-14). Anchor-asserted, two edits in customSkillMd only:
#  1) pl_journey rule: call it IN THIS TURN whenever the message is about a number, signup, setup, the app or "get my number"; never say a signup form is waiting before reading the journey (07:24:50Z defect: the line existed since 07:19:31 and no pl_journey call was made).
#  2) 'No line' rule: when they want a number, send the form with pl_present_offer and add ONE short line; do not run discovery questions (Dominica or US/Canada?) in the same turn (owner walk: redundant question right after the form).
# usage: python3 mk-v24.py <v23.json> <out v24.json>
import json, io, sys, difflib, hashlib
src, out = sys.argv[1], sys.argv[2]
c23 = json.load(io.open(src, encoding='utf-8')); c24 = json.loads(json.dumps(c23, ensure_ascii=False)); s = c23['customSkillMd']
o1 = "- pl_journey: their situation + buttons. Call it first in a conversation and whenever their state may have changed."
n1 = ("- pl_journey: their situation + buttons. Call it first in a conversation, and call it AGAIN in the same turn whenever the message is about a number, signing up, setup, the app or 'get my number' (their line may have been created since your last reply). "
      "Never tell someone a signup form is waiting, or ask for their name, before pl_journey shows they have no line.")
o2 = "- No line: find out how they will call (mostly Dominica? US/Canada? how often?) then recommend ONE fitting option from pl_guide plans and why; the free trial is the way to start. To start, call pl_present_offer."
n2 = ("- No line: the free trial is the way to start. When they want a number or to sign up, call pl_present_offer right away and add ONE short friendly line; do not ask discovery questions (Dominica or US/Canada? how often?) in that same turn. "
      "Only recommend a plan from pl_guide if they ask which plan fits.")
assert s.count(o1) == 1 and s.count(o2) == 1, 'anchors not found exactly once'
t = s.replace(o1, n1).replace(o2, n2); c24['customSkillMd'] = t
print('== field comparison v23 -> v24'); [print(f'{k}:', 'CHANGED' if c23[k] != c24[k] else 'identical') for k in c23]
b23, b24 = len(s.encode()), len(t.encode()); print(f'skill bytes {b23} -> {b24} ({b24 - b23:+d})')
for l in difflib.unified_diff([o1, o2], [n1, n2], 'v23', 'v24', lineterm='', n=0): print(l[:330])
json.dump(c24, io.open(out, 'w', encoding='utf-8', newline='\n'), ensure_ascii=False)
print('v23 sha12', hashlib.sha256(open(src, 'rb').read()).hexdigest()[:12], 'v24 sha12', hashlib.sha256(open(out, 'rb').read()).hexdigest()[:12])
