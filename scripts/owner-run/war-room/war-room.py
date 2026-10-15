#!/usr/bin/env python3
"""war-room v1 (Lane A, 2026-10-15; owner: 'build the war room', dec-owner-build-the-war-room-2026-10-15).
Live launch alerts for the Personal Line 0001 path, paged to the owner's Telegram. Runs every minute (war-room.timer). Read-only on every system it
watches: it reads relay/Traefik/plsvc logs and the Chatwoot/Uplink databases and SENDS ONLY to the owner's Telegram (and nothing to customers).
  LOUD (phone rings): a conversation handed to a person, a customer waiting with no reply (bot 60 s / person 5 min), frustration words,
                      provisioning or tab 5xx, 3+ card declines in 10 min, spend past 50 %, a settings drift on the 0001 inbox.
  QUIET (silent feed): every new 0001 conversation, with its Chatwoot link.
Each event pages once (state file); a repeat of the same condition waits out its cooldown.
  war-room.py --dry-run     evaluate on live data, print what WOULD be sent, send nothing, save no state
  war-room.py --selftest    run every rule on synthetic inputs: each must fire once, a second pass must fire nothing; sends nothing
  war-room.py               live
Credentials: /etc/pl-watch/telegram.env (root 600; PLW_TG_TOKEN, PLW_TG_CHAT), never printed."""
import json, os, re, subprocess, sys, time, urllib.parse, urllib.request
DRY = "--dry-run" in sys.argv; SELF = "--selftest" in sys.argv
STATE = os.environ.get("WR_STATE", "/var/lib/war-room/state.json"); TGF = "/etc/pl-watch/telegram.env"
CWL = "https://inbox.epic.dm/app/accounts/2/conversations/%s"
RB = "https://claude.ai/artifact/KVJwphfYCuXkGjeMAPTJSC#%s"   # War Room page runbook anchors
INBOX11 = "https://inbox.epic.dm/app/accounts/2/settings/inboxes/11"
def conv_btn(d): return [("Open conversation", CWL % d)]
WIN = int(os.environ.get("WR_WINDOW_S", "150"))
BOT_WAIT_S = int(os.environ.get("WR_BOT_WAIT_S", "90"))   # 60 s + the relay's 20 s supervised hold (a normal supervised reply measured at 57 s)   # log look-back; > the 60 s timer so nothing falls between runs (dedup removes overlap)
def sh(cmd, t=30):
    try: return subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=t).stdout
    except Exception as e: return ""
def cid(name): return sh("docker ps -q -f name=%s | head -1" % name).strip()
def m4(s): s = re.sub(r"\D", "", str(s or "")); return ("…" + s[-4:]) if s else "…?"

# ---------- data sources (each replaced by fixtures in --selftest) ----------
def relay_events():
    R = cid("uplink_sf-relay-pl-prod")
    out = []
    for l in sh("docker logs --since %ds %s 2>&1" % (WIN, R)).splitlines() if R else []:
        if '"event":"handoff"' not in l and '"event":"agent_unavailable"' not in l: continue
        try: out.append(json.loads(l[l.index("{"):]))
        except Exception: pass
    return out
def cwq(sql):
    D = cid("uplink_chatwoot-db")
    if not D: return None
    open("/tmp/wr.sql", "w").write(sql)
    r = sh("docker exec -i %s psql -U postgres -d isola -X -At -F '|' < /tmp/wr.sql" % D)
    return [l.split("|") for l in r.splitlines() if l.strip()]
def new_conversations():
    return cwq("select c.display_id, coalesce(ct.name,'-'), coalesce(ct.phone_number,'') from conversations c join contacts ct on ct.id=c.contact_id "
               "where c.inbox_id=11 and c.created_at > now() - interval '15 minutes' order by c.id") or []
def waiting():
    # last non-private incoming message per open/pending 0001 conversation, with no non-private outgoing/template message after it
    return cwq("with li as (select distinct on (m.conversation_id) m.conversation_id, m.id mid, m.created_at from messages m join conversations c on c.id=m.conversation_id "
               "where c.inbox_id=11 and c.status in (0,2) and m.message_type=0 and m.private=false and m.created_at > now() - interval '30 minutes' "
               "order by m.conversation_id, m.created_at desc) "
               "select c.display_id, c.status, li.mid, extract(epoch from now()-li.created_at)::int, coalesce(ct.name,'-'), coalesce(ct.phone_number,'') from li "
               "join conversations c on c.id=li.conversation_id join contacts ct on ct.id=c.contact_id "
               "where not exists (select 1 from messages o where o.conversation_id=li.conversation_id and o.message_type in (1,3) and o.private=false and o.created_at >= li.created_at)") or []
FRUST = re.compile(r"\b(human|real person|a person|agent|useless|not working|doesn'?t work|don'?t work|stupid|rubbish|scam|refund|angry|frustrat\w*|waste|help me|nobody|no one answers?)\b", re.I)
def recent_incoming():
    return cwq("select m.id, c.display_id, coalesce(ct.name,'-'), coalesce(ct.phone_number,''), left(coalesce(m.content,''),300) from messages m join conversations c on c.id=m.conversation_id "
               "join contacts ct on ct.id=c.contact_id where c.inbox_id=11 and m.message_type=0 and m.private=false and m.created_at > now() - interval '5 minutes'") or []
def prov_5xx():
    T = cid("traefik")
    n = 0
    for l in sh("docker logs --since %ds %s 2>&1" % (WIN, T)).splitlines() if T else []:
        if re.search(r'"(GET|POST) /(api/v1/acrobits/|api/lite/acrobits/|home)', l) and re.search(r'" 5\d\d ', l): n += 1
    return n
def payment_declines():
    P = cid("uplink_plsvc-app")
    txt = sh("docker logs --since 10m %s 2>&1" % P) if P else ""
    lines = [l for l in txt.splitlines() if "payment-link/charge" in l]
    return sum(1 for l in lines if re.search(r"declin|non-approval|not approved", l, re.I)), sum(1 for l in lines if re.search(r"gateway error|fiserv.*(5\d\d|unreachable|timeout)", l, re.I))
def spend_fraction():
    DB = cid("uplink_uplink-db-prod")
    g = sh("docker exec %s psql -U uplink -d uplink -X -At -c \"select spent_micro_usd::float/budget_micro_usd from public_turn_spend_gates limit 1\"" % DB).strip() if DB else ""
    try: return float(g)
    except Exception: return None
def inbox_settings():
    r = cwq("select lock_to_single_conversation, (select count(*) from agent_bot_inboxes where inbox_id=11) from inboxes where id=11")
    return (r[0][0] == "t", int(r[0][1])) if r else (None, None)

if SELF:   # synthetic inputs: every rule must fire exactly once on pass 1 and nothing on pass 2
    FX = {"relay": [{"event": "handoff", "outcome": "agent unavailable (empty_reply)", "conversationId": 9001, "messageId": 1, "ts": "x"}],
          "new": [["9002", "Test Customer", "+17670000001"]], "wait": [["9003", "2", "77", "100", "Waiting Bot", "+17670000002"], ["9008", "2", "80", "75", "Normal Supervised Reply Time", "+17670000007"], ["9004", "0", "78", "400", "Waiting Human", "+17670000003"], ["9005", "2", "79", "20", "Too Soon", "+17670000004"]],
          "inc": [["501", "9006", "Upset", "+17670000005", "this is useless I want a real person"], ["502", "9007", "Calm", "+17670000006", "what are your prices"]],
          "prov": 2, "pay": (3, 0), "spend": 0.55, "inbox": (False, 1)}
    relay_events = lambda: FX["relay"]; new_conversations = lambda: FX["new"]; waiting = lambda: FX["wait"]; recent_incoming = lambda: FX["inc"]
    prov_5xx = lambda: FX["prov"]; payment_declines = lambda: FX["pay"]; spend_fraction = lambda: FX["spend"]; inbox_settings = lambda: FX["inbox"]

# ---------- rules ----------
def evaluate():
    ev = []   # (key, cooldown_s, loud, text)
    for e in relay_events():
        if e.get("event") == "handoff":
            d = e.get("conversationId"); why = e.get("outcome", "?")
            act = ("The agent wrote no reply, so the customer got 'a teammate will reply'. Answer them now, then Resolve to hand back to the agent." if "empty_reply" in why
                   else "Reply to the customer now. When done, Resolve to hand the conversation back to the agent.")
            ev.append(("ho:%s:%s" % (d, e.get("messageId")), 86400, True, "HANDED TO YOU (conversation %s): %s" % (d, why), act, conv_btn(d) + [("Runbook", RB % "rb-empty")]))
    for d, name, ph in new_conversations():
        ev.append(("new:%s" % d, 86400, False, "New 0001 conversation: %s %s" % (name, m4(ph)), "Watch it; take over if the agent goes wrong.", conv_btn(d)))
    for d, status, mid, age, name, ph in waiting():
        age = int(age); bot = status == "2"
        if (bot and age >= BOT_WAIT_S) or ((not bot) and age >= 300):
            act = ("The agent has not answered. Assign the conversation to yourself and reply." if bot else "You own this conversation. Reply now, or Resolve to give it back to the agent.")
            ev.append(("wait:%s:%s" % (d, mid), 86400, True, "NO REPLY for %ds: %s %s is waiting (%s)" % (age, name, m4(ph), "agent owns it" if bot else "you own it"), act, conv_btn(d)))
    for mid, d, name, ph, txt in recent_incoming():
        if FRUST.search(txt or ""):
            ev.append(("fr:%s" % mid, 86400, True, "FRUSTRATION: %s %s wrote \"%s\"" % (name, m4(ph), (txt or "")[:120]), "Read the thread. If the agent is off track, take over and reply yourself.", conv_btn(d)))
    n = prov_5xx()
    if n: ev.append(("prov:%d" % (time.time() // 600), 600, True, "PROVISIONING/TAB ERRORS: %d server errors on the Acrobits setup paths in the last %d s." % (n, WIN), "Phones cannot get their line. Tell Lane A now; once fixed, customers reopen the app or tap the setup link again.", [("Runbook", RB % "rb-provision")]))
    dec, gw = payment_declines()
    if dec >= 3 or gw: ev.append(("pay:%d" % (time.time() // 1800), 1800, True, "PAYMENTS: %d card declines and %d gateway errors in 10 min." % (dec, gw), "Cards are failing. The fraud lockout keys on one shared address, so one customer can block everyone. Tell Lane A; never retry a charge silently.", [("Runbook", RB % "rb-payments")]))
    f = spend_fraction()
    if f is not None and f >= 0.5: ev.append(("spend50", 21600, True, "AI SPEND at %.0f%% of the ceiling." % (f * 100), "Check for a looping conversation, then decide whether to raise the ceiling before it cuts service.", []))
    lock, bots = inbox_settings()
    if lock is False: ev.append(("drift-lock", 21600, True, "SETTING DRIFT: 0001 inbox 'lock to single conversation' is OFF, so conversations will split.", "Turn 'Lock to single conversation' back on in the inbox settings.", [("Open inbox settings", INBOX11), ("Runbook", RB % "rb-split")]))
    if bots is not None and bots != 1: ev.append(("drift-bot:%d" % bots, 21600, True, "SETTING DRIFT: 0001 inbox has %d agent bots attached (expected 1)." % bots, "The agent may not be answering. Check the inbox bot setting; tell Lane A.", [("Open inbox settings", INBOX11)]))
    return ev

def load():
    try: return json.load(open(STATE))
    except Exception: return {"sent": {}}
def tg(text, loud, action="", buttons=()):
    env = dict(l.strip().split("=", 1) for l in open(TGF) if "=" in l)
    body = text + (("\n\nWhat to do: " + action) if action else "")
    p = {"chat_id": env["PLW_TG_CHAT"], "text": body[:3900], "disable_notification": "false" if loud else "true", "disable_web_page_preview": "true"}
    if buttons: p["reply_markup"] = json.dumps({"inline_keyboard": [[{"text": t, "url": u} for t, u in buttons]]})
    try:
        with urllib.request.urlopen("https://api.telegram.org/bot%s/sendMessage" % env["PLW_TG_TOKEN"], urllib.parse.urlencode(p).encode(), timeout=20) as r: return json.loads(r.read()).get("ok") is True
    except Exception as e: print("telegram send failed:", type(e).__name__); return False

def run(st, send):
    now = time.time(); fired = []
    for key, cool, loud, text, action, buttons in evaluate():
        last = st["sent"].get(key)
        if last and now - last < cool: continue
        if send and not tg(text, loud, action, buttons): continue   # not recorded -> retried next minute
        st["sent"][key] = now; fired.append((key, loud, text + " | DO: " + action + " | " + ", ".join(t for t, _ in buttons)))
    st["sent"] = {k: v for k, v in st["sent"].items() if now - v < 7 * 86400}
    return fired

if "--demo" in sys.argv:   # one clearly labelled sample page, to show the owner the format
    print("demo sent:", tg("TEST (war room demo, no action needed): HANDED TO YOU (conversation 551): agent unavailable (empty_reply)", True,
          "The agent wrote no reply, so the customer got 'a teammate will reply'. Answer them now, then Resolve to hand back to the agent.", [("Open conversation", CWL % 551), ("Runbook", RB % "rb-empty")]))
    sys.exit(0)
if SELF:
    st = {"sent": {}}
    p1 = run(st, send=False); keys1 = sorted(k.split(":")[0] for k, _, _ in p1)
    p2 = run(st, send=False)
    expect = sorted(["ho", "new", "wait", "wait", "fr", "prov", "pay", "spend50", "drift-lock"])
    print("pass 1 fired:", keys1); print("pass 2 fired:", [k for k, _, _ in p2])
    ok = keys1 == expect and not p2 and not any(k.startswith("wait:9005") or k.startswith("wait:9008") or k.startswith("fr:502") for k, _, _ in p1)
    print("SELFTEST", "PASS" if ok else "FAIL", "(controls: a 20 s wait, a 75 s supervised wait and a calm message must NOT fire)")
    sys.exit(0 if ok else 1)
st = load()
fired = run(st, send=not DRY)
for k, loud, text in fired: print(("LOUD  " if loud else "QUIET ") + k + " | " + text.replace("\n", " / ")[:200])
if not fired: print("nothing to page")
if not DRY:
    os.makedirs(os.path.dirname(STATE), exist_ok=True); json.dump(st, open(STATE, "w"))
