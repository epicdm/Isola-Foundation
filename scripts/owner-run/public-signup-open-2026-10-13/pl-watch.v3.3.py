#!/usr/bin/env python3
"""pl-watch v3 (2026-10-13, public-signup monitors added on top of v2.1; backup pl-watch.py.v2.1): intended country_not_open refusals no longer page; added hourly-ceiling, failed-provisioning, duplicate-account and false-charge checks, each with a fired control (PLW_CTRL).
pl-watch v2: the MINIMUM operational monitor for the Personal Line stack on host04. INSTALLED as systemd pl-watch.timer (every 2 minutes) with a staff-private Chatwoot note; v1 is backed up as /usr/local/lib/pl-watch/pl-watch.py.v1.
v2 adds two per-row checks: an account not registered 20 minutes after creation, and an undrained admission queue row; each alerts ONCE per row (staff note only) with a recovery note; known test identities are excluded.
One root-owned script, run by the timer every 2 minutes. It detects a DEAD PATH (a service down, replies not flowing, queues stuck, errors rising, spend about to cut service) and mails the recipients.
  Usage:  pl-watch.py --dry-run     print every check, send nothing (safe to run any time, read-only)
          pl-watch.py                run the checks and mail on a state change / every 30 min while a check stays failed
Recipients: /etc/pl-watch/recipients (one address per line). The file does not exist until the coordinator supplies addresses; with no file the script refuses to send.
Alert path: SMTP2GO through the IP allowlist that already works for host04 (no credentials are stored or needed). Nothing here posts to a customer, calls Meta, or changes any state."""
import json, os, re, subprocess, sys, time, smtplib, ssl
from email.message import EmailMessage
DRY = "--dry-run" in sys.argv
STATE = os.environ.get("PLW_STATE", "/var/lib/pl-watch/state.json"); RECIP = "/etc/pl-watch/recipients"
def sh(cmd, t=25):
    try: return subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=t).stdout.strip()
    except Exception as e: return "ERR %s" % e
def cid(name): return sh("docker ps -q -f name=%s | head -1" % name)
checks = []   # (name, ok, detail)
PERR = []   # v3.2: instrument errors (probe_error), kept apart from findings
def chk(name, ok, detail=""): checks.append((name, bool(ok), detail))
R, P, AD, CH, SK = cid("uplink_sf-relay-pl-prod"), cid("uplink_plsvc-app"), cid("uplink_pl-action-adapter"), cid("uplink_chat."), cid("uplink_chatwoot-sidekiq")
DB = cid("uplink_uplink-db-prod"); RD = cid("uplink_chatwoot-redis")
# 1-4 services answer
chk("relay healthz", R and sh("docker exec %s node -e 'fetch(\"http://127.0.0.1:3000/healthz\").then(r=>console.log(r.status))'" % R) == "200")
ph = bool(P) and "healthy" in sh("docker ps --format '{{.Status}}' -f id=%s" % P)
offer_js = "/usr/local/lib/pl-watch/offer-once.js"   # the signed read-only /offer probe (copy of zz-offer-once.js); proves plsvc -> Magnus reads
def offer_probe():
    """Signed read-only /offer probe (plsvc -> Magnus read). Runs at most once per 10 minutes (cached result), one call, no retry, so a Magnus problem cannot be turned into a lockout by this monitor."""
    OF = "/var/lib/pl-watch/offer.json"
    try: c = json.load(open(OF))
    except Exception: c = {"t": 0, "ok": False, "detail": "never run"}
    if "--induce-offer" in sys.argv: return False, "induced failure (self-test), no call made"
    if time.time() - c["t"] < 600: return c["ok"], "cached %ds ago: %s" % (time.time() - c["t"], c["detail"])
    out = sh("docker exec -i %s sh -c 'cd /app && node -' < %s" % (P, offer_js), 40)
    ok = "HTTP 200" in out and "code: offer" in out
    detail = (out.split("|")[0] + "|" + (out.split("|")[1] if "|" in out else "")).strip()[:80]
    os.makedirs(os.path.dirname(OF), exist_ok=True); json.dump({"t": time.time(), "ok": ok, "detail": detail}, open(OF, "w"))
    return ok, detail
if os.path.exists(offer_js) and P: po, pod = offer_probe()
else: po, pod = (not os.path.exists(offer_js)), "probe not installed (health only)"
chk("plsvc healthy and Magnus read (/offer) works", ph and po, "probe: %s" % pod)
chk("adapter /health", AD and sh("docker exec %s node -e 'fetch(\"http://127.0.0.1:9100/health\").then(r=>console.log(r.status))'" % AD) == "200")
chk("Chatwoot web answers", sh("curl -sk -o /dev/null -w '%{http_code}' --max-time 10 --resolve inbox.epic.dm:443:127.0.0.1 https://inbox.epic.dm/") in ("200", "301", "302"))
# 5 sidekiq backlog / retry / dead growth (counts only; redis password read INSIDE the container, never printed)
q = sh("docker exec %s sh -c 'for k in queue:default queue:high queue:critical queue:medium queue:low; do redis-cli -a \"$REDIS_PASSWORD\" --no-auth-warning llen $k; done; redis-cli -a \"$REDIS_PASSWORD\" --no-auth-warning zcard retry; redis-cli -a \"$REDIS_PASSWORD\" --no-auth-warning zcard dead' | tr '\\n' ' '" % RD) if RD else ""
nums = [int(x) for x in re.findall(r"\d+", q)]
dead = nums[-1] if len(nums) == 7 else None; retry = nums[-2] if len(nums) == 7 else None; backlog = sum(nums[:5]) if len(nums) == 7 else None
chk("sidekiq backlog < 200 and retry < 20", backlog is not None and backlog < 200 and retry < 20, "backlog=%s retry=%s" % (backlog, retry))
# 6 spend gate headroom (>= 20% left and the window has > 48 h)
g = sh("docker exec %s psql -U uplink -d uplink -X -At -F ' ' -c \"select spent_micro_usd::float/budget_micro_usd, extract(epoch from expires_at-now())/3600, enabled from public_turn_spend_gates limit 1\"" % DB) if DB else ""
try: frac, hrs, en = g.split(); ok = float(frac) < 0.8 and float(hrs) > 48 and en == "t"
except Exception: frac = hrs = None; ok = False
chk("Uplink spend gate: spent < 80% of ceiling, window > 48 h, enabled", ok, "spent_fraction=%s window_hours=%s" % (frac, hrs))
# 7 relay error rate over the last 15 minutes (agent_unavailable / handoff / bad_signature / pl_tool_readback_unavailable)
ev = sh("docker logs --since 15m %s 2>&1 | grep -c -E '\"event\":\"(agent_unavailable|handoff|pl_tool_readback_unavailable|owner_assignment_failed)\"|\"reason\":\"bad_signature\"'" % R) if R else "999"
chk("relay error events in 15 min < 5", ev.isdigit() and int(ev) < 5, "events=%s" % ev)
# 8 Flow endpoint: Meta's own signed pings must not be refused (enforce) and the endpoint answers the plain health ping
fl = sh("docker logs --since 15m %s 2>&1 | grep '\\[flows\\] signature' | grep -c refused" % P) if P else "999"
try: sup = float(open("/var/lib/pl-watch/flow-test-until").read()) > time.time()   # written by the enforcement self-test (zz-wording-verify.sh) for 20 minutes: its own negative tests are expected refusals
except Exception: sup = False
chk("Flow endpoint: no refused signatures in 15 min (Meta pings valid)", fl.isdigit() and (int(fl) == 0 or sup), "refused=%s%s" % (fl, " (inside the known enforcement-test window)" if sup and fl.isdigit() and int(fl) else ""))
# 9 certificates (days left)
for h in ("inbox.epic.dm", "uplink.epic.dm", "go.uplink.epic.dm", "pl-adapter.uplink.epic.dm"):
    d = sh("echo | openssl s_client -connect 127.0.0.1:443 -servername %s 2>/dev/null | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2" % h)
    try: days = (time.mktime(time.strptime(d, "%b %d %H:%M:%S %Y %Z")) - time.time()) / 86400
    except Exception: days = -1
    chk("TLS %s > 14 days" % h, days > 14, "days=%.0f" % days)
# 11/12 per-signup checks (v2). Known test identities never alert: the builtin NANP-reserved 555 synthetic exchange (1767555xxxx) plus /var/lib/pl-watch/known-test-identities (digits, one per line).
KT_FILE = "/var/lib/pl-watch/known-test-identities"; SYN = re.compile(r"^1767555[0-9]{4}$"); DBN = os.environ.get("PLW_DBNAME", "isolav2_prod")
def _known():
    out = set()
    try:
        for l in open(KT_FILE):
            d = re.sub(r"[^0-9]", "", l)
            if d: out.add(d)
    except Exception: pass
    return out
KT = _known()
def is_known(phone):
    d = re.sub(r"[^0-9]", "", phone or "")
    return d in KT or bool(SYN.match(d))
PGC = os.environ.get("PLW_DB") or cid("uplink_plsub_restore_db")
def pgq(sql):
    try:
        r = subprocess.run(["docker", "exec", "-i", PGC, "psql", "-U", "postgres", "-d", DBN, "-X", "-At", "-F", "|"], input=sql, capture_output=True, text=True, timeout=25)
        return r.stdout.strip() if r.returncode == 0 else None
    except Exception: return None
SQL_ACCT = """select id, "ownerPhone", floor(extract(epoch from now()-"createdAt")/60) from lite_accounts
  where "createdAt" > now()-interval '24 hours' and "createdAt" < now()-interval '20 minutes'
  and "registeredAt" is null and coalesce("registrationState",'') <> 'activated' and "ownerPhone" not like '%retired%'"""
SQL_ADM = """select id, sender_phone, reason, door, floor(extract(epoch from now()-created_at)/60) from lite_admission_queue
  where drained_at is null and created_at > now()-interval '72 hours' and reason <> 'country_not_open'"""
def per_row_checks():
    a = pgq(SQL_ACCT) if PGC else None
    if a is None: chk("signup checks: account query works", False, "database unreachable"); return
    rows = [x.split("|") for x in a.splitlines() if x.strip()]
    bad = [r for r in rows if not is_known(r[1])]
    for r in bad: chk("acct stalled %s" % r[0][:8], False, "created %s min ago, not registered (staff only; no phone shown)" % r[2])
    if not bad: chk("no unregistered account older than 20 min (24 h window)", True, "known-test excluded=%d" % (len(rows) - len(bad)))
    q = pgq(SQL_ADM)
    if q is None: chk("signup checks: admission queue query works", False, "database unreachable"); return
    qr = [x.split("|") for x in q.splitlines() if x.strip()]
    qb = [r for r in qr if not is_known(r[1])]
    for r in qb: chk("admission queue row %s" % r[0][:8], False, "reason=%s door=%s age=%s min (staff only; no phone shown)" % (r[2], r[3], r[4]))
    if not qb: chk("no undrained admission queue row (72 h window)", True, "known-test excluded=%d" % (len(qr) - len(qb)))
per_row_checks()
CTRL = set((os.environ.get("PLW_CTRL") or "").split(","))   # self-test only: forces a check to evaluate against a condition that exists, to prove the instrument can fire
def public_checks():
    hmin = 0 if "hourly" in CTRL else int(os.environ.get("PLW_HOURLY_MIN", "8"))
    n = pgq("select count(*) from lite_admission_log where decision='admit' and created_at > now()-interval '1 hour'")
    if hmin: chk("admissions in the last hour < %d of the 10/hour ceiling" % hmin, n is not None and n.isdigit() and int(n) < hmin, "admitted_last_hour=%s ceiling=10" % n)
    else: chk("hourly-ceiling probe control (threshold forced to 0)", False, "admitted_last_hour=%s" % n)
    win = "7 days" if "prov" in CTRL else "60 minutes"; cond = "true" if "prov" in CTRL else "a.status <> 'completed' and a.updated_at < now()-interval '5 minutes'"
    p = pgq('select a.id, coalesce(l."ownerPhone",\'\'), a.status, coalesce(a.last_error_code,\'-\'), floor(extract(epoch from now()-a.updated_at)/60) from lite_provision_attempts a left join lite_accounts l on l."userId"=a.user_id where a.created_at > now()-interval \'%s\' and %s' % (win, cond))
    if p is None: chk("provisioning check: query works", False, "database unreachable")
    else:
        pr = [x.split("|") for x in p.splitlines() if x.strip()]; pb = [r for r in pr if "prov" in CTRL or not is_known(r[1])]
        for r in pb: chk("provisioning not completed %s" % r[0][:8], False, "status=%s error=%s age=%s min (staff only; no phone shown)" % (r[2], r[3], r[4]))
        if not pb: chk("no failed or stuck provisioning attempt in 60 min", True, "known-test excluded=%d" % (len(pr) - len(pb)))
    minc = 1 if "dup" in CTRL else 2
    d = pgq('select substring(regexp_replace("ownerPhone",\'[^0-9]\',\'\',\'g\') from 1 for 4)||\'..\'||right(regexp_replace("ownerPhone",\'[^0-9]\',\'\',\'g\'),2), count(*) from lite_accounts where "ownerPhone" not like \'%%retired%%\' group by regexp_replace("ownerPhone",\'[^0-9]\',\'\',\'g\') having count(*) >= %d' % minc + ('' if 'dup' in CTRL else ' and max("createdAt") > now()-interval \'24 hours\'') + ' limit 3')
    if d is None: chk("duplicate-account check: query works", False, "database unreachable")
    else:
        dr = [x for x in d.splitlines() if x.strip()]
        if dr:
            for x in dr[:3]: chk("duplicate account %s" % x.split("|")[0], False, "more than one live account for one owner number, newest created in the last 24 h (masked; the old pre-existing duplicate on ...8382 is tracked separately and does not alert) - PAUSE criterion" if minc == 2 else "control: threshold forced to 1")
        else: chk("no owner number holds more than one live account", True, "")
    CDR = "/usr/local/lib/pl-watch/cdr-check.js"; CF = "/var/lib/pl-watch/cdr.json"
    if "cdr" in CTRL:
        out = sh("docker exec -i %s sh -c 'cd /app && node - --control' < %s" % (P, CDR), 60)
        for ln in out.splitlines():
            if ln.startswith("CASE "):
                nm, _, res = ln[5:].rpartition(": ")
                chk("false-charge control %s" % nm, res.strip() != "ALARM", "result=%s" % res.strip())   # an ALARM case shows as FAIL (the instrument fired); silent cases show OK
        if "CASE" not in out: chk("false-charge control ran", False, "no output: %s" % out[:80])
    else:
        try: c = json.load(open(CF))
        except Exception: c = {"t": 0}
        if time.time() - c.get("t", 0) > (600 if c.get("n") is not None else 45):   # v3.2: a GOOD answer is cached 600 s, an ERROR only 45 s
            out = sh("docker exec -i %s sh -c 'cd /app && node -' < %s" % (P, CDR), 60)
            if "perr" in CTRL: out = "CDR_CHECK_ERROR invalid IP (induced by PLW_CTRL=perr, self-test)"
            m = re.search(r"CDR_CHECK n=(\d+) mode=(\w+)", out); c = {"t": time.time(), "n": int(m.group(1)) if m else None, "raw": out[:80]}
            os.makedirs(os.path.dirname(CF), exist_ok=True); json.dump(c, open(CF, "w"))
        if c.get("n") is None: PERR.append("false-charge probe returned no usable answer: %s" % str(c.get("raw")))   # v3.2: probe_error is NOT a charge finding
        else: chk("no charge on a trial-covered call (bundle prefix, trial active, bundle minutes remaining)", c.get("n") == 0, "covered_calls_billed_24h=%s" % c.get("n"))
if PGC: public_checks()
# 13 flags-file guard: admission is configured only by explicit values in runtime-flags.json. Since the 2026-10-13 admission release a missing/unreadable file or key falls back to FAIL-CLOSED compiled defaults (it can no longer silently open signup), but the configured allowlist and flags would be lost, so alert on drift.
RF = os.environ.get("PLW_FLAGS", "/home/epicadmin/plprod/runtime-flags.json")
def flags_guard():
    need = ("LITE_ADMISSION_OPEN_COUNTRY_PREFIXES", "LITE_ADMISSION_COUNTRY_ALLOWLIST", "PL_CONCIERGE_SVC_PROVISION_ENABLED", "LITE_SELF_SERVE_ENABLED")
    try: d = json.load(open(RF))
    except Exception as e: return False, "runtime-flags.json unreadable (%s): the compiled fail-closed defaults apply (admission stays closed, but the configured allowlist and flags are lost)" % type(e).__name__
    miss = [k for k in need if k not in d]
    return (not miss), ("missing keys: %s (the compiled fail-closed defaults apply: admission stays closed but the configured value is lost)" % ", ".join(miss)) if miss else "prefixes=%d allowlist=%d provision=%s selfserve=%s" % (len(d.get(need[0]) or []), len(d.get(need[1]) or []), d.get(need[2]), d.get(need[3]))
_ok, _d = flags_guard(); chk("admission flags present (fail-open guard)", _ok, _d)
# 10 Meta webhook liveness is INFORMATIONAL only (silence can be a quiet night); reported, never alerts
last = sh("docker exec %s psql -U postgres -d isola -X -At -c \"select extract(epoch from now()-max(created_at))/3600 from messages where message_type=0\"" % cid("uplink_chatwoot-db")) if cid("uplink_chatwoot-db") else ""
info = "last incoming WhatsApp message %.1f h ago (informational)" % float(last) if re.fullmatch(r"[\d.]+", last or "") else "last incoming message age unknown"
# ---- alert sink: a PRIVATE NOTE with an @mention of the staff owner, in a dedicated internal conversation of the existing no-outbound API inbox 12 ----
# Inbox 12 (Channel::Api, no webhook_url) cannot deliver to any customer; private=true is never delivered anyway. Email is an optional extra when /etc/pl-watch/recipients exists.
CW_ACCT, CW_INBOX, CW_STAFF_ID, CW_STAFF_NAME = 2, 12, 16, "Eric Giraud"; CW_TOKEN_FILE = "/etc/pl-secrets/cw_agent_token"
def cw(method, path, body=None):
    import http.client
    tok = open(CW_TOKEN_FILE).read().strip()
    c = http.client.HTTPSConnection("127.0.0.1", 443, context=ssl._create_unverified_context(), timeout=20)
    h = {"api_access_token": tok, "Content-Type": "application/json", "Host": "inbox.epic.dm"}
    c.request(method, "/api/v1/accounts/%d/%s" % (CW_ACCT, path), json.dumps(body) if body is not None else None, h)
    r = c.getresponse(); d = r.read().decode()
    try: j = json.loads(d)
    except Exception: j = {}
    return r.status, j
def load_state():
    try: return json.load(open(STATE))
    except Exception: return {"failing": [], "last_mail": 0}
def setup():
    st = load_state()
    s, f = cw("GET", "contacts/search?q=pl-watch-internal-host04&include_contacts=true")
    hit = [x for x in (f.get("payload") or []) if x.get("identifier") == "pl-watch-internal-host04"] if s == 200 else []
    if hit: c = {"payload": {"contact": hit[0]}}
    else:
        s, c = cw("POST", "contacts", {"name": "PL watch (internal, staff-only)", "identifier": "pl-watch-internal-host04", "inbox_id": CW_INBOX}); assert s in (200, 201), s
    pc = c.get("payload", c); ct = pc.get("contact", pc); src = ct["contact_inboxes"][0]["source_id"]; cid_ = ct["id"]
    s, v = cw("POST", "conversations", {"source_id": src, "inbox_id": CW_INBOX, "contact_id": cid_, "status": "open", "assignee_id": CW_STAFF_ID}); assert s in (200, 201), s
    st["cw_conv"] = v["id"]; os.makedirs(os.path.dirname(STATE), exist_ok=True); json.dump(st, open(STATE, "w")); print("setup: conversation id", v["id"], "inbox", v.get("inbox_id"), "assignee", v.get("meta", {}).get("assignee", {}).get("id"))
def notify(text):
    st = load_state(); conv = st.get("cw_conv")
    if not conv: print("alert sink not set up (run --setup)"); return False
    mention = "[@%s](mention://user/%d/%s)" % (CW_STAFF_NAME, CW_STAFF_ID, CW_STAFF_NAME.replace(" ", "%20"))
    s, v = cw("POST", "conversations/%d/messages" % conv, {"content": mention + " " + text, "message_type": "outgoing", "private": True})
    print("alert private note ->", s, "private=%s" % v.get("private")); return s == 200 and v.get("private") is True
fails = [(n, d) for n, ok, d in checks if not ok]
if "--setup" in sys.argv: setup(); sys.exit(0)
if "--induce" in sys.argv: checks.append(("SELFTEST induced condition (harmless, expected)", False, "induced by --induce")); fails = [(n, d) for n, ok, d in checks if not ok]
for n, ok, d in checks: print(("OK   " if ok else "FAIL ") + n + ((" | " + d) if d else ""))
for e in PERR: print("PROBE_ERROR (instrument, not a charge finding) | " + e)
# ---- v3.3: handoff waiting (staff alert) ----
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
if DRY: print("dry-run: nothing sent; %d check(s) failing" % len(fails)); sys.exit(0)
os.makedirs(os.path.dirname(STATE), exist_ok=True)
if HW_RES and HW_RES[0]:
    try:
        members = os.environ.get("PLW_FIXTURE_MEMBERS")
        if not members:
            cdb = cid("uplink_chatwoot-db"); members = sh("docker exec -i %s psql -U postgres -d isola -X -At -F '|' -c \"select u.id, u.name from team_members tm join users u on u.id = tm.user_id where tm.team_id = 8 order by u.id\"" % cdb, 20)
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
st = load_state(); now = time.time()
perr_n = (int(st.get("perr", 0)) + 1) if PERR else 0
if perr_n >= 3: fails.append(("PROBE ERROR (instrument, not a charge finding): false-charge probe has had no usable answer for %d runs" % perr_n, PERR[0]))
names = sorted(n for n, _ in fails)
PERROW = ("acct stalled ", "admission queue row ", "provisioning not completed ", "duplicate account ")
prev = set(st["failing"]); cur = set(names); gone = sorted(prev - cur)
# per-row alerts (stalled account, admission queue row) fire ONCE per row and once more on recovery; infrastructure failures still repeat every 30 min while they stay failed
repeat = (now - st["last_mail"] > 1800) and any(not n.startswith(PERROW) for n in cur)
if (cur - prev) or gone or repeat:
    body = ("PL watch: %d failing: %s" % (len(names), "; ".join(names[:4]))) if names else "PL watch: all checks OK again"
    if gone and names: body += " | recovered: " + "; ".join(gone[:4])
    detail = "\n".join(("FAIL " if (n, d) in fails else "OK   ") + n + (" | " + d if d else "") for n, ok, d in checks) + "\n" + info + "\nhost04 " + time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    sent = notify(body + "\n\n" + detail)
    if os.path.exists(RECIP):
        to = [l.strip() for l in open(RECIP) if l.strip() and not l.startswith("#")]
        m = EmailMessage(); m["From"] = "PL watch <no-reply@epic.dm>"; m["To"] = ", ".join(to); m["Subject"] = "[PL watch] " + body; m.set_content(detail)
        with smtplib.SMTP("mail.smtp2go.com", 587, timeout=20) as s: s.starttls(context=ssl.create_default_context()); s.send_message(m)
    if sent or os.path.exists(RECIP): st.update({"failing": names, "last_mail": now})
st["perr"] = perr_n; json.dump(st, open(STATE, "w"))
