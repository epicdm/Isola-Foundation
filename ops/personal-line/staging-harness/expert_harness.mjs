// expert_harness.mjs - Personal Line EXPERT-CONCIERGE conversation suite (PM coord-pm-execute-native-personal-line-expert-agent-now-2026-10-10).
// Isolated: host03 staging only (plstg_net). Path under test: signed Chatwoot webhook -> staging relay -> staging Uplink (PRODUCTION image digest,
// REAL model under the staging dollar gate) -> MCP over TLS -> PL action adapter (real code) -> plfix (synthetic identities, one per journey state)
// + mock Chatwoot. No production Chatwoot, no real customer, no owner conversation, no telecom. Usage: node expert_harness.mjs <label>
// Prints a JSON transcript per scenario + the gate spend before/after. Hard caps: <= 5 customer turns per conversation, <= 30 model turns per run.
import crypto from 'node:crypto'
import fs from 'node:fs'
import { createRequire } from 'node:module'

const RELAY = process.env.RELAY_URL || 'http://relay:3000'
const MOCK = process.env.MOCK_URL || 'http://mock-ext:9000'
const PLFIX = process.env.PLFIX_URL || 'http://plfix:3005'
const rd = (p) => fs.readFileSync(p, 'utf8').trim()
const BOT_SECRET = rd(process.env.BOT_SECRET_FILE || '/run/secrets/bot_secret')
const ENV_FILE = '/run/' + 'secrets/uplink_env'
const LABEL = process.argv[2] || 'run'
const ONLY = (process.env.ONLY || '').split(',').filter(Boolean)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const j = async (url, init = {}) => { const r = await fetch(url, init); let b = null; try { b = await r.json() } catch {} return { status: r.status, body: b } }
const mockPost = (path, body) => j(`${MOCK}${path}`, { method: 'POST', body: JSON.stringify(body || {}) })

function webhook(payload) {
  const raw = JSON.stringify(payload), ts = Math.floor(Date.now() / 1000)
  const sig = 'sha256=' + crypto.createHmac('sha256', BOT_SECRET).update(`${ts}.`).update(raw).digest('hex')
  return j(`${RELAY}/v1/chatwoot/agent-bot`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-chatwoot-timestamp': String(ts), 'x-chatwoot-signature': sig }, body: raw })
}
const eventFor = (m, conv, contactId) => ({ event: 'message_created', id: m.id, content: m.content, message_type: 'incoming', private: false, sender: { id: contactId, name: 'Synthetic' }, account: { id: 2 }, inbox: { id: 11 }, conversation: { id: conv, status: 'pending', meta: { sender: { id: contactId } } }, created_at: m.created_at })
const CONV_OFFSET = Number(process.env.CONV_OFFSET || 0)
async function world(suffix, convBase) {
  const wa = '176755501' + suffix, conv = convBase + CONV_OFFSET, contact = convBase + CONV_OFFSET + 1000
  await mockPost('/__cw_seed', { contacts: [{ id: contact, name: 'Synthetic ' + suffix, phone_number: '+' + wa, contact_inboxes: [{ source_id: wa, inbox: { id: 11, channel_type: 'Channel::Whatsapp', provider: 'whatsapp_cloud' } }] }], conversations: [{ id: conv, inbox_id: 11, contactId: contact, status: 'pending', custom_attributes: {} }] })
  return { wa, conv, contact }
}
let modelTurns = 0
async function say(w, text, { model = true } = {}) {
  if (model && ++modelTurns > 30) throw new Error('model turn cap')
  const m = (await mockPost('/__cw_incoming', { conversation_id: w.conv, content: text })).body
  const before = (await j(`${PLFIX}/__calls`)).body.calls.length
  await webhook(eventFor(m, w.conv, w.contact))
  // wait for the FIRST reply to this message (model turns can exceed 6 s), then for quiescence
  for (let i = 0; i < 40; i++) { const ms = (await mockPost('/__cw_messages', { conversation_id: w.conv })).body.messages; if (ms.some((x) => x.id > m.id && x.message_type === 1)) break; await sleep(1500) }
  let last = -1, stable = 0
  for (let i = 0; i < 45 && stable < 3; i++) { await sleep(2000); const n = (await mockPost('/__cw_messages', { conversation_id: w.conv })).body.messages.length; stable = n === last ? stable + 1 : 0; last = n }
  const msgs = (await mockPost('/__cw_messages', { conversation_id: w.conv })).body.messages
  const after = (await j(`${PLFIX}/__calls`)).body.calls
  return { customer: text, replies: msgs.filter((x) => x.id > m.id && x.message_type === 1).map((x) => ({ private: x.private, text: x.content, buttons: x.items })), pl_calls: after.slice(before).map((c) => c.ep) }
}
const setStatus = (w, status) => mockPost('/__cw_status', { id: w.conv, status })

// tap = the customer presses a button that was really offered (its title arrives as their message); falls back to typed text if not offered
async function tap(w, title, fallback) {
  const msgs = (await mockPost('/__cw_messages', { conversation_id: w.conv })).body.messages
  const lastWithButtons = msgs.filter((x) => x.message_type === 1 && !x.private && x.items?.length).pop()
  const offered = lastWithButtons?.items?.includes(title)
  const r = await say(w, offered ? title : fallback, { model: !offered })
  return { ...r, tapped: offered ? title : null }
}

const SCENARIOS = {
  S1_new_prospect_choosing_a_plan: async () => { const w = await world('01', 8101); return [
    await say(w, 'Hi'),
    await say(w, 'I want a number to call my family in Dominica and sometimes my brother in Toronto'),
    await say(w, 'How much is the one that covers Canada?'),
    await say(w, "OK let's get me started"),
  ] },
  S2_installation_stuck: async () => { const w = await world('02', 8102); return [
    await say(w, 'I installed the app but nothing happened'),
    await say(w, 'How do I finish setting it up?'),
  ] },
  S3_connected_first_call: async () => { const w = await world('04', 8104); return [
    await say(w, 'Is my line ready?'),
    await say(w, 'How do I call my mom in Roseau?'),
  ] },
  S4_specific_failed_call: async () => { const w = await world('07', 8107); return [
    await say(w, "My call didn't go through"),
    await say(w, 'I called 448 2300 and it just beeped'),
    await tap(w, 'Check connection', 'Can you check my connection?'),
  ] },
  S5_active_account_balance: async () => { const w = await world('05', 8105); return [
    await say(w, 'How many minutes do I have left?'),
    await say(w, 'Can I call New York with that?'),
  ] },
  S6_purchase_intent: async () => { const w = await world('06', 8106); return [
    await say(w, "I'm running out of minutes, I want to buy the Plus plan"),
    await say(w, 'Can I pay by card here?'),
  ] },
  S8_long_conversation_past_pilot_turn_limit: async () => { const w = await world('05', 8108); return [
    await say(w, 'Hi'),
    await say(w, 'How many minutes do I have?'),
    await say(w, 'When does my plan end?'),
    await say(w, 'Can I call Toronto?'),
    await say(w, 'What would a month of calls to Canada cost?'),
    await say(w, 'OK and how do I call Roseau?'),
    await say(w, 'Thanks, that is all'),
  ] },
  S9_exhausted_trial: async () => { const w = await world('08', 8109); return [
    await say(w, "My calls aren't working anymore"),
    await say(w, 'How do I get more minutes?'),
  ] },
  S10_zero_wallet_vs_included_minutes: async () => { const w = await world('05', 8110); return [
    await say(w, 'Do I have any credit on my line?'),
  ] },
  S11_stop_start: async () => { const w = await world('05', 8111); return [
    await say(w, 'STOP', { model: false }),
    await say(w, 'START', { model: false }),
  ] },
  S12_interruption_before_confirmation: async () => { const w = await world('01', 8112); return [
    await say(w, 'I want a number'),
    await say(w, 'Wait - what does it cost after the trial ends?'),
    await say(w, 'OK thanks'),
  ] },
  S13_unregistered_device: async () => { const w = await world('03', 8113); return [
    await say(w, 'The app says registration failed'),
  ] },
  S14_expired_setup_link: async () => { const w = await world('02', 8114); return [
    await say(w, 'The setup link says it expired'),
  ] },
  S15_owner_case_calling_app: async () => { const w = await world('05', 8115); return [
    await say(w, 'How do I make a call?'),
    await tap(w, 'Call Dominica', 'Call Dominica'),
    await say(w, "I don't have the app on this phone"),
  ] },
  S7_human_handoff_and_handback: async () => { const w = await world('05', 8117); const out = []
    out.push(await say(w, 'I want to talk to a person'))
    out.push({ customer: '(staff takes over: status open)', replies: [], pl_calls: [] })
    await setStatus(w, 'open')
    out.push(await say(w, 'Hello? anyone there?', { model: false }))
    out.push({ customer: '(staff hands back: status pending)', replies: [], pl_calls: [] })
    await setStatus(w, 'pending')
    out.push(await say(w, "Thanks. What's my balance now?"))
    return out },
}

const pgm = createRequire('/app/package.json')('pg')
const db = new pgm.Pool({ connectionString: (rd(process.env.UPLINK_ENV_FILE || ENV_FILE).match(/^DATABASE_URL=(.+)$/m) || [])[1] })
const gate = async () => (await db.query(`SELECT spent_micro_usd, reserved_micro_usd, uncertain_micro_usd, budget_micro_usd FROM public_turn_spend_gates WHERE enabled = true ORDER BY id LIMIT 1`)).rows[0] ?? null
const g0 = await gate()
console.log(JSON.stringify({ label: LABEL, gate_before: g0 }))
for (const [name, run] of Object.entries(SCENARIOS)) {
  if (ONLY.length && !ONLY.includes(name)) continue
  try { console.log(JSON.stringify({ label: LABEL, scenario: name, turns: await run() })) }
  catch (e) { console.log(JSON.stringify({ label: LABEL, scenario: name, error: String(e?.message || e).slice(0, 200) })) }
}
const g1 = await gate()
console.log(JSON.stringify({ label: LABEL, gate_after: g1, model_turns: modelTurns, spent_this_run_usd: g0 && g1 ? (Number(g1.spent_micro_usd) - Number(g0.spent_micro_usd)) / 1e6 : null }))
await db.end()
