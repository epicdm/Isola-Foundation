#!/usr/bin/env python3
# pl-watch v3.2 -> v3.3: adds the STAFF ALERT for a handoff nobody answers. Before this, a relay handoff alerted no human (incident 2026-10-13 18:31Z: the only notification went to the relay bot user 20).
# New: every cycle (2 min) it finds OPEN conversations of inbox 11 whose latest relay-handoff note has no human-staff reply after it; first detection posts a staff-visible note to the alert conversation (519) that @mentions
# every member of the escalation team (8); reminder after N minutes (default 10, env PLW_HANDOFF_N), then every 30 min (max 6). Pure decision logic lives in plw_handoff.py (unit-tested with synthetic rows).
# usage: python3 mk-plwatch-v33.py <pl-watch.v3.2.py> <out pl-watch.v3.3.py>
import io, sys, hashlib
src, out = sys.argv[1], sys.argv[2]
s = io.open(src, encoding='utf-8', newline='').read(); base12 = hashlib.sha256(s.encode()).hexdigest()[:12]
assert base12 == 'c3fac56f95e6', 'base is not v3.2'
def rep(old, new):
    global s
    assert s.count(old) == 1, f'anchor count {s.count(old)}: {old[:70]}'
    s = s.replace(old, new)
rep('print("INFO " + info)\nif DRY:', '''# ---- v3.3: handoff waiting (staff alert) ----
def handoff_alerts():
    sys.path.insert(0, "/usr/local/lib/pl-watch")
    import plw_handoff as HW
    nmin = int(os.environ.get("PLW_HANDOFF_N", "10"))
    fx = os.environ.get("PLW_FIXTURE_HANDOFF")
    if fx: raw = open(fx).read()                       # self-test: synthetic rows instead of the Chatwoot database
    else:
        cdb = cid("uplink_chatwoot-db")
        if not cdb: return ["handoff check could not find the Chatwoot DB container"], []
        open("/tmp/plw-handoff.sql", "w").write(HW.SQL.format(bot=20, acct=CW_ACCT, inbox=11))
        raw = sh("docker exec -i %s psql -U postgres -d isola -X -At -F '|' < /tmp/plw-handoff.sql" % cdb, 30)
    rows = HW.parse_rows(raw)
    st0 = load_state(); alerts, nst = HW.decide(rows, st0.get("handoff", {}), time.time(), nmin)
    return [("%d open handoff conversation(s) with no staff reply; %d alert(s) due" % (len([r for r in rows if r['status'] == 0 and not r['staff_reply_after']]), len(alerts)))], (alerts, nst, rows)
HW_NOTE, HW_RES = handoff_alerts()
print("HANDOFF-WAITING | " + "; ".join(HW_NOTE))
if HW_RES:
    for k, stg, txt in HW_RES[0]: print("HANDOFF-ALERT %s %s | %s" % (stg, k, txt[:170]))
print("INFO " + info)
if DRY:
    if HW_RES: print("(dry-run: handoff alerts above were NOT posted and state was NOT saved)")
if DRY:''')
# non-dry: post the alerts to the alert conversation, mentioning the escalation team, and persist the stage state
rep('os.makedirs(os.path.dirname(STATE), exist_ok=True)\nst = load_state(); now = time.time()',
'''os.makedirs(os.path.dirname(STATE), exist_ok=True)
if HW_RES and HW_RES[0]:
    try:
        members = os.environ.get("PLW_FIXTURE_MEMBERS")
        if not members:
            cdb = cid("uplink_chatwoot-db"); members = sh("docker exec -i %s psql -U postgres -d isola -X -At -F '|' -c \\"select u.id, u.name from team_members tm join users u on u.id = tm.user_id where tm.team_id = 8 order by u.id\\"" % cdb, 20)
        ments = " ".join("[@%s](mention://user/%s/%s)" % (p[1], p[0], p[1].replace(" ", "%20")) for p in (l.split("|") for l in members.splitlines() if "|" in l))
        conv = load_state().get("cw_conv")
        posted_all = True
        for k, stg, txt in HW_RES[0]:
            s_, v_ = cw("POST", "conversations/%d/messages" % conv, {"content": (ments + " " + txt).strip(), "message_type": "outgoing", "private": True}) if conv else (0, {})
            print("handoff alert", stg, k, "->", s_, "private=%s" % v_.get("private")); posted_all = posted_all and s_ == 200 and v_.get("private") is True
        if posted_all:
            st_ = load_state(); st_["handoff"] = HW_RES[1]; json.dump(st_, open(STATE, "w"))
    except Exception as e: print("handoff alert error:", type(e).__name__, str(e)[:80])
elif HW_RES:
    st_ = load_state(); st_["handoff"] = HW_RES[1]; json.dump(st_, open(STATE, "w"))
st = load_state(); now = time.time()''')
io.open(out, 'w', encoding='utf-8', newline='').write(s)
print('base sha12', base12, 'new sha12', hashlib.sha256(s.encode()).hexdigest()[:12])
