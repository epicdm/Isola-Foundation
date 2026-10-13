// ISOLATED ACCEPTANCE ONLY. Fake Personal Line service: canned journey/balance for ONE synthetic customer; the journey STATE comes from env PL_STATE.
import http from 'node:http';
const STATE = process.env.PL_STATE || 'active';
const F = { did_pretty: '+1 767 818 5097', registration: 'registered', softphone_activated: true, first_call_done: true, minutes_remaining: 58, minutes_included: 60, low: false, expires_date_pretty: 'October 17, 2026', wallet_xcd: '0.00' };
const J = {
  active: { state: 'active', next_action: 'balance', actions: ['balance', 'recent_calls', 'calling_help'], has_line: true, facts: F },
  registered_no_call: { state: 'registered_no_call', next_action: 'how_to_call', actions: ['how_to_call', 'calling_help', 'balance'], has_line: true, facts: { ...F, first_call_done: false } },
  setup_not_activated: { state: 'setup_not_activated', next_action: 'continue_setup', actions: ['continue_setup'], has_line: true, facts: { ...F, registration: 'unregistered', softphone_activated: false, first_call_done: false } },
  no_line: { state: 'no_line', next_action: 'get_number', actions: ['get_number', 'how_it_works', 'plans'], has_line: false, facts: {} },
}[STATE];
const JOURNEY = { ...J, attention: [], registration_known: true, payment: { topup_available: false, rail: 'fiserv', reason: 'fiserv_topup_not_available_in_chat' }, consent: { estate_suppressed: false, known: true } };
const BALANCE = { known: true, kind: 'included', plan: 'trial', plan_name: 'Free Trial', minutes_included: 60, minutes_remaining: 58, low: false, expires_at: '2026-10-17T00:00:00.000Z', expires_date_pretty: 'October 17, 2026', pool: 'dominica', overage_dominica_xcd: '0.135', overage_uscan_xcd: '1.49', wallet_xcd: '0.00' };
const OFFER = { trial_days: 7, trial_minutes: 60, trial_price_xcd: 0, overage_dominica_xcd: '0.135', overage_uscan_xcd: '1.49' };
let calls = 0;
http.createServer(async (rq, rs) => {
  let raw = ''; for await (const c of rq) raw += c; calls++;
  const m = /\/v1\/(.+)$/.exec(rq.url || ''); const ep = m ? m[1] : '';
  const out = ep === 'account/journey' ? { status: 'ok', code: 'journey', data: JOURNEY } : ep === 'account/balance' ? { status: 'ok', code: 'balance', data: BALANCE } : ep === 'offer' ? { status: 'ok', code: 'offer', data: OFFER } : { status: 'ok', code: 'no_account', data: {} };
  if (rq.url === '/__calls') { rs.writeHead(200); return rs.end(String(calls)); }
  rs.writeHead(200, { 'content-type': 'application/json' }); rs.end(JSON.stringify(out));
}).listen(3300, () => console.log('plstub listening 3300 state=' + STATE));
