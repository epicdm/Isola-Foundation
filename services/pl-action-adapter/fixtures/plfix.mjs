// plfix.mjs - STAGING-ONLY fixture PL concierge service for the expert-agent conversation suite (owner/PM 2026-10-10).
// Answers the same /api/internal/pl-concierge/v1/* endpoints the adapter calls, keyed by the wa_id inside the adapter's assertion,
// with one SYNTHETIC test identity per journey state. No real customer, no telecom, no DB. The classifier itself (journey.ts) and the
// real service are proven separately (19/19 classifier fixtures + live probes); this isolates the CONVERSATION under test.
// Control: GET /__calls (endpoint log), POST /__reset.
import http from 'node:http'

const OFFER = { trial_days: 7, trial_minutes: 60, trial_pool: 'dominica', trial_price_xcd: '0.00',
  plans: [{ key: 'day', name: 'Day Pass', price_xcd: '5.00', days: 1, minutes: 200, pool: 'dominica' }, { key: 'week', name: 'Week Pass', price_xcd: '15.00', days: 7, minutes: 600, pool: 'shared' },
    { key: 'personal', name: 'Personal Line', price_xcd: '35.00', days: 30, minutes: 1000, pool: 'shared' }, { key: 'plus', name: 'Plus', price_xcd: '55.00', days: 30, minutes: 1500, pool: 'shared' }],
  overage_dominica_xcd: '0.135', overage_uscan_xcd: '1.49', voice_only: true, inbound_enabled: true, missed_call_alerts_enabled: false }
const PAY = { topup_available: false, rail: 'fiserv', reason: 'fiserv_topup_not_available_in_chat' }
const OKC = { estate_suppressed: false, known: true }
const base = (did, o) => ({ did_pretty: did, did_masked: did.replace(/\d{3}(?=\s\d{4}$)/, '***'), registration: 'registered', softphone_activated: true, first_call_done: true, inbound_enabled: true,
  plan: 'trial', plan_expires_at: '2026-10-17T13:44:37Z', balance_known: true, balance_kind: 'included', plan_name: 'Free Trial', minutes_included: 60, minutes_remaining: 52, low: false,
  expires_at: '2026-10-17T13:44:37Z', expires_date_pretty: 'October 17, 2026', wallet_xcd: '0.00', overage_dominica_xcd: '0.135', overage_uscan_xcd: '1.49', pool: 'dominica', ...o })
// Synthetic identities (1767555 + 4 digits, never assigned to a customer) -> state
const ID = {
  '17675550101': { state: 'no_line' },
  '17675550102': { state: 'setup_not_activated', facts: base('+1 767 555 0102', { registration: 'unregistered', softphone_activated: false, first_call_done: false }) },
  '17675550103': { state: 'activated_not_registered', facts: base('+1 767 555 0103', { registration: 'unregistered', first_call_done: false }) },
  '17675550104': { state: 'registered_no_call', facts: base('+1 767 555 0104', { registration: 'reachable', first_call_done: false, minutes_remaining: 60 }) },
  '17675550105': { state: 'active', facts: base('+1 767 555 0105', {}) },
  '17675550106': { state: 'attention', facts: base('+1 767 555 0106', { minutes_remaining: 4, low: true, wallet_xcd: '0.00' }) },
  '17675550107': { state: 'active', facts: base('+1 767 555 0107', { registration: 'unregistered' }) },   // working line, app asleep -> a failed call
  '17675550108': { state: 'attention', facts: base('+1 767 555 0108', { minutes_remaining: 0, low: true, wallet_xcd: '0.00' }) },   // trial minutes exhausted, no credit
}
const ACTIONS = { no_line: ['get_number', 'how_it_works', 'plans'], setup_not_activated: ['continue_setup', 'human'], activated_not_registered: ['check_connection', 'continue_setup', 'human'],
  registered_no_call: ['how_to_call', 'troubleshoot', 'human'], active: ['balance', 'recent_calls', 'calling_help'], attention: ['balance', 'plans', 'human'] }
const ATT = { attention: ['minutes_low'] }
const ATT_BY_WA = { '17675550108': ['minutes_exhausted'] }
const calls = []
const waOf = (h) => { try { const p = JSON.parse(Buffer.from(String(h).split('.')[1], 'base64url').toString('utf8')); return String(p.wa_id) } catch { return null } }
const send = (res, code, body) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ status: code === 'no_account' ? 'no_account' : 'ok', code, data: body ?? {} })) }
http.createServer((req, res) => {
  let raw = ''; req.on('data', (c) => { raw += c }); req.on('end', () => {
    const url = new URL(req.url, 'http://x'), p = url.pathname
    if (p === '/__calls') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ calls: calls.slice(-200) })) }
    if (p === '/__reset') { calls.length = 0; res.writeHead(200); return res.end('{}') }
    const ep = p.replace('/api/internal/pl-concierge/v1/', '')
    const wa = waOf(req.headers['x-isola-assertion'])
    let body = {}; try { body = raw ? JSON.parse(raw) : {} } catch {}
    calls.push({ t: Date.now(), ep, wa: wa ? '***' + wa.slice(-4) : null, body })
    const id = ID[wa] ?? ID['17675550101']
    const f = id.facts
    if (ep === 'offer') return send(res, 'offer', OFFER)
    if (ep === 'account/journey') {
      if (!f) return send(res, 'journey', { state: 'no_line', next_action: 'get_number', actions: ACTIONS.no_line, attention: [], registration_known: false, has_line: false, facts: null, payment: PAY })
      return send(res, 'journey', { state: id.state, next_action: ACTIONS[id.state][0], actions: ACTIONS[id.state], attention: ATT_BY_WA[wa] ?? ATT[id.state] ?? [], registration_known: true, has_line: true, facts: f, payment: PAY, consent: OKC })
    }
    if (!f && ep !== 'flows/launch') return send(res, 'no_account', {})
    if (ep === 'account/balance') return send(res, 'balance', { known: true, kind: 'included', plan: 'trial', plan_name: f.plan_name, minutes_included: f.minutes_included, minutes_remaining: f.minutes_remaining, low: f.low, expires_at: f.expires_at, expires_date_pretty: f.expires_date_pretty, pool: f.pool, overage_dominica_xcd: '0.135', overage_uscan_xcd: '1.49', wallet_xcd: f.wallet_xcd })
    if (ep === 'account/recent-calls') return send(res, 'recent_calls', { known: true, calls: f.first_call_done ? [{ dir: 'out', number_masked: '***2300', duration_s: 95, started_at: '2026-10-10T14:00:56Z' }, { dir: 'out', number_masked: '***4410', duration_s: 0, started_at: '2026-10-10T13:52:10Z' }] : [] })
    if (ep === 'account/line-status') return send(res, 'line_status', { did_pretty: f.did_pretty, did_masked: f.did_masked, registration: f.registration, listener_connected: true, softphone_activated: f.softphone_activated, first_call_done: f.first_call_done, inbound_enabled: true, missed_call_alerts_enabled: false, plan: f.plan, plan_expires_at: f.plan_expires_at, next_step: f.first_call_done ? 'done' : f.softphone_activated ? 'test_call' : 'install' })
    if (ep === 'flows/launch') return send(res, 'flow_sent', { flow: 'signup', expires_in_min: 60, existing_line: !!f, did_masked: f?.did_masked ?? null })
    if (ep === 'account/next-step') return send(res, 'next_step', { stage: f.first_call_done ? 'first_call_done' : f.softphone_activated ? 'awaiting_registration' : 'install', facts: { did_pretty: f.did_pretty, plan: f.plan, inbound_enabled: true }, store_links: { ios: 'https://apps.apple.com/us/app/cloud-softphone/id567475545', android: 'https://play.google.com/store/apps/details?id=cz.acrobits.softphone.cloudphone' } })
    if (ep === 'lines/provision') return send(res, 'line_exists', { did_pretty: f.did_pretty, did_masked: f.did_masked })
    return send(res, 'bad_response', {})
  })
}).listen(3005, '0.0.0.0', () => console.log('plfix listening 3005'))
