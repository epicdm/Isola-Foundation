#!/usr/bin/env python3
"""war-stream v1: Lane A's live launch feed. Prints only what is NEW since the last call (cursor in /var/lib/war-room/stream.json):
  MSG  customer and outgoing messages on the 0001 inbox (customer text shortened to 140 chars, phone as last 4 digits)
  TURN the agent's replies in Uplink: conversation, model, reply length, tools called, latency, and EMPTY when it wrote nothing
  RELAY the relay's decisions (reply sent, handoff + reason, agent unavailable, flow completed)
Read-only. Run repeatedly (Lane A's monitor loop calls it every 20 s)."""
import json, os, re, subprocess, time
CUR = "/var/lib/war-room/stream.json"
def sh(c, t=30):
    try: return subprocess.run(c, shell=True, capture_output=True, text=True, timeout=t).stdout
    except Exception: return ""
def cid(n): return sh("docker ps -q -f name=%s | head -1" % n).strip()
def m4(s): s = re.sub(r"\D", "", str(s or "")); return ("…" + s[-4:]) if s else ""
try: cur = json.load(open(CUR))
except Exception: cur = {"msg": None, "turn": None, "relay": None}
first = cur["msg"] is None
out = []
CW = cid("uplink_chatwoot-db"); DB = cid("uplink_uplink-db-prod"); R = cid("uplink_sf-relay-pl-prod")
def psql(container, user, db, sql):
    open("/tmp/ws.sql", "w").write(sql)
    return [l.split("~^~") for l in sh("docker exec -i %s psql -U %s -d %s -X -At -F '~^~' < /tmp/ws.sql" % (container, user, db)).splitlines() if l]
# messages
mid = cur["msg"] or int((psql(CW, "postgres", "isola", "select coalesce(max(id),0) from messages") or [["0"]])[0][0])
rows = psql(CW, "postgres", "isola", "select m.id, to_char(m.created_at,'HH24:MI:SS'), c.display_id, m.message_type, m.private, coalesce(ct.name,'-'), coalesce(ct.phone_number,''), regexp_replace(left(coalesce(m.content,''),140), '[\\r\\n]+', ' ', 'g') "
            "from messages m join conversations c on c.id=m.conversation_id join contacts ct on ct.id=c.contact_id where c.inbox_id=11 and m.id > %d order by m.id limit 60" % mid)
for i, t, d, mt, pv, name, ph, txt in rows:
    kind = {"0": "IN ", "1": "OUT", "2": "ACT", "3": "TPL"}.get(mt, mt)
    if pv == "t": kind = "NOTE"
    out.append((t, "MSG  %s conv %s %s %s: %s" % (kind, d, name, m4(ph), txt)))
    mid = max(mid, int(i))
# agent turns
tt = cur["turn"] or (psql(DB, "uplink", "uplink", "select coalesce(to_char(max(created_at),'YYYY-MM-DD HH24:MI:SS.US'),'1970-01-01') from agent_turns") or [["1970-01-01"]])[0][0]
rows = psql(DB, "uplink", "uplink", "select to_char(created_at,'YYYY-MM-DD HH24:MI:SS.US'), to_char(created_at,'HH24:MI:SS'), left(conversation_id::text,8), coalesce(model,'-'), length(coalesce(content,'')), "
            "coalesce((select string_agg(replace(coalesce(x->>'name', x->'function'->>'name','?'),'pl-action-adapter__',''), ',') from jsonb_array_elements(coalesce(tool_calls::jsonb,'[]'::jsonb)) x),''), coalesce(latency_ms,0), coalesce(tokens_in,0) "
            "from agent_turns where role='assistant' and created_at > '%s' order by created_at limit 40" % tt)
for full, t, c, model, ln, tools, lat, tin in rows:
    flag = "EMPTY " if ln == "0" else ""
    out.append((t, "TURN %sagent conv %s %s len=%s tools=[%s] %.1fs in=%s" % (flag, c, model, ln, tools, int(lat) / 1000, tin)))
    tt = max(tt, full)
# relay decisions
rt = cur["relay"] or time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime())
for l in sh("docker logs --since %s %s 2>&1" % (rt + "Z", R)).splitlines() if R else []:
    if '"event":"ignored"' in l or '"event":"presence"' in l or "{" not in l: continue
    try: e = json.loads(l[l.index("{"):])
    except Exception: continue
    ts = e.get("ts", "")[:19]
    if ts <= rt: continue
    desc = " ".join("%s=%s" % (k, e[k]) for k in ("outcome", "reason", "chars", "buttons", "status") if k in e)
    out.append((ts[11:19], "RELAY %s conv %s %s" % (e.get("event"), e.get("conversationId"), desc)))
    rt = max(rt, ts)
json.dump({"msg": mid, "turn": tt, "relay": rt}, open(CUR, "w"))
if first: print("stream armed (cursor set to now)")
for t, line in sorted(out): print(t, line)
