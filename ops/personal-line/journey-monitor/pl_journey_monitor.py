#!/usr/bin/env python3
"""pl_journey_monitor.py - minimal Personal Line journey monitor on host03 (plan v4.10, coord-pm-execute-pl-run-monitoring-and-customer-walk).

Built ONLY from existing records (no new runtime, no new store):
  - Chatwoot  isola_chatwoot-db / isola        : inbox 11 messages (inbound, outbound, private notes, activity) + conversation status
  - relay     docker service logs sf-relay-pl-prod : decide/answer/action/handoff/reply/monitor_exception events (JSON lines)
  - PL service plsub_restore_db / isolav2_prod  : pl_concierge_audit (endpoint, code, outcome, rid=cw-<conv>, wa_last4) + lite_accounts
  - adapter   pl_adapter_db                     : pl_adapter_guidance (proactive/receipt rows), pl_adapter_preference (STOP)
Modes:
  trace <chatwoot display conversation id> [hours]  -> joined, redacted timeline (inbound -> agent/tool -> outbound -> state)
  scan [minutes] [--notify]                          -> exceptions; with --notify each NEW exception becomes ONE private Chatwoot note
                                                        on that conversation (staff path; never a customer message)
Redaction: digits runs >= 5 are masked, wa ids appear as last-4 only, no tokens/links/SIP data are read or printed.
"""
import json, re, subprocess, sys, os, time
from datetime import datetime, timezone, timedelta

STATE = os.path.expanduser('~/pl-monitor/state.json')
CW_DB = ('isola_chatwoot-db', 'isola')
PL_DB = ('plsub_restore_db', 'isolav2_prod')
AD_DB = ('pl_adapter_db', None)
RELAY = 'sf-relay-pl-prod'
AI_SENDERS = {('User', 20)}   # 'PL Relay Bot' (relay + adapter post as this agent); AgentBot rows also count
# thresholds (existing policy where one exists)
NO_REPLY_S = 180              # an AI-owned inbound with no reply after 3 min (relay turns take 5-20 s)
PROVISION_RESOLVE_S = 600     # plsvc PROVISION_STALE_S is 200 s; 10 min without a final result = unresolved
REQUESTED_HANDOFF = 'customer explicitly requested a person'

def mask(s, n=160):
    s = re.sub(r'\d{5,}', lambda m: m.group(0)[:2] + '*' * (len(m.group(0)) - 4) + m.group(0)[-2:], str(s or ''))
    s = re.sub(r'https?://\S+', '<link>', s)
    return s.replace('\n', ' / ')[:n]

def sh(cmd, timeout=60):
    p = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=timeout)
    return p.stdout

def psql(svc, db, sql):
    cid = sh(f"sudo -n docker ps -q -f name={svc} | head -1").strip()
    if not cid: return []
    user = sh(f"sudo -n docker exec {cid} sh -c 'echo ${{POSTGRES_USER:-postgres}}'").strip()
    if db is None: db = sh(f"sudo -n docker exec {cid} sh -c 'echo ${{POSTGRES_DB:-postgres}}'").strip()
    out = sh(f"sudo -n docker exec -i {cid} psql -U {user} -d {db} -XAt -c \"copy ({sql}) to stdout with (format csv, header false)\"" .replace('$', '\\$'))
    import csv, io
    return list(csv.reader(io.StringIO(out)))

def relay_events(minutes):
    out = sh(f"sudo -n docker service logs {RELAY} --since {int(minutes)}m --raw 2>&1", timeout=120)
    ev = []
    for line in out.splitlines():
        i = line.find('{')
        if i < 0: continue
        try: o = json.loads(line[i:])
        except Exception: continue
        if isinstance(o, dict) and 'event' in o: ev.append(o)
    return ev

# ── pure detectors (unit-tested with fixtures in test_pl_journey_monitor.py) ──────────────────────────────────────────────────────────
def detect(messages, convs, relay, audit, guidance, prefs, now):
    """messages: [{id, conv, type(0 in/1 out/2 activity), private, sender_type, sender_id, content, at}] ; convs: {conv: status}
    relay: relay JSON events ; audit: [{endpoint, code, outcome, rid, wa_hash, at}] ; guidance: [{event, wa_hash, posted, at}] ;
    prefs: {wa_hash: (stopped, at)}. Returns [{key, kind, conv, detail}]."""
    exc = []
    by_conv = {}
    for m in messages: by_conv.setdefault(m['conv'], []).append(m)
    # E1 no reply to an AI-owned inbound
    for conv, ms in by_conv.items():
        ms.sort(key=lambda m: m['id'])
        if convs.get(conv) != 'pending': continue
        for m in ms:
            if m['type'] != 0 or m['private']: continue
            if (now - m['at']).total_seconds() < NO_REPLY_S: continue
            after = [x for x in ms if x['id'] > m['id'] and x['type'] == 1]
            later_in = [x for x in ms if x['id'] > m['id'] and x['type'] == 0]
            if not after and not later_in:
                exc.append({'key': f'no_reply:{conv}:{m["id"]}', 'kind': 'no_reply', 'conv': conv, 'detail': f'inbound {m["id"]} unanswered for {int((now - m["at"]).total_seconds())} s'})
    # E2 relay failures / unrequested handoffs, E3 wrong next action (relay monitor hook), E8 rotations are informational only
    for e in relay:
        conv, msg = e.get('conversationId'), e.get('messageId')
        if e.get('event') in ('agent_unavailable', 'relay_error', 'pl_tool_readback_unavailable', 'pl_offer_readback_invalid', 'conversation_binding_write_failed', 'ownership_unreadable', 'action_unavailable'):
            exc.append({'key': f'relay:{e.get("event")}:{conv}:{msg}', 'kind': 'tool_or_binding_failure', 'conv': conv, 'detail': f'{e.get("event")} {e.get("reason") or e.get("code") or ""}'.strip()})
        elif e.get('event') == 'handoff' and e.get('outcome') != REQUESTED_HANDOFF:
            exc.append({'key': f'handoff:{conv}:{msg}', 'kind': 'unrequested_handoff', 'conv': conv, 'detail': str(e.get('outcome'))[:120]})
        elif e.get('event') == 'action' and e.get('outcome') == 'refused':
            exc.append({'key': f'action:{conv}:{msg}', 'kind': 'action_refused', 'conv': conv, 'detail': f'{e.get("action")} {e.get("code")}'})
        elif e.get('event') == 'monitor_exception':
            exc.append({'key': f'mon:{e.get("kind")}:{conv}:{msg}', 'kind': e.get('kind'), 'conv': conv, 'detail': ','.join(e.get('titles') or [])})
    # E4 confirmation without a resolved provisioning result ; E5 suspected duplicate allocation
    prov = [a for a in audit if a['endpoint'] == 'lines/provision']
    for a in prov:
        if a['code'] == 'provisioning' or a['outcome'] == 'started':
            done = [b for b in prov if b['wa_hash'] == a['wa_hash'] and b['at'] >= a['at'] and b['code'] in ('line_created', 'line_exists')]
            if not done and (now - a['at']).total_seconds() > PROVISION_RESOLVE_S:
                exc.append({'key': f'prov_unresolved:{a["wa_hash"]}:{a["at"].isoformat()}', 'kind': 'provisioning_unresolved', 'conv': rid_conv(a['rid']), 'detail': f'{a["code"]}/{a["outcome"]} since {a["at"].isoformat()}'})
    # an idempotent replay (detail mid_dedupe, outcome empty) repeats the SAME account; only distinct ACCOUNTS with a finished
    # allocation (outcome done) count. Measured 2026-10-11: two real distinct allocations per sender after test resets.
    created = {}
    for a in prov:
        if a['code'] == 'line_created' and a['outcome'] == 'done' and a.get('account'): created.setdefault(a['wa_hash'], {})[a['account']] = a
    for wh, accts in created.items():
        if len(accts) > 1:
            last = sorted(accts.values(), key=lambda x: x['at'])[-1]
            exc.append({'key': f'dup_alloc:{wh}:{len(accts)}', 'kind': 'suspected_duplicate_allocation', 'conv': rid_conv(last['rid']), 'detail': f'{len(accts)} distinct accounts allocated to one sender - check whether the earlier ones were removed'})
    # E7 proactive send after STOP / AI send during human ownership
    for g in guidance:
        if g['event'] != 'proactive' or not g['posted']: continue
        st = prefs.get(g['wa_hash'])
        if st and st[0] and st[1] <= g['at']:
            exc.append({'key': f'proactive_after_stop:{g["wa_hash"]}:{g["at"].isoformat()}', 'kind': 'ai_send_after_opt_out', 'conv': None, 'detail': 'proactive message after STOP'})
    for conv, ms in by_conv.items():
        human = False
        for m in sorted(ms, key=lambda x: x['id']):
            if m['type'] == 2:
                c = m['content'].lower()
                # "Assigned to <assignee> via <team> by <actor>": the ASSIGNEE decides ownership, not the actor (the relay assigns humans on
                # handoff). "was reopened" (by anyone, incl. the relay's own handoff) means a person now owns it.
                if 'assigned to' in c:
                    assignee = re.split(r'\s+(?:via|by)\s+', c.split('assigned to', 1)[1].strip(), maxsplit=1)[0]
                    if 'pl relay bot' not in assignee: human = True
                if 'was reopened' in c: human = True
                # handback (pending) or close (resolved: Chatwoot returns the next customer message to the bot) ends human ownership
                if 'marked as pending' in c or 'marked resolved' in c or 'marked as resolved' in c: human = False
            elif m['type'] == 1 and not m['private'] and human and ((m['sender_type'], m['sender_id']) in AI_SENDERS or m['sender_type'] == 'AgentBot'):
                if 'bring in a teammate' in m['content'].lower(): continue   # the handoff line itself
                exc.append({'key': f'ai_during_human:{conv}:{m["id"]}', 'kind': 'ai_send_during_human_ownership', 'conv': conv, 'detail': f'AI message {m["id"]} while a person held the conversation'})
    return exc

def rid_conv(rid):
    m = re.match(r'^cw-(\d+)$', str(rid or ''))
    return int(m.group(1)) if m else None

# ── loaders (production records, read-only) ──────────────────────────────────────────────────────────────────────────────────────────
def ts(s): return datetime.fromisoformat(s.replace(' ', 'T').split('+')[0]).replace(tzinfo=timezone.utc) if s else None

def load(minutes, conv_display=None):
    where_conv = f"and c.display_id = {int(conv_display)}" if conv_display else ""
    rows = psql(*CW_DB, f"select m.id, c.display_id, m.message_type, m.private, coalesce(m.sender_type,''), coalesce(m.sender_id,0), left(coalesce(m.content,''),300), to_char(m.created_at at time zone 'UTC','YYYY-MM-DD HH24:MI:SS'), c.status, m.status from messages m join conversations c on c.id=m.conversation_id where m.inbox_id=11 and m.account_id=2 and m.created_at > now() - interval '{int(minutes)} minutes' {where_conv} order by m.id")
    status_name = {'0': 'open', '1': 'resolved', '2': 'pending', '3': 'snoozed'}
    messages, convs = [], {}
    for r in rows:
        messages.append({'id': int(r[0]), 'conv': int(r[1]), 'type': int(r[2]), 'private': r[3] == 't', 'sender_type': r[4], 'sender_id': int(r[5] or 0), 'content': r[6], 'at': ts(r[7]), 'delivery': r[9]})
        convs[int(r[1])] = status_name.get(r[8], r[8])
    rid = f"and rid = 'cw-{int(conv_display)}'" if conv_display else ""
    audit = [{'endpoint': r[0], 'code': r[1], 'outcome': r[2] or None, 'rid': r[3], 'wa_hash': r[4], 'at': ts(r[5]), 'wa_last4': r[6], 'account': r[7] or None} for r in psql(*PL_DB,
        f"select endpoint, code, coalesce(outcome,''), coalesce(rid,''), coalesce(wa_id_hash,''), to_char(created_at,'YYYY-MM-DD HH24:MI:SS'), coalesce(wa_last4,''), coalesce(account_hash,'') from pl_concierge_audit where created_at > now() - interval '{int(max(minutes, 1440))} minutes' {rid} order by created_at")]
    guidance = [{'event': r[0], 'wa_hash': r[1], 'posted': bool(r[2]), 'at': ts(r[3]), 'conv': r[4], 'stage': r[5], 'msg': r[6]} for r in psql(*AD_DB,
        f"select event, wa_hash, coalesce(posted_msg_id,''), to_char(created_at,'YYYY-MM-DD HH24:MI:SS'), cw_conversation, coalesce(stage,''), message_id from pl_adapter_guidance where created_at > now() - interval '{int(minutes)} minutes' order by created_at")]
    prefs = {r[0]: (r[1] == 't', ts(r[2])) for r in psql(*AD_DB, "select wa_hash, proactive_stopped, to_char(updated_at,'YYYY-MM-DD HH24:MI:SS') from pl_adapter_preference")}
    relay = relay_events(minutes)
    if conv_display: relay = [e for e in relay if e.get('conversationId') == int(conv_display)]
    return messages, convs, relay, audit, guidance, prefs

def trace(conv_display, hours):
    messages, convs, relay, audit, guidance, prefs = load(int(hours * 60), conv_display)
    rows = []
    for m in messages:
        kind = {0: 'IN ', 1: 'OUT', 2: 'ACT'}.get(m['type'], '?')
        who = 'note' if m['private'] else ('ai' if (m['sender_type'], m['sender_id']) in AI_SENDERS or m['sender_type'] == 'AgentBot' else ('customer' if m['type'] == 0 else 'staff' if m['type'] == 1 else ''))
        rows.append((m['at'], f"chatwoot {kind} #{m['id']} {who:8} delivery={m['delivery']:>2} {mask(m['content'])}"))
    for e in relay:
        if e.get('event') == 'ignored' and e.get('reason') in ('not_incoming', 'event', 'private'): continue   # the relay seeing its own/staff messages
        t = ts(e.get('ts', '').replace('Z', '')) if e.get('ts') else None
        extra = {k: v for k, v in e.items() if k in ('reason', 'outcome', 'action', 'code', 'buttons', 'chars', 'kind', 'titles', 'state', 'already')}
        rows.append((t, f"relay    {e['event']:<28} msg={e.get('messageId')} {json.dumps(extra)[:180]}"))
    for a in audit:
        rows.append((a['at'], f"plsvc    {a['endpoint']:<28} code={a['code']} outcome={a['outcome']} wa=***{a['wa_last4']}"))
    for g in guidance:
        if g['conv'] != str(conv_display): continue
        rows.append((g['at'], f"adapter  {g['event']:<28} stage={g['stage']} posted={'yes' if g['posted'] else 'no'}"))
    print(f"# journey trace: Chatwoot conversation {conv_display} (status now: {convs.get(int(conv_display), 'unknown')}), last {hours} h, UTC")
    for t, s in sorted(rows, key=lambda x: x[0] or datetime.min.replace(tzinfo=timezone.utc)):
        print(f"{t.strftime('%Y-%m-%d %H:%M:%S') if t else '?':19}  {s}")
    exc = detect(messages, convs, relay, audit, guidance, prefs, datetime.now(timezone.utc))
    print(f"# exceptions: {len(exc)}")
    for x in exc: print('  !', x['kind'], x['detail'])
    print("# unknowns: WhatsApp delivery is Chatwoot's message status (0 sent, 1 delivered, 2 read, 3 failed) - no status means unknown; SIP registration/calls are read by plsvc at request time and are not historical here.")

def notify(conv, text):
    """One private note on the conversation, posted with the relay's own agent token (never printed)."""
    js = ("import { readFileSync } from 'node:fs';const t=readFileSync(process.env.CHATWOOT_BOT_TOKEN_FILE,'utf8').trim();"
          f"const r=await fetch(process.env.CHATWOOT_BASE_URL+'/api/v1/accounts/2/conversations/{int(conv)}/messages',{{method:'POST',headers:{{'content-type':'application/json',api_access_token:t}},body:JSON.stringify({{content:process.argv[1],message_type:'outgoing',private:true}})}});console.log(r.status)")
    cid = sh(f"sudo -n docker ps -q -f name={RELAY} | head -1").strip()
    p = subprocess.run(['sudo', '-n', 'docker', 'exec', cid, 'node', '--input-type=module', '-e', js, text], capture_output=True, text=True, timeout=30)
    return p.stdout.strip()

def scan(minutes, do_notify):
    messages, convs, relay, audit, guidance, prefs = load(minutes)
    now = datetime.now(timezone.utc)
    exc = detect(messages, convs, relay, audit, guidance, prefs, now)
    try: state = json.load(open(STATE))
    except Exception: state = {}
    new = [x for x in exc if x['key'] not in state]
    for x in new:
        res = None
        if do_notify and x['conv']:
            res = notify(x['conv'], f"⚠ Journey monitor ({x['kind']}): {x['detail']}. Staff check needed - the customer was NOT messaged by the monitor.")
        state[x['key']] = {'at': now.isoformat(), 'kind': x['kind'], 'conv': x['conv'], 'notified': res}
    os.makedirs(os.path.dirname(STATE), exist_ok=True)
    json.dump(state, open(STATE, 'w'))
    print(json.dumps({'at': now.isoformat(), 'window_min': minutes, 'messages': len(messages), 'relay_events': len(relay), 'exceptions': len(exc), 'new': [{k: v for k, v in x.items() if k != 'key'} for x in new]}))

if __name__ == '__main__':
    if len(sys.argv) >= 3 and sys.argv[1] == 'trace': trace(sys.argv[2], float(sys.argv[3]) if len(sys.argv) > 3 else 24)
    elif len(sys.argv) >= 2 and sys.argv[1] == 'scan': scan(int(sys.argv[2]) if len(sys.argv) > 2 else 15, '--notify' in sys.argv)
    else: print(__doc__)
