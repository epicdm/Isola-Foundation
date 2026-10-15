p = 'war-room.py'
s = open(p, encoding='utf8').read()
s = s.replace('CWL = "https://inbox.epic.dm/app/accounts/2/conversations/%s"',
'''CWL = "https://inbox.epic.dm/app/accounts/2/conversations/%s"
RB = "https://claude.ai/artifact/KVJwphfYCuXkGjeMAPTJSC#%s"   # War Room page runbook anchors
INBOX11 = "https://inbox.epic.dm/app/accounts/2/settings/inboxes/11"
def conv_btn(d): return [("Open conversation", CWL % d)]''', 1)
rep = [
('            ev.append(("ho:%s:%s" % (e.get("conversationId"), e.get("messageId")), 86400, True, "HANDED TO YOU: %s\\nconversation %s\\n%s" % (e.get("outcome", "?"), e.get("conversationId"), CWL % e.get("conversationId"))))',
 '''            d = e.get("conversationId"); why = e.get("outcome", "?")
            act = ("The agent wrote no reply, so the customer got 'a teammate will reply'. Answer them now, then Resolve to hand back to the agent." if "empty_reply" in why
                   else "Reply to the customer now. When done, Resolve to hand the conversation back to the agent.")
            ev.append(("ho:%s:%s" % (d, e.get("messageId")), 86400, True, "HANDED TO YOU (conversation %s): %s" % (d, why), act, conv_btn(d) + [("Runbook", RB % "rb-empty")]))'''),
('        ev.append(("new:%s" % d, 86400, False, "New 0001 conversation: %s %s\\n%s" % (name, m4(ph), CWL % d)))',
 '        ev.append(("new:%s" % d, 86400, False, "New 0001 conversation: %s %s" % (name, m4(ph)), "Watch it; take over if the agent goes wrong.", conv_btn(d)))'),
('            ev.append(("wait:%s:%s" % (d, mid), 86400, True, "NO REPLY for %ds - %s is waiting (%s): %s %s\\n%s" % (age, "the agent" if bot else "a person", "bot owns it" if bot else "you own it", name, m4(ph), CWL % d)))',
 '''            act = ("The agent has not answered. Assign the conversation to yourself and reply." if bot else "You own this conversation. Reply now, or Resolve to give it back to the agent.")
            ev.append(("wait:%s:%s" % (d, mid), 86400, True, "NO REPLY for %ds: %s %s is waiting (%s)" % (age, name, m4(ph), "agent owns it" if bot else "you own it"), act, conv_btn(d)))'''),
('            ev.append(("fr:%s" % mid, 86400, True, "FRUSTRATION: %s %s wrote \\"%s\\"\\n%s" % (name, m4(ph), (txt or "")[:120], CWL % d)))',
 '            ev.append(("fr:%s" % mid, 86400, True, "FRUSTRATION: %s %s wrote \\"%s\\"" % (name, m4(ph), (txt or "")[:120]), "Read the thread. If the agent is off track, take over and reply yourself.", conv_btn(d)))'),
('    if n: ev.append(("prov:%d" % (time.time() // 600), 600, True, "PROVISIONING/TAB ERRORS: %d 5xx on the Acrobits paths in the last %ds. Runbook: probe provision.epic.dm, check host04 route + cert." % (n, WIN)))',
 '    if n: ev.append(("prov:%d" % (time.time() // 600), 600, True, "PROVISIONING/TAB ERRORS: %d server errors on the Acrobits setup paths in the last %d s." % (n, WIN), "Phones cannot get their line. Tell Lane A now; once fixed, customers reopen the app or tap the setup link again.", [("Runbook", RB % "rb-provision")]))'),
('    if dec >= 3 or gw: ev.append(("pay:%d" % (time.time() // 1800), 1800, True, "PAYMENTS: %d card declines and %d gateway errors in 10 min. Check the shared fraud-lockout address first." % (dec, gw)))',
 '    if dec >= 3 or gw: ev.append(("pay:%d" % (time.time() // 1800), 1800, True, "PAYMENTS: %d card declines and %d gateway errors in 10 min." % (dec, gw), "Cards are failing. The fraud lockout keys on one shared address, so one customer can block everyone. Tell Lane A; never retry a charge silently.", [("Runbook", RB % "rb-payments")]))'),
('    if f is not None and f >= 0.5: ev.append(("spend50", 21600, True, "AI SPEND at %.0f%% of the ceiling." % (f * 100)))',
 '    if f is not None and f >= 0.5: ev.append(("spend50", 21600, True, "AI SPEND at %.0f%% of the ceiling." % (f * 100), "Check for a looping conversation, then decide whether to raise the ceiling before it cuts service.", []))'),
('''    if lock is False: ev.append(("drift-lock", 21600, True, "SETTING DRIFT: 0001 inbox 'lock to single conversation' is OFF (conversations will split). Turn it back on in Chatwoot inbox settings."))''',
 '''    if lock is False: ev.append(("drift-lock", 21600, True, "SETTING DRIFT: 0001 inbox 'lock to single conversation' is OFF, so conversations will split.", "Turn 'Lock to single conversation' back on in the inbox settings.", [("Open inbox settings", INBOX11), ("Runbook", RB % "rb-split")]))'''),
('    if bots is not None and bots != 1: ev.append(("drift-bot:%d" % bots, 21600, True, "SETTING DRIFT: 0001 inbox has %d agent bots attached (expected 1)." % bots))',
 '    if bots is not None and bots != 1: ev.append(("drift-bot:%d" % bots, 21600, True, "SETTING DRIFT: 0001 inbox has %d agent bots attached (expected 1)." % bots, "The agent may not be answering. Check the inbox bot setting; tell Lane A.", [("Open inbox settings", INBOX11)]))'),
('    for key, cool, loud, text in evaluate():', '    for key, cool, loud, text, action, buttons in evaluate():'),
('        if send and not tg(text, loud): continue', '        if send and not tg(text, loud, action, buttons): continue'),
('        st["sent"][key] = now; fired.append((key, loud, text))', '        st["sent"][key] = now; fired.append((key, loud, text + " | DO: " + action + " | " + ", ".join(t for t, _ in buttons)))'),
]
for a, b in rep:
    assert s.count(a) == 1, ('anchor missing', a[:80])
    s = s.replace(a, b, 1)
i, j = s.index("def tg(text, loud):"), s.index("def run(st, send):")
s = s[:i] + '''def tg(text, loud, action="", buttons=()):
    env = dict(l.strip().split("=", 1) for l in open(TGF) if "=" in l)
    body = text + (("\\n\\nWhat to do: " + action) if action else "")
    p = {"chat_id": env["PLW_TG_CHAT"], "text": body[:3900], "disable_notification": "false" if loud else "true", "disable_web_page_preview": "true"}
    if buttons: p["reply_markup"] = json.dumps({"inline_keyboard": [[{"text": t, "url": u} for t, u in buttons]]})
    try:
        with urllib.request.urlopen("https://api.telegram.org/bot%s/sendMessage" % env["PLW_TG_TOKEN"], urllib.parse.urlencode(p).encode(), timeout=20) as r: return json.loads(r.read()).get("ok") is True
    except Exception as e: print("telegram send failed:", type(e).__name__); return False

''' + s[j:]
a = 'if SELF:\n    st = {"sent": {}}'
assert s.count(a) == 1
s = s.replace(a, '''if "--demo" in sys.argv:   # one clearly labelled sample page, to show the owner the format
    print("demo sent:", tg("TEST (war room demo, no action needed): HANDED TO YOU (conversation 551): agent unavailable (empty_reply)", True,
          "The agent wrote no reply, so the customer got 'a teammate will reply'. Answer them now, then Resolve to hand back to the agent.", [("Open conversation", CWL % 551), ("Runbook", RB % "rb-empty")]))
    sys.exit(0)
''' + a, 1)
open(p, 'w', encoding='utf8').write(s)
print('patched')
