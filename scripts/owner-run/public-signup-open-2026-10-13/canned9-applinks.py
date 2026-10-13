#!/usr/bin/env python3
# Chatwoot canned response 9 'softphone-help' (account 2): offer the install links in the same message, instead of only asking 'do you need the link?'.
# Staff-facing. Uses the supported API (PATCH /canned_responses/9) with the agent token read IN-PROCESS (never printed). Run on host04 as root.
#   python3 canned9-applinks.py dry|apply|rollback
import json, ssl, http.client, sys
MODE = sys.argv[1] if len(sys.argv) > 1 else "dry"
IOS = "https://apps.apple.com/us/app/cloud-softphone/id567475545"; AND = "https://play.google.com/store/apps/details?id=cz.acrobits.softphone.cloudphone"
OLD = "I can help you get your softphone (Acrobits) set up. Have you already downloaded the app, or do you need the link?"
NEW = f"I can help you get your softphone (Acrobits) set up. Have you already downloaded Cloud Softphone? If yes, please open it and tell me what you see. If not, you can install it here - iPhone: {IOS} - Android: {AND}"
TOK = open('/etc/pl-secrets/cw_agent_token').read().strip()
def cw(method, path, body=None):
    c = http.client.HTTPSConnection("127.0.0.1", 443, context=ssl._create_unverified_context(), timeout=20)
    c.request(method, "/api/v1/accounts/2/" + path, json.dumps(body) if body is not None else None, {"api_access_token": TOK, "Content-Type": "application/json", "Host": "inbox.epic.dm"})
    r = c.getresponse(); d = r.read().decode()
    try: return r.status, json.loads(d)
    except Exception: return r.status, {"_raw": d[:120]}
s, lst = cw("GET", "canned_responses"); assert s == 200, s
cur = [x for x in lst if x.get("id") == 9]; assert cur and cur[0]["short_code"] == "softphone-help", "canned response 9 not found / not softphone-help"
now = cur[0]["content"]; print("BEFORE sha-ish len", len(now), "| is OLD:", now == OLD, "| is NEW:", now == NEW, "| total canned:", len(lst))
want = NEW if MODE in ("apply", "dry") else OLD; expect = OLD if MODE in ("apply", "dry") else NEW
assert now == expect, "canned 9 is not in the expected current state; refusing"
if MODE == "dry": print("DRY RUN - nothing written"); sys.exit(0)
s, r = cw("PATCH", "canned_responses/9", {"content": want}); print("PATCH ->", s)
s, lst2 = cw("GET", "canned_responses"); c2 = [x for x in lst2 if x.get("id") == 9][0]
print("AFTER matches:", c2["content"] == want, "| others unchanged:", {x["id"]: x["content"] for x in lst if x["id"] != 9} == {x["id"]: x["content"] for x in lst2 if x["id"] != 9}, "| total:", len(lst2))
