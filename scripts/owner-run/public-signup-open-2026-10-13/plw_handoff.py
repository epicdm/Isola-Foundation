"""plw_handoff.py - pl-watch v3.3: "a customer is waiting on an OPEN handoff conversation and no staff member has replied".
Incident 2026-10-13 18:31Z: a relay handoff alerted nobody (the only notification went to the relay bot user). This is the staff-visible alert. PURE functions only (no I/O) so they can be tested with synthetic rows.
Row shape (from the Chatwoot DB query below): {display_id, status, inbox_id, handoff_at (epoch s), handoff_note, staff_reply_after (bool), customer_tail}
Stages: 'new' (first detection: the primary alert, within one pl-watch cycle = 2 min), 'wait' (still unattended after N minutes), 'still' (every 30 min after that, max 6)."""
import time

SQL = """
select c.display_id, c.status, c.inbox_id, extract(epoch from h.t)::bigint, replace(h.note, '|', '/'),
       exists (select 1 from messages m2 where m2.conversation_id = c.id and m2.created_at > h.t and not m2.private and m2.message_type = 1 and m2.sender_type = 'User' and m2.sender_id <> {bot}) as staff_reply,
       right(coalesce(ct.phone_number, ct.identifier, ''), 4)
from conversations c
join lateral (select m.created_at as t, m.content as note from messages m where m.conversation_id = c.id and m.private and m.content like 'Relay handoff:%' order by m.created_at desc limit 1) h on true
left join contacts ct on ct.id = c.contact_id
where c.account_id = {acct} and c.inbox_id = {inbox} and c.status = 0 and h.t > now() - interval '3 days'
"""

def parse_rows(text):
    rows = []
    for ln in (text or "").splitlines():
        p = ln.split("|")
        if len(p) < 7: continue
        try: rows.append({"display_id": int(p[0]), "status": int(p[1]), "inbox_id": int(p[2]), "handoff_at": int(p[3]), "handoff_note": p[4][:140], "staff_reply_after": p[5].strip() == "t", "customer_tail": p[6].strip()})
        except Exception: continue
    return rows

def decide(rows, state, now, n_minutes=10, inbox=11):
    """-> (alerts, new_state). alerts = [(key, stage, text)]. state maps key -> {"stage": str, "last": epoch}."""
    st = {k: dict(v) for k, v in (state or {}).items()}; out = []
    live = set()
    for r in rows:
        if r["inbox_id"] != inbox or r["status"] != 0 or r["staff_reply_after"]: continue          # only OPEN, in the PL inbox, with NO human reply after the handoff
        key = "%d:%d" % (r["display_id"], r["handoff_at"]); live.add(key)
        age_min = max(0, (now - r["handoff_at"]) / 60.0); cur = st.get(key)
        stage = None
        if cur is None: stage = "new"
        elif cur["stage"] == "new" and age_min >= n_minutes: stage = "wait"
        elif cur["stage"] in ("wait", "still") and (now - cur["last"]) >= 1800 and cur.get("n", 0) < 6: stage = "still"
        if stage:
            text = ("PL HANDOFF %s: a customer (***%s) is waiting in conversation #%d, which the AI handed off %d min ago (%s) and no staff member has replied. "
                    "Open https://inbox.epic.dm/app/accounts/2/conversations/%d and reply, or set it back to pending to let the assistant continue." % (
                        {"new": "NEEDS A PERSON", "wait": "STILL WAITING", "still": "STILL WAITING"}[stage], r["customer_tail"] or "????", r["display_id"], int(age_min), r["handoff_note"], r["display_id"]))
            out.append((key, stage, text)); st[key] = {"stage": stage, "last": now, "n": (cur or {}).get("n", 0) + (1 if stage == "still" else 0)}
    for k in list(st):                       # forget conversations that were attended, closed or moved on
        if k not in live: del st[k]
    return out, st

if __name__ == "__main__":
    print(SQL.format(bot=20, acct=2, inbox=11))
