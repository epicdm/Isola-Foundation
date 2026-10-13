#!/usr/bin/env python3
# Fault + control fixtures for pl_journey_monitor.detect (isolated: no database, no Chatwoot, no customer). Every fault has a
# NORMAL CONTROL in the same run that must raise nothing (Law 19: an absence assertion needs a positive twin).
import sys, os
from datetime import datetime, timezone, timedelta
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pl_journey_monitor as M

NOW = datetime(2026, 10, 11, 2, 0, 0, tzinfo=timezone.utc)
ago = lambda s: NOW - timedelta(seconds=s)
fails = 0
def check(name, ok):
    global fails
    print(('PASS ' if ok else 'FAIL ') + name)
    fails += 0 if ok else 1
def msg(i, conv, typ, content='x', private=False, st='Contact', sid=0, at=600): return {'id': i, 'conv': conv, 'type': typ, 'private': private, 'sender_type': st, 'sender_id': sid, 'content': content, 'at': ago(at), 'delivery': '1'}
kinds = lambda exc: sorted(x['kind'] for x in exc)
base = dict(messages=[], convs={}, relay=[], audit=[], guidance=[], prefs={})
run = lambda **k: M.detect(**{**base, **k}, now=NOW)

# CONTROL: a normal answered conversation, a requested handoff, a resolved provisioning, a receipt -> no exceptions
normal = run(messages=[msg(1, 9, 0, 'hi', at=900), msg(2, 9, 1, 'reply', st='User', sid=20, at=890), msg(3, 9, 0, 'talk to a person', at=800), msg(4, 9, 1, "I'll bring in a teammate", st='User', sid=20, at=799)],
             convs={9: 'pending'}, relay=[{'event': 'reply', 'conversationId': 9, 'messageId': 2}, {'event': 'handoff', 'outcome': M.REQUESTED_HANDOFF, 'conversationId': 9, 'messageId': 3}],
             audit=[{'endpoint': 'lines/provision', 'code': 'provisioning', 'outcome': 'started', 'rid': 'cw-9', 'wa_hash': 'h1', 'at': ago(1200)}, {'endpoint': 'lines/provision', 'code': 'line_created', 'outcome': 'done', 'rid': 'cw-9', 'wa_hash': 'h1', 'at': ago(1180), 'account': 'a1'}])
check('CONTROL normal conversation, requested handoff and resolved provisioning raise NOTHING', normal == [])

check('E1 AI-owned inbound unanswered for >3 min -> no_reply', kinds(run(messages=[msg(1, 9, 0, 'hello?', at=400)], convs={9: 'pending'})) == ['no_reply'])
check('E1 CONTROL same message but conversation human-owned (open) -> nothing (not the AI\'s to answer)', run(messages=[msg(1, 9, 0, 'hello?', at=400)], convs={9: 'open'}) == [])
check('E1 CONTROL unanswered for only 60 s -> nothing yet', run(messages=[msg(1, 9, 0, 'hello?', at=60)], convs={9: 'pending'}) == [])
check('E2 relay agent_unavailable -> tool_or_binding_failure', kinds(run(relay=[{'event': 'agent_unavailable', 'reason': 'http_404', 'conversationId': 9, 'messageId': 5}])) == ['tool_or_binding_failure'])
check('E2 unrequested handoff (validator_failed) -> unrequested_handoff', kinds(run(relay=[{'event': 'handoff', 'outcome': 'agent unavailable (validator_failed)', 'conversationId': 9, 'messageId': 5}])) == ['unrequested_handoff'])
check('E2 refused deterministic action -> action_refused', kinds(run(relay=[{'event': 'action', 'outcome': 'refused', 'action': 'balance', 'code': 'service_unavailable', 'conversationId': 9, 'messageId': 5}])) == ['action_refused'])
check('E3 relay next_action_not_offered -> wrong next action surfaced', kinds(run(relay=[{'event': 'monitor_exception', 'kind': 'next_action_not_offered', 'titles': ['Check connection'], 'conversationId': 9, 'messageId': 5}])) == ['next_action_not_offered'])
check('E4 provisioning started 15 min ago, never resolved -> provisioning_unresolved', kinds(run(audit=[{'endpoint': 'lines/provision', 'code': 'provisioning', 'outcome': 'started', 'rid': 'cw-9', 'wa_hash': 'h1', 'at': ago(900)}])) == ['provisioning_unresolved'])
check('E4 CONTROL started 2 min ago -> still within policy, nothing', run(audit=[{'endpoint': 'lines/provision', 'code': 'provisioning', 'outcome': 'started', 'rid': 'cw-9', 'wa_hash': 'h1', 'at': ago(120)}]) == [])
check('E5 two DISTINCT accounts allocated to one sender -> suspected_duplicate_allocation', kinds(run(audit=[{'endpoint': 'lines/provision', 'code': 'line_created', 'outcome': 'done', 'rid': 'cw-9', 'wa_hash': 'h1', 'at': ago(900), 'account': 'a1'}, {'endpoint': 'lines/provision', 'code': 'line_created', 'outcome': 'done', 'rid': 'cw-9', 'wa_hash': 'h1', 'at': ago(100), 'account': 'a2'}])) == ['suspected_duplicate_allocation'])
check('E5 CONTROL production shape: created + idempotent replays (mid_dedupe, same account, no outcome) -> nothing', run(audit=[{'endpoint': 'lines/provision', 'code': 'line_created', 'outcome': 'done', 'rid': 'cw-9', 'wa_hash': 'h1', 'at': ago(900), 'account': 'a1'}, {'endpoint': 'lines/provision', 'code': 'line_created', 'outcome': None, 'rid': 'cw-9', 'wa_hash': 'h1', 'at': ago(890), 'account': 'a1'}, {'endpoint': 'lines/provision', 'code': 'line_created', 'outcome': None, 'rid': 'cw-9', 'wa_hash': 'h1', 'at': ago(880), 'account': 'a1'}]) == [])
check('E5 CONTROL line_created then line_exists (idempotent repeat) -> nothing', run(audit=[{'endpoint': 'lines/provision', 'code': 'line_created', 'outcome': 'done', 'rid': 'cw-9', 'wa_hash': 'h1', 'at': ago(900)}, {'endpoint': 'lines/provision', 'code': 'line_exists', 'outcome': 'done', 'rid': 'cw-9', 'wa_hash': 'h1', 'at': ago(100)}]) == [])
check('E7 proactive after STOP -> ai_send_after_opt_out', kinds(run(guidance=[{'event': 'proactive', 'wa_hash': 'h1', 'posted': True, 'at': ago(60)}], prefs={'h1': (True, ago(600))})) == ['ai_send_after_opt_out'])
check('E7 CONTROL proactive BEFORE the STOP, or after START -> nothing', run(guidance=[{'event': 'proactive', 'wa_hash': 'h1', 'posted': True, 'at': ago(900)}], prefs={'h1': (True, ago(600))}) == [] and run(guidance=[{'event': 'proactive', 'wa_hash': 'h2', 'posted': True, 'at': ago(60)}], prefs={'h2': (False, ago(600))}) == [])
human = [msg(1, 9, 2, 'Assigned to Eric Giraud via escalations by PL Relay Bot', st='', at=900), msg(2, 9, 1, 'Your balance: ...', st='User', sid=20, at=800)]
check('E8 AI message while a person holds the conversation -> ai_send_during_human_ownership', kinds(run(messages=human, convs={9: 'open'})) == ['ai_send_during_human_ownership'])
handback = human[:1] + [msg(3, 9, 2, 'Conversation was marked as pending by PL Relay Bot', st='', at=850), msg(4, 9, 1, 'Your balance: ...', st='User', sid=20, at=800)]
check('E8 CONTROL AI message after handback (marked as pending) -> nothing', run(messages=handback, convs={9: 'pending'}) == [])
staff = human[:1] + [msg(5, 9, 1, 'Hi, Eric here', st='User', sid=16, at=800)]
check('E8 CONTROL a PERSON replying while they hold it -> nothing', run(messages=staff, convs={9: 'open'}) == [])
resolved = human[:1] + [msg(6, 9, 2, 'Conversation was marked resolved by Eric Giraud', st='', at=850), msg(7, 9, 0, 'hi again', at=840), msg(8, 9, 1, 'reply', st='User', sid=20, at=830)]
check('E8 CONTROL production conv 495 shape: staff RESOLVED, customer wrote again, AI answered -> nothing', run(messages=resolved, convs={9: 'pending'}) == [])
check('redaction: long digit runs and links are masked', '17675550199' not in M.mask('call 17675550199 at https://go.uplink.epic.dm/go/abc') and '<link>' in M.mask('see https://x.y/z'))
print(('ALL PASSED' if not fails else f'{fails} FAILED'))
sys.exit(1 if fails else 0)
