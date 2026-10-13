import json, difflib, hashlib, re, sys
src = '/tmp/zzx/agent_v17_config.json'
c17 = json.load(open(src, encoding='utf8'))
c18 = json.loads(json.dumps(c17, ensure_ascii=False))

# --- customSkillMd: one paragraph rewritten
s = c17['customSkillMd']
start = s.index('Personal Line gives the customer a number to make calls from the free Cloud Softphone app.')
end = s.index('Never promise missed-call alerts or voicemail coming back to this chat.')
old_part = s[start:end]
assert 'Incoming calls to their number work and are free while their balance is positive.' in old_part
new_part = ("Personal Line gives the customer a number to make calls from the free Cloud Softphone app. "
            "Whenever you state the free-trial minutes, say them exactly as '60 minutes of outgoing calls to Dominica numbers'. "
            "NEVER volunteer anything about incoming calls: do not mention incoming calls unless the customer asks about them. "
            "If the customer asks about incoming calls, say that incoming calls to their number are free while their balance is positive, "
            "and that you are not sure whether their free-trial minutes count as balance, and offer to bring in a teammate to check. "
            "Do not guess anything else about incoming calls (what happens at a zero balance, limits, missed-call alerts, voicemail): say you are not sure and offer to bring in a teammate. ")
c18['customSkillMd'] = s[:start] + new_part + s[end:]

# --- FAQ[0]: stop volunteering incoming, state the trial minutes in the required form
a0 = c17['faq'][0]['a']
o0 = "Incoming calls to your number work and are free while your balance is positive. The 60 free trial minutes are for outgoing calls to Dominica numbers."
assert a0.count(o0) == 1
c18['faq'][0]['a'] = a0.replace(o0, "The free trial gives you 60 minutes of outgoing calls to Dominica numbers.")

# --- FAQ[10]: the asked-case wording
assert c17['faq'][10]['q'] == 'Can people call my Personal Line number?'
c18['faq'][10]['a'] = ("Incoming calls to your number are free while your balance is positive. I'm not sure whether your free trial minutes count as balance, so I can bring in a teammate to check. "
                       "The 60 free trial minutes are for outgoing calls to Dominica numbers.")

# --- proof: everything else byte-identical
print("== field-level comparison v17 -> v18")
for k in c17:
    if k == 'faq':
        for i, (a, b) in enumerate(zip(c17['faq'], c18['faq'])):
            print(f"faq[{i}]:", 'CHANGED' if a != b else 'identical')
        print("faq length:", len(c17['faq']), len(c18['faq']))
    else:
        print(f"{k}:", 'CHANGED' if c17[k] != c18[k] else 'identical')
t17, t18 = c17['customSkillMd'], c18['customSkillMd']
assert t17[:start] == t18[:start] and t17[end:] == t18[end - len(old_part) + len(new_part):], "skill text outside the paragraph must be identical"
print("customSkillMd: prefix before paragraph identical, suffix after paragraph identical")
print("== unified diff of the changed pieces")
def show(name, a, b):
    for l in difflib.unified_diff(a.split('. '), b.split('. '), name + ' v17', name + ' v18', lineterm='', n=0): print(l[:300])
show('skill-paragraph', old_part, new_part)
show('faq[0]', c17['faq'][0]['a'], c18['faq'][0]['a'])
show('faq[10]', c17['faq'][10]['a'], c18['faq'][10]['a'])
json.dump(c18, open('/tmp/zzx/agent_v18_config.json', 'w', encoding='utf8'), ensure_ascii=False)
print("v17 sha12", hashlib.sha256(open(src, 'rb').read()).hexdigest()[:12], "v18 sha12", hashlib.sha256(open('/tmp/zzx/agent_v18_config.json', 'rb').read()).hexdigest()[:12])
# volunteered-incoming scan in v18
for k in ('greeting',):
    print('greeting mentions incoming:', 'ncoming' in c18[k])
for i, f in enumerate(c18['faq']):
    if 'ncoming' in f['a'] or 'ncoming' in f['q']:
        print('v18 faq mentions incoming at', i, '-', f['q'])
