#!/usr/bin/env python3
"""Add Telegram forwarding to pl-watch's two alert paths (infrastructure notify() and the handoff-waiting alerts). Backup first; exact-anchor edits
with asserts; refuses if the deployed file is not the expected base. Reversal: cp the .pre-telegram backup back."""
import hashlib, shutil, sys, time
P = "/usr/local/lib/pl-watch/pl-watch.py"; BASE = "76e142445fc8adea"
src = open(P).read()
assert hashlib.sha256(src.encode()).hexdigest()[:16] == BASE, "deployed pl-watch is not the expected base; refusing"
shutil.copy2(P, P + ".pre-telegram-" + time.strftime("%Y%m%dT%H%M%SZ", time.gmtime()))
TG = '''def tg(text):
    """war room: forward an alert's first lines to the owner's Telegram (/etc/pl-watch/telegram.env). Never raises; returns ok."""
    try:
        import urllib.parse, urllib.request
        env = dict(l.strip().split("=", 1) for l in open("/etc/pl-watch/telegram.env") if "=" in l)
        data = urllib.parse.urlencode({"chat_id": env["PLW_TG_CHAT"], "text": text[:3900], "disable_web_page_preview": "true"}).encode()
        with urllib.request.urlopen("https://api.telegram.org/bot%s/sendMessage" % env["PLW_TG_TOKEN"], data, timeout=20) as r: ok = json.loads(r.read()).get("ok") is True
        print("telegram ->", ok); return ok
    except Exception as e: print("telegram send failed:", type(e).__name__); return False
def notify(text):'''
a1 = "def notify(text):"
assert src.count(a1) == 1; src = src.replace(a1, TG, 1)
a2 = '    print("alert private note ->", s, "private=%s" % v.get("private")); return s == 200 and v.get("private") is True'
assert src.count(a2) == 1
src = src.replace(a2, '    print("alert private note ->", s, "private=%s" % v.get("private")); tg("PL watch (infrastructure)\\n" + text.split("\\n\\n")[0])\n    return s == 200 and v.get("private") is True', 1)
a3 = '            print("handoff alert", stg, k, "->", s_, "private=%s" % v_.get("private"));'
assert src.count(a3) == 1
src = src.replace(a3, '            tg("PL watch: " + txt[:600]); ' + a3.strip() if False else a3 + ' tg("PL watch (handoff waiting): " + txt[:600]);', 1)
open(P, "w").write(src)
print("patched; new sha16", hashlib.sha256(src.encode()).hexdigest()[:16])
