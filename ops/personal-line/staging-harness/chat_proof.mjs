// chat_proof.mjs - host03 STAGING only (plstg_net): ONE ordinary-chat model turn on a fresh synthetic conversation.
// signed Chatwoot webhook -> staging relay -> staging Uplink public turn (real model, staging dollar gate) -> MCP -> plstg_adapter -> plfix + mock Chatwoot.
// Prints JSON only (no secrets). Exactly one customer message is sent.
import crypto from 'node:crypto'
import fs from 'node:fs'

const RELAY = process.env.RELAY_URL || 'http://relay:3000'
const MOCK = process.env.MOCK_URL || 'http://mock-ext:9000'
const PLFIX = process.env.PLFIX_URL || 'http://plfix:3005'
const BOT_SECRET = fs.readFileSync(process.env.BOT_SECRET_FILE || '/run/secrets/bot_secret', 'utf8').trim()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const j = async (url, init = {}) => { const r = await fetch(url, init); let b = null; try { b = await r.json() } catch {} return { status: r.status, body: b } }
const mockPost = (path, body) => j(`${MOCK}${path}`, { method: 'POST', body: JSON.stringify(body || {}) })
function webhook(payload) {
  const raw = JSON.stringify(payload), ts = Math.floor(Date.now() / 1000)
  const sig = 'sha256=' + crypto.createHmac('sha256', BOT_SECRET).update(`${ts}.`).update(raw).digest('hex')
  return j(`${RELAY}/v1/chatwoot/agent-bot`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-chatwoot-timestamp': String(ts), 'x-chatwoot-signature': sig }, body: raw })
}
const OFF = Number(process.env.CONV_OFFSET || 0)
const wa = '17675550101', conv = 8301 + OFF, contact = 8301 + OFF + 1000
await mockPost('/__cw_seed', { contacts: [{ id: contact, name: 'Synthetic proof', phone_number: '+' + wa, contact_inboxes: [{ source_id: wa, inbox: { id: 11, channel_type: 'Channel::Whatsapp', provider: 'whatsapp_cloud' } }] }], conversations: [{ id: conv, inbox_id: 11, contactId: contact, status: 'pending', custom_attributes: {} }] })
const text = process.argv[2] || 'Hi, can I use this line to call my sister in Toronto?'
const m = (await mockPost('/__cw_incoming', { conversation_id: conv, content: text })).body
const callsBefore = (await j(`${PLFIX}/__calls`)).body.calls.length
const t0 = Date.now()
const hook = await webhook({ event: 'message_created', id: m.id, content: m.content, message_type: 'incoming', private: false, sender: { id: contact, name: 'Synthetic' }, account: { id: 2 }, inbox: { id: 11 }, conversation: { id: conv, status: 'pending', meta: { sender: { id: contact } } }, created_at: m.created_at })
let msgs = [], quietSince = 0, lastN = -1
for (let i = 0; i < 90; i++) {
  await sleep(1000)
  msgs = (await mockPost('/__cw_messages', { conversation_id: conv })).body.messages.filter((x) => x.id > m.id)
  const pub = msgs.filter((x) => x.message_type === 1 && !x.private)
  if (msgs.length !== lastN) { lastN = msgs.length; quietSince = i }
  if (pub.length && i - quietSince >= 4) break
}
const conversation = (await mockPost('/__cw_conversation', { conversation_id: conv })).body
console.log(JSON.stringify({
  conv, customer: text, webhook: hook.status, ms: Date.now() - t0,
  replies: msgs.filter((x) => x.message_type === 1).map((x) => ({ private: x.private, text: x.content, buttons: (x.items || []).map((b) => (typeof b === 'string' ? b : b?.title)) })),
  other: msgs.filter((x) => x.message_type !== 1).map((x) => ({ type: x.message_type, private: x.private, text: String(x.content || '').slice(0, 120) })),
  pl_calls: (await j(`${PLFIX}/__calls`)).body.calls.slice(callsBefore).map((c) => c.ep),
  conversation_status: conversation?.status ?? conversation?.conversation?.status ?? null,
}, null, 1))
