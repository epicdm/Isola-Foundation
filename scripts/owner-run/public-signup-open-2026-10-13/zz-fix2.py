import json
# agent config: tighten the purchase sentence
P='/tmp/zzx/agent_v17_config.json'; c=json.load(open(P))
o="Buying plans and top-ups is not available yet: if asked, say so plainly, and whenever you show plan prices say in the same message that paid plans are not available to buy yet."
n="Buying plans and top-ups is not available yet (not only in this chat): if asked, say exactly that. Do not offer a teammate, a workaround or any other way to buy a plan or add credit, and whenever you show plan prices say in the same message that paid plans are not available to buy yet."
assert c['customSkillMd'].count(o)==1; c['customSkillMd']=c['customSkillMd'].replace(o,n)
json.dump(c,open(P,'w'),ensure_ascii=False); print("agent cfg updated")
# adapter: drop the teammate-can-buy implication
A='/home/epicadmin/pladapter/pl-action-adapter.mjs'; s=open(A,encoding='utf8',newline='').read()
reps=[("Top-ups aren't available yet - tap *Talk to a person* and we'll help.","Top-ups aren't available yet."),
("Top-ups and plan purchases aren't available yet - tap *Talk to a person* and our team will help.","Top-ups and plan purchases aren't available yet."),
("Buying a plan isn't available yet - tap *Talk to a person* and our team will help.","Buying a plan isn't available yet.")]
for o,n in reps:
    assert s.count(o)==1,o[:40]; s=s.replace(o,n)
open('/tmp/pl-action-adapter.new2.mjs','w',encoding='utf8',newline='').write(s); print("adapter patched")
