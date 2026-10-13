#!/usr/bin/env python3
# Build agent 28a55c69 v21 from v20: ONE sentence. Never state or estimate how long installing, setup or activation takes (an invented customer-facing claim, Law 12).
# Evidence: eval scenario bp_synthesized_faq_hedged_phrasing (unsupported_installation_time_estimate) failed 2/2 on v17 (launch version), passed once each on v18/v19, failed 2/2 on v20.
# usage: python3 mk-v21.py <v20.json> <out v21.json>
import json, io, sys, difflib, hashlib
src, out = sys.argv[1], sys.argv[2]
c20 = json.load(io.open(src, encoding='utf-8')); c21 = json.loads(json.dumps(c20, ensure_ascii=False))
s = c20['customSkillMd']
anchor = 'Write catalogue prices exactly as the tool gives them (EC$5); write wallet credit and the Dominica rate exactly as given, without a $ sign ("0.00 EC dollars", "13.5 EC cents a minute").'
assert s.count(anchor) == 1, 'anchor paragraph end not found exactly once'
add = " Never state or estimate how long installing the app, setting up or activating a line takes (no 'a few minutes', no 'quick'); if asked, say you do not have a set time."
c21['customSkillMd'] = s.replace(anchor, anchor + add)
print('== field-level comparison v20 -> v21')
for k in c20:
    if k == 'faq': print('faq:', 'identical' if c20['faq'] == c21['faq'] else 'CHANGED')
    else: print(f'{k}:', 'CHANGED' if c20[k] != c21[k] else 'identical')
i = s.index(anchor) + len(anchor)
assert c21['customSkillMd'][:i] == s[:i] and c21['customSkillMd'][i + len(add):] == s[i:], 'only the one sentence may be inserted'
print('customSkillMd: only the inserted sentence differs (%d chars)' % len(add))
print('+', add.strip())
json.dump(c21, io.open(out, 'w', encoding='utf-8', newline='\n'), ensure_ascii=False)
print('v20 sha12', hashlib.sha256(open(src, 'rb').read()).hexdigest()[:12], 'v21 sha12', hashlib.sha256(open(out, 'rb').read()).hexdigest()[:12])
