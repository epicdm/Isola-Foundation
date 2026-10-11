// pl-action-adapter.mjs - thin, authenticated MCP action adapter in front of the EXISTING PL concierge service (bff-v2 /api/internal/pl-concierge/v1).
// It is NOT a rules engine: offer/provision/status/link semantics, idempotency, trial and seat-bind stay in the service. This adds only what the service cannot know:
//   1. WHO is asking  - a signed relay context (com.epic.uplink/relay-context-v1) verified against fixed account/inbox/workspace/agent, then READ BACK from Chatwoot:
//                       the message must exist, be a customer (contact) incoming non-private WhatsApp message, hash-equal the signed digest, and the sender id comes from the
//                       contact's contact_inbox source_id for inbox 11 (digits only; anything else = not identifiable = refuse). Model arguments never carry identity.
//   2. WHAT was offered and CONFIRMED - a durable pending-offer row (own table) scoped to sender + chatwoot conversation + offer; confirmation is accepted ONLY from a LATER
//                       customer message whose Chatwoot-read content is exactly "1"; the row moves presented -> confirmed in one atomic UPDATE (single use).
//   3. FRESH ASSERTIONS - a distinct 22-char-nonce assertion is minted per actual service call; the PL key never leaves this process.
// Dependencies: node:crypto, node:http, pg (resolved via NODE_PATH from the bff image). Secrets only via *_FILE paths; nothing secret is logged or returned.
import crypto from 'node:crypto'
import http from 'node:http'
import https from 'node:https'
import fs from 'node:fs'
import { createRequire } from 'node:module'

export const META_KEY = 'com.epic.uplink/relay-context-v1'
const KEY_ID = /^[a-z0-9]{1,16}$/
const NONCE = /^[A-Za-z0-9_-]{22}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const WA_ID = /^[1-9][0-9]{6,15}$/
const b64u = (b) => Buffer.from(b).toString('base64url')
const sha256hex = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex')
const readSecret = (p) => fs.readFileSync(p, 'utf8').replace(/\r?\n$/, '')
const eq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y) }

export function loadConfig(env = process.env) {
  const need = (k) => { const v = env[k]; if (!v) throw new Error(`missing config ${k}`); return v }
  return {
    port: Number(env.PORT || 9100), debug: env.ADAPTER_DEBUG === '1',
    bearer: readSecret(need('ADAPTER_BEARER_FILE')),
    ctxKid: need('RELAY_CONTEXT_KEY_ID'), ctxKey: readSecret(need('RELAY_CONTEXT_KEY_FILE')),
    plBase: need('PL_BASE_URL').replace(/\/+$/, ''), plKid: need('PL_KID'), plKey: readSecret(need('PL_KEY_FILE')), plPnid: need('PL_PNID'),
    cwBase: need('CHATWOOT_BASE_URL').replace(/\/+$/, ''), cwAccount: Number(env.CHATWOOT_ACCOUNT_ID || 2), cwInbox: Number(env.CHATWOOT_INBOX_ID || 11),
    cwToken: readSecret(need('CHATWOOT_API_TOKEN_FILE')),
    workspaceId: need('EXPECTED_WORKSPACE_ID'), agentId: need('EXPECTED_AGENT_ID'), agentSlug: need('EXPECTED_AGENT_SLUG'),
    directOffer: env.STAGING_DIRECT_OFFER === '1',
    // The account tools (explain/balance/recent calls) are exposed to the model only when enabled: they go live together with the skill that uses them, after a paid eval.
    accountTools: env.PL_ACCOUNT_TOOLS === '1',
    // Onboarding through the native WhatsApp Flow (owner 2026-10-10). Default ON; PL_FLOW_ONBOARDING=0 restores the chat offer + '1' path.
    flowOnboarding: env.PL_FLOW_ONBOARDING !== '0',
    // rc13d (owner 2026-10-11: 'give the agent the facts and let it loose'): PL_DETERMINISTIC_TAPS=0 sends button taps to the AGENT as
    // ordinary messages (it answers with full context); only STOP/START stay deterministic. Default 1 keeps the rc12 behaviour.
    deterministicTaps: env.PL_DETERMINISTIC_TAPS !== '0',
    offerTtlS: Number(env.OFFER_TTL_S || 900), provisionPollMs: Number(env.PROVISION_POLL_MS || 13000), provisionAckMs: Number(env.PROVISION_ACK_MS || 2500), ctxSkewS: Number(env.CTX_SKEW_S || 60), timeoutMs: Number(env.UPSTREAM_TIMEOUT_MS || 15000),
    dbUrl: readSecret(need('DB_URL_FILE')),
    tlsKey: env.TLS_KEY_FILE ? fs.readFileSync(env.TLS_KEY_FILE) : null, tlsCert: env.TLS_CERT_FILE ? fs.readFileSync(env.TLS_CERT_FILE) : null,
    sourceCidrs: (env.ADAPTER_SOURCE_CIDRS || '').split(',').map((x) => x.trim()).filter(Boolean),
  }
}

// ── relay context (verifier side; the minter is the relay/Uplink route) ─────────────────────────────────────────────────────────────────────
export function verifyContext(token, cfg, nowMs = Date.now()) {
  if (typeof token !== 'string' || token.length > 8192) return { ok: false, why: 'no_context' }
  const parts = token.split('.')
  if (parts.length !== 3 || parts[0] !== 'v1' || !/^[A-Za-z0-9_-]+$/.test(parts[1]) || !/^[A-Za-z0-9_-]{43}$/.test(parts[2])) return { ok: false, why: 'malformed_context' }
  let claims
  try { const raw = Buffer.from(parts[1], 'base64url'); if (raw.toString('base64url') !== parts[1]) return { ok: false, why: 'malformed_context' }; claims = JSON.parse(raw.toString('utf8')) } catch { return { ok: false, why: 'malformed_context' } }
  if (!claims || typeof claims !== 'object' || claims.kid !== cfg.ctxKid) return { ok: false, why: 'unknown_context_key' }
  const mac = crypto.createHmac('sha256', Buffer.from(cfg.ctxKey, 'utf8')).update('v1.' + parts[1], 'utf8').digest('base64url')
  if (!eq(mac, parts[2])) return { ok: false, why: 'bad_context_signature' }
  if (!Number.isSafeInteger(claims.iat) || Math.abs(Math.floor(nowMs / 1000) - claims.iat) > cfg.ctxSkewS) return { ok: false, why: 'stale_context' }
  if (typeof claims.nonce !== 'string' || !NONCE.test(claims.nonce)) return { ok: false, why: 'bad_context_fields' }
  if (claims.accountId !== cfg.cwAccount || claims.inboxId !== cfg.cwInbox) return { ok: false, why: 'wrong_scope' }
  if (claims.workspaceId !== cfg.workspaceId || claims.agentId !== cfg.agentId || claims.agentSlug !== cfg.agentSlug) return { ok: false, why: 'wrong_agent' }
  if (!/^\d{1,20}$/.test(String(claims.chatwootConversationId)) || !/^\d{1,20}$/.test(String(claims.chatwootMessageId))) return { ok: false, why: 'bad_context_fields' }
  if (!/^[a-f0-9]{64}$/.test(String(claims.messageSha256))) return { ok: false, why: 'bad_context_fields' }
  return { ok: true, claims }
}

async function cwPost(cfg, path, body, f = fetch) {
  const r = await f(`${cfg.cwBase}/api/v1/accounts/${cfg.cwAccount}${path}`, { method: 'POST', headers: { api_access_token: cfg.cwToken, accept: 'application/json', 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(cfg.timeoutMs) })
  if (!r.ok) throw Object.assign(new Error(`chatwoot_${r.status}`), { code: `chatwoot_${r.status}` })
  return r.json()
}

// ── Chatwoot readback (provenance) ───────────────────────────────────────────────────────────────────────────────────────────────────────
async function cw(cfg, path, f = fetch) {
  const r = await f(`${cfg.cwBase}/api/v1/accounts/${cfg.cwAccount}${path}`, { headers: { api_access_token: cfg.cwToken, accept: 'application/json' }, signal: AbortSignal.timeout(cfg.timeoutMs) })
  if (!r.ok) throw Object.assign(new Error(`chatwoot_${r.status}`), { code: `chatwoot_${r.status}` })
  return r.json()
}
const isIncomingContactMsg = (m) => (m.message_type === 0 || m.message_type === 'incoming') && !m.private && String(m.sender_type ?? m.sender?.type ?? '').toLowerCase() === 'contact'

/** Resolve the VERIFIED sender and the exact customer message. Never trusts the webhook phone, the model, or the token alone. */
export async function resolveSender(cfg, claims, f = fetch) {
  const conv = await cw(cfg, `/conversations/${claims.chatwootConversationId}`, f)
  if (Number(conv.inbox_id) !== cfg.cwInbox) return { ok: false, why: 'wrong_inbox' }
  const contactId = conv.meta?.sender?.id ?? conv.contact_id
  if (!contactId) return { ok: false, why: 'no_contact' }
  const msgs = await cw(cfg, `/conversations/${claims.chatwootConversationId}/messages`, f)
  const list = Array.isArray(msgs?.payload) ? msgs.payload : []
  const msg = list.find((m) => String(m.id) === String(claims.chatwootMessageId))
  if (!msg) return { ok: false, why: 'message_not_found' }
  if (!isIncomingContactMsg(msg)) return { ok: false, why: 'message_not_from_customer' }
  const wamid = String(msg.source_id ?? '')
  if (!/^wamid\.[A-Za-z0-9+/=_-]{8,120}$/.test(wamid)) return { ok: false, why: 'no_whatsapp_message_id' }
  const content = String(msg.content ?? '')
  if (!eq(sha256hex(content), claims.messageSha256)) return { ok: false, why: 'message_digest_mismatch' }
  const contact = (await cw(cfg, `/contacts/${contactId}`, f))?.payload ?? null
  const ci = (contact?.contact_inboxes ?? []).filter((x) => Number(x?.inbox?.id ?? x?.inbox_id) === cfg.cwInbox)
  const all = [...new Set(ci.map((x) => String(x.source_id)))]
  if (all.length === 0) return { ok: false, why: 'sender_not_in_inbox' }
  // Real Chatwoot WhatsApp contacts carry TWO contact_inboxes in the SAME inbox (62/62 measured on inbox 7): the numeric phone id and a
  // prefixed id (US./DM./VI./GP./CN.). Only a numeric phone id is an identity: drop the rest BEFORE the uniqueness check. Two numeric
  // ids stay ambiguous, and no numeric id at all stays not-identifiable: fail closed, never guess.
  const ids = all.filter((s) => WA_ID.test(s))
  if (ids.length === 0) return { ok: false, why: 'sender_not_identifiable' }
  if (ids.length !== 1) return { ok: false, why: 'sender_ambiguous' }
  const waId = ids[0]
  const phoneDigits = String(contact.phone_number ?? '').replace(/\D/g, '')
  if (phoneDigits && phoneDigits !== waId) return { ok: false, why: 'sender_phone_mismatch' }
  return { ok: true, waId, wamid, content, createdAt: Number(msg.created_at) || null, conversationId: String(claims.chatwootConversationId), messageId: String(claims.chatwootMessageId), messages: list }
}

// ── PL concierge service client (fresh assertion per call) ──────────────────────────────────────────────────────────────────────────────────
export function mintAssertion(cfg, who, extra = {}) {
  const p = { kid: cfg.plKid, wa_id: who.waId, pnid: cfg.plPnid, rid: `cw-${who.conversationId}`, mid: who.wamid, iat: Math.floor(Date.now() / 1000), nonce: crypto.randomBytes(16).toString('base64url'), ...extra }
  const P = b64u(JSON.stringify(p))
  return { header: `v1.${P}.${b64u(crypto.createHmac('sha256', Buffer.from(cfg.plKey, 'utf8')).update('v1.' + P).digest())}`, rid: p.rid }
}
async function pl(cfg, stats, endpoint, who, body = {}, extra = {}, f = fetch) {
  const a = mintAssertion(cfg, who, extra)
  stats[endpoint] = (stats[endpoint] || 0) + 1
  const r = await f(`${cfg.plBase}/api/internal/pl-concierge/v1/${endpoint}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-isola-assertion': a.header, 'x-conversation-id': a.rid }, body: JSON.stringify(body), signal: AbortSignal.timeout(cfg.timeoutMs) })
  let j = null; try { j = await r.json() } catch {}
  return { http: r.status, code: j?.code ?? 'bad_response', status: j?.status, data: j?.data ?? {} }
}

// ── durable pending-offer store ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
export const DDL = `CREATE TABLE IF NOT EXISTS pl_adapter_offer (
  id bigserial PRIMARY KEY, wa_hash text NOT NULL, cw_conversation text NOT NULL, offer_key text NOT NULL, state text NOT NULL,
  presented_wamid text NOT NULL, confirm_wamid text, figures jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), confirmed_at timestamptz, outcome_code text);
 ALTER TABLE pl_adapter_offer ADD COLUMN IF NOT EXISTS offer_text text;
 ALTER TABLE pl_adapter_offer ADD COLUMN IF NOT EXISTS offer_msg_id text;
 CREATE TABLE IF NOT EXISTS pl_adapter_guidance (id bigserial PRIMARY KEY, cw_conversation text NOT NULL, wa_hash text NOT NULL, message_id text NOT NULL, event text NOT NULL, stage text, posted_msg_id text, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (cw_conversation, wa_hash, message_id, event));
 CREATE UNIQUE INDEX IF NOT EXISTS pl_adapter_offer_live ON pl_adapter_offer (cw_conversation, wa_hash, offer_key) WHERE state IN ('presented','confirmed');
 CREATE TABLE IF NOT EXISTS pl_adapter_preference (wa_hash text PRIMARY KEY, proactive_stopped boolean NOT NULL, source text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());`
const waHash = (cfg, waId) => crypto.createHmac('sha256', cfg.plKey).update('adapter|' + waId).digest('hex').slice(0, 32)

// ── source restriction (defence in depth on top of bearer + signed context) ─────────────────────────────────────────────────────────────────
function ip4(ip) { const m = String(ip).replace(/^::ffff:/i, '').match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/); return m ? ((+m[1] << 24) >>> 0) + (+m[2] << 16) + (+m[3] << 8) + +m[4] : null }
export function sourceAllowed(remote, cidrs) {
  if (!cidrs || cidrs.length === 0) return true            // not configured = no extra restriction (the bearer and signed context still apply)
  const a = ip4(remote); if (a === null) return false
  return cidrs.some((c) => { const [net, bits] = c.split('/'); const b = ip4(net); const n = Number(bits); if (b === null || !(n >= 8 && n <= 32)) return false; const mask = n === 32 ? 0xffffffff : (~((1 << (32 - n)) - 1)) >>> 0; return ((a & mask) >>> 0) === ((b & mask) >>> 0) })
}

// ── tools ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const SCHEMAS = {
  pl_offer: { description: 'Read the current Personal Line plan figures (free trial and paid plans) from the service. Read-only.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  pl_present_offer: { description: 'Start the FREE TRIAL line setup for this customer. Use it whenever the customer wants a number/line or to sign up. It checks whether they already have a line: if they do, it returns their number and status (and sends a setup form if their app is not connected yet); if not, it sends them the signup form in WhatsApp. Follow the note in the result exactly.', inputSchema: { type: 'object', properties: { offer_key: { type: 'string', enum: ['trial'] } }, required: ['offer_key'], additionalProperties: false } },
  pl_provision: { description: 'Set up the customer\'s line AFTER they replied 1 to the presented offer. Refuses unless that confirmation message exists. Idempotent per customer message.', inputSchema: { type: 'object', properties: { offer_key: { type: 'string', enum: ['trial'] } }, required: ['offer_key'], additionalProperties: false } },
  pl_explain: { description: 'Deliver the "How it works" explanation as its own message with a Get my number button. Use when the customer asks how it works, taps How it works, or asks what the service is. The text is written by the system; never write or paraphrase it yourself.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  pl_balance: { description: 'Deliver this customer\'s minutes balance (included minutes left and plan end date, plus wallet credit if any) as its own message with buttons. Use when they ask about minutes, balance, credit or how much is left, or tap Check my balance. The text is written by the system; never write numbers yourself.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  pl_recent_calls: { description: 'Deliver this customer\'s last few calls (direction, masked number, length, time) as its own message with buttons. Use when they ask about recent calls, call history, or tap Recent calls. The text is written by the system; never write call details yourself.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  pl_next_step: { description: 'Deliver the customer\'s NEXT onboarding step as its own message with tap-to-reply buttons: install the app, the one-time activation link (only after they say they installed it), the connection check, and the first-call step. Call it right after the line is created, when the customer taps one of its buttons, or when they ask how to start, whether it works, or for a link. The text is written by the system; never write or paraphrase it yourself.', inputSchema: { type: 'object', properties: { event: { type: 'string', enum: ['status', 'installed', 'resend'] } }, additionalProperties: false } },
  pl_status: { description: 'Read this customer\'s line status (number, plan, next step). Read-only.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  pl_journey: { description: 'Read this customer\'s verified situation: whether they have a line, setup progress, whether the app is connected right now, whether a call has ever gone through, included minutes, plan end, wallet credit, anything needing attention, plus the next-step buttons for their state. Nothing is sent - you write the reply from these facts and the buttons are attached to it. Call it at the start of a conversation, for greetings/help/"what can I do", and whenever you need their current state.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  pl_guide: { description: 'Read verified facts for one topic, for this customer: how_it_works (what the service is and how setup works), plans (the plan catalogue with prices, minutes and which calls each covers - use it to recommend a plan), calling (how to dial and what calls cost them, given their plan and credit), call_failed (a diagnosis from their live connection, minutes and credit - use it when a call did not go through), check_connection (is the app connected right now). Nothing is sent - you write the reply and the returned buttons are attached to it.', inputSchema: { type: 'object', properties: { topic: { type: 'string', enum: ['how_it_works', 'plans', 'calling', 'call_failed', 'check_connection'] } }, required: ['topic'], additionalProperties: false } },
  pl_setup_link: { description: 'Get a setup link for this customer\'s softphone or app sign-in.', inputSchema: { type: 'object', properties: { kind: { type: 'string', enum: ['softphone_activation', 'app_signin'] } }, required: ['kind'], additionalProperties: false } },
}
const ENVELOPE_DATA_TOOLS = new Set(['pl_provision', 'pl_status', 'pl_setup_link'])
const refuse = (code, extra = {}) => ({ ok: false, result: { code, ...extra } })
const done = (data) => ({ ok: true, result: data })


// ── Guidance wording (the UI layer: the PL service returns codes + data only) ───────────────────────────────────────────────
// Ported from the DEPLOYED BFF composers (bff-v2 d736dbf3a, app/lib/lite-post-provision.ts) so the ratified copy and its honesty rules carry over:
//   install step      composeDownloadStep :281-300        hand-off note   composeHandoffNote :78-83 (flag-off variant: no promise of a confirmation we cannot send)
//   activation link   composeActivationFollowUp :599-601  line-live note  sendFirstCallNote :466-472
// Deliberate adaptations (Chatwoot has no URL-button message): the link is in the text, "Tap Activate Softphone below" -> "Tap the link below", and the
// reply keyword "resend" -> the tap-button "Send a fresh link". A hand-off or a link click is NEVER described as "set up", "live" or "connected".
export const BTN = {
  start: { title: 'Get my number', value: 'greet_start' },
  balance: { title: 'Check my balance', value: 'check_balance' },
  calls: { title: 'Recent calls', value: 'recent_calls' },
  installed: { title: "I've installed it", value: 'installed_softphone' },
  fresh: { title: 'Send a fresh link', value: 'resend_link' },
  check: { title: 'Check my connection', value: 'check_connection' },
  human: { title: 'Talk to a person', value: 'esc_human' },
}
export function composeGuidance(code, data) {
  const f = data?.facts ?? {}, links = data?.store_links ?? {}
  const did = f.did_pretty ? ` ${f.did_pretty}` : ''
  if (code === 'activation_paused') return { stage: 'activation_paused', text: `App setup is paused for a short while — we're improving how calling credentials are delivered. If your app is already set up it keeps working. Tap *Talk to a person* and someone will set your device up with you.`, choices: [BTN.human] }
  if (code === 'link_rate_limited') return { stage: data?.stage ?? 'link_rate_limited', text: `You've asked for several setup links in a short time. Please use the most recent one I sent, or tap *Talk to a person* and someone will help.`, choices: [BTN.human] }
  const stage = data?.stage
  if (stage === 'install') {
    // The mandatory voice-only disclosure rides every NEW-line message (lite-concierge composeNoAppActivatedMsg; lite-offer-text VOICE_ONLY_DISCLOSURE). The PL service supplies it.
    const disc = data?.disclosure ? `\n\n${data.disclosure}` : ''
    if (data?.activation_available === false) return { stage, text: `App setup is paused for a short while — we're improving how calling credentials are delivered. If your app is already set up it keeps working. Tap *Talk to a person* and someone will set your device up with you.${disc}`, choices: [BTN.human] }
    return { stage, text: [
      f.inbound_enabled ? `📲 *One more step — install Cloud Softphone.* It's the free calling app your Isola number rings in.` : `📲 *One more step — install Cloud Softphone.* It's the free calling app you make calls from.`,
      ``, `• iPhone: ${links.ios}`, `• Android: ${links.android}`, ``,
      `When it's on your phone (or if you already have it), come back here and tap *I've installed it*. Please don't tap it before — the setup link only does its job once the app is installed.`,
    ].join('\n') + disc, choices: [BTN.installed, BTN.human] }
  }
  if (stage === 'link_ready') {
    const a = data?.activation ?? {}
    const mins = a.expires_in_min
    const step2 = a.chat_verified
      ? `*Tap the link below.* Cloud Softphone will open and your line goes in by itself — no code needed, you're already verified here in WhatsApp. The link works for ${mins} minutes, on the first phone that opens it — tap *Send a fresh link* if you need a new one.`
      : `*Tap the link below.* Cloud Softphone will open and your line goes in by itself. We may ask you for a 6-digit code here first, to confirm it's you. The link works for ${mins} minutes — tap *Send a fresh link* if you need a new one.`
    return { stage, text: `${step2}\n\n${a.url}`, choices: [BTN.fresh, BTN.human] }
  }
  if (stage === 'awaiting_registration') {
    const base = `📶 Your line has been handed to Cloud Softphone. Open Cloud Softphone and call any Dominica number (767) to test it`
    return { stage, text: `${base}${f.plan === 'trial' ? ' — calls to Dominica are included in your trial.' : '.'}\n\nThen tap *Check my connection* and I'll look.`, choices: [BTN.check, BTN.fresh, BTN.human] }
  }
  if (stage === 'registration_unknown') {
    return { stage, text: `📶 Your line has been handed to Cloud Softphone, but I can't see your phone's connection from here right now. Open Cloud Softphone and call any Dominica number (767) to test it. If it doesn't work, tap *Send a fresh link* or *Talk to a person*.`, choices: [BTN.check, BTN.fresh, BTN.human] }
  }
  if (stage === 'connected') {
    const text = f.inbound_enabled
      ? `✅ *Your line is live.* Your number${did} rings in Cloud Softphone now. Try it — call any Dominica number from the app; you have free minutes to start.${f.missed_call_alerts_enabled ? ' Missed calls come back here on WhatsApp.' : ''}`
      : `✅ *Cloud Softphone is connected.* You can make calls now — try it: call any Dominica number from the app. Incoming calls to your number${did} are not available yet — we'll message you here when they are.`
    return { stage, text, choices: [BTN.balance, BTN.calls, BTN.human] }
  }
  if (stage === 'first_call_done') return { stage, text: `🎉 Your first call went through — welcome to Isola!`, choices: [BTN.balance, BTN.calls, BTN.human] }
  return null
}

// ── The canonical offer (single line: the relay refuses a customer_message with a line break) ─────────────────────────────────
// The mandatory voice-only disclosure rides every NEW-line offer message (bff-v2 lite-offer-text VOICE_ONLY_DISCLOSURE). It is inside the SAME string that is stored as
// offer_text and later compared, whitespace-normalised and EXACTLY, with the delivered Chatwoot message, so the confirmation binding is unchanged.
export const VOICE_ONLY_DISCLOSURE = 'Voice calling service only. SMS and emergency calling are not supported.'
export function offerMessage(f) {
  return `Free trial: ${f.trial_days} days with ${f.trial_minutes} minutes of ${f.trial_pool === 'dominica' ? 'Dominica' : 'shared'} calls, EC$${f.trial_price_xcd}. ${VOICE_ONLY_DISCLOSURE} To set up your line now, reply 1.`
}
// The original confirm / explainer buttons (lite-concierge: confirm_yes "✅ Yes, set me up", confirm_no "Not now", greet_how "How it works"). INERT until the relay posts the offer
// with items: the adapter accepts a tapped title as confirmation ONLY if the DELIVERED offer message carried that exact item (see pl_provision); plain text never gains a second way to confirm.
export const OFFER_CHOICES = [
  { title: '✅ Yes, set me up', value: 'confirm_yes' },
  { title: 'How it works', value: 'greet_how' },
  { title: 'Not now', value: 'confirm_no' },
]
// Truthful acknowledgement (lite-concierge composeProvisioningMsg, without the first name which this layer does not hold).
export const PROVISIONING_ACK = 'Setting up your free Dominican line! Give me about 30 seconds... ⏳'
export const IOS_URL = 'https://apps.apple.com/us/app/cloud-softphone/id567475545'
export const ANDROID_URL = 'https://play.google.com/store/apps/details?id=cz.acrobits.softphone.cloudphone'
// "How it works" (lite-concierge howItWorksExplainerBody). Two ADAPTATIONS keep it truthful in this chat: the original also promised "just say call <number> here" and "top up ... in this chat",
// neither of which exists on this path.
export function composeExplainer(o) {
  return {
    stage: 'explainer',
    text: [
      `Here's how *Isola Lite* works:`,
      ``,
      `1️⃣ Tap *Get my number* — your free *+1 767* line is created instantly`,
      `2️⃣ Install *Cloud Softphone* (free) and tap *I've installed it* — I set the app up for you, no settings to type in`,
      `   • iPhone: ${IOS_URL}`,
      `   • Android: ${ANDROID_URL}`,
      `3️⃣ Your *${o.trial_days}-day free trial* starts: ${o.trial_minutes} minutes of calls to Dominica — call from the app`,
      `4️⃣ Anytime: check your balance and recent calls, or reach a real person — all in this chat`,
      ``,
      VOICE_ONLY_DISCLOSURE,
    ].join('\n'),
    choices: [BTN.start, BTN.human],
  }
}
// Balance (lite-concierge balance branch, same sentences). UNKNOWN is never a number and never "low". The original's top-up Flow / "Top up in this chat" is replaced by an honest handoff.
export const BALANCE_UNKNOWN_TEXT = "I can't read your minutes balance right now. Please try again in a little while, or reply *help* and a person will check it for you."
export function composeBalance(d, choices = [BTN.human]) {
  // Three SEPARATE facts from the identity-bound balance read: included minutes (the line's entitlement), plan end (its expiry) and wallet
  // credit (Magnus). Each is stated from its own field or as "couldn't be read" - never inferred from another, never hidden when zero.
  const UNREAD = "couldn't be read right now"
  const known = d && d.known === true
  const minutes = known && d.kind === 'included' && d.minutes_remaining != null && d.minutes_included != null
    ? `${d.minutes_remaining} of ${d.minutes_included} left`
    : known && d.kind === 'legacy' && d.minutes_remaining != null ? `${d.minutes_remaining} Dominica minutes left` : UNREAD
  const plan = known && d.kind === 'included' && d.expires_date_pretty ? `${d.plan_name ? d.plan_name + ' - ' : ''}ends ${d.expires_date_pretty}`
    : known && d.kind === 'legacy' ? 'no plan end date on this line' : UNREAD
  const wallet = d && typeof d.wallet_xcd === 'string' && d.wallet_xcd !== '' ? `EC$${d.wallet_xcd}` : UNREAD
  const low = known && d.low === true ? `\n\nYour included minutes are running low. Top-ups aren't available in this chat yet - tap *Talk to a person* and we'll help.` : ''
  // A low balance always keeps the person within one tap (the honest route while top-up is unavailable).
  const ch = low && !choices.some((c) => c.value === BTN.human.value) ? [...choices.slice(0, 2), BTN.human] : choices
  return { stage: known ? (d.low ? 'balance_low' : 'balance') : 'balance_unknown',
    text: `Your balance:\n• Included minutes: ${minutes}\n• Plan: ${plan}\n• Wallet credit: ${wallet}${low}`, choices: ch }
}
// Recent calls (new customer surface over the existing Magnus CDR read). Numbers arrive already masked; times are shown in Dominica time.
export function composeCalls(d, choices = [BTN.human]) {
  if (!d || d.known !== true) return { stage: 'calls_unknown', text: `I can't read your call history right now. Please try again in a little while, or tap *Talk to a person* and someone will check it for you.`, choices: [BTN.human] }
  if (!Array.isArray(d.calls) || d.calls.length === 0) return { stage: 'calls_none', text: `There are no calls on your line yet. Once you make one, it will show up here.`, choices }
  // started_at is a real UTC instant (the service converts Magnus's America/Jamaica wall-clock); a time it could not read is left out, never invented.
  const when = (iso) => { const t = iso ? new Date(iso) : null; return t && Number.isFinite(t.getTime()) ? ` · ${t.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/Dominica' })}` : '' }
  const dur = (s) => `${Math.floor(Number(s) / 60)}:${String(Number(s) % 60).padStart(2, '0')}`
  const lines = d.calls.map((c) => `${c.dir === 'in' ? '📥 In' : '📤 Out'} · ${c.number_masked} · ${dur(c.duration_s)}${when(c.started_at)}`)
  return { stage: 'calls', text: `Your last ${d.calls.length} ${d.calls.length === 1 ? 'call' : 'calls'}:\n\n${lines.join('\n')}`, choices }
}

// ── rc12: the journey (owner mission 2026-10-10) - state-aware wording + contextual actions ──────────────────────────────────────
// The STATE comes only from the PL service's /account/journey (one classifier, pl-concierge/journey.ts). This layer words it and
// maps each next action to a tap-button whose press runs a deterministic action (/v1/action, from the relay) - never a model turn.
// WhatsApp reply buttons: max 3, title max 20 chars; Chatwoot sends more than 3 items as a list. Every title below is <= 20.
export const ACT = {
  get_number: { title: 'Get my number', value: 'pl_get_number' },
  how_it_works: { title: 'How it works', value: 'pl_how' },
  plans: { title: 'Plans & prices', value: 'pl_plans' },
  continue_setup: { title: 'Continue setup', value: 'pl_setup' },
  check_connection: { title: 'Check connection', value: 'pl_check' },
  how_to_call: { title: 'How to make a call', value: 'pl_howcall' },
  troubleshoot: { title: 'Troubleshoot', value: 'pl_trouble' },
  balance: { title: 'Balance', value: 'pl_balance' },
  recent_calls: { title: 'Recent calls', value: 'pl_calls' },
  calling_help: { title: 'Calling help', value: 'pl_callhelp' },
  // rc13: Calling help is ONE question with three answers (PM 2026-10-10: separate first-use from a specific failed call).
  call_dominica: { title: 'Call Dominica', value: 'pl_call_dm' },
  call_uscan: { title: 'Call US/Canada', value: 'pl_call_us' },
  call_failed: { title: 'A call failed', value: 'pl_call_failed' },
  human: BTN.human,
}
// Only actions with a working handler can ever be offered. top_up is NOT here: the journey offers it only when the PL service reports
// payment.topup_available, and this adapter has no Fiserv top-up action yet - so it is dropped, never shown as a dead button.
export const IMPLEMENTED = new Set(Object.keys(ACT))
// Values a tap may carry -> action. The legacy rc9/rc10 button values still map, so an older message in the thread stays honest.
export const VALUE_TO_ACTION = {
  ...Object.fromEntries(Object.entries(ACT).filter(([k]) => k !== 'human').map(([k, v]) => [v.value, k])),
  check_balance: 'balance', recent_calls: 'recent_calls', check_connection: 'check_connection', greet_start: 'get_number',
  installed_softphone: 'continue_setup', resend_link: 'continue_setup', greet_how: 'how_it_works',
}
/** Buttons for a state: its actions minus the one just performed, a person always reachable, at most 3 (reply buttons, no list needed). */
export function choicesFor(actions, done = null) {
  const keys = (actions ?? []).filter((k) => IMPLEMENTED.has(k) && k !== done)
  if (!keys.includes('human') && (keys.length < 3 || done)) keys.push('human')
  const top = keys.slice(0, 3)
  if (!top.includes('human') && done) top[2] = 'human'
  return [...new Set(top)].map((k) => ACT[k])
}
const did = (f) => (f?.did_pretty ? ` ${f.did_pretty}` : '')
const ATTENTION_TEXT = {
  minutes_exhausted: () => `You've used all your included minutes.`,
  minutes_low: (f) => f?.minutes_remaining != null && f?.minutes_included != null ? `Your included minutes are running low (${f.minutes_remaining} of ${f.minutes_included} left).` : `Your included minutes are running low.`,
  plan_ended: () => `Your plan has ended.`,
  plan_ending: (f) => f?.expires_date_pretty ? `Your plan ends ${f.expires_date_pretty}.` : `Your plan ends soon.`,
}
export function composeJourney(j) {
  const f = j?.facts ?? {}
  const ch = choicesFor(j?.actions)
  const stage = `journey_${j?.state ?? 'unknown'}`
  switch (j?.state) {
    case 'no_line': return { stage, text: `Isola Personal Line gives you your own +1 767 number for calls, in the free Cloud Softphone app - with a free trial to start. What would you like to do?\n\n${VOICE_ONLY_DISCLOSURE}`, choices: ch }
    case 'setup_not_activated': return { stage, text: `Your line${did(f)} is ready. The next step is setting it up in the free Cloud Softphone app - tap *Continue setup* and I'll take you through it.`, choices: ch }
    case 'activated_not_registered': return { stage, text: j.registration_known === false
      ? `Your line${did(f)} has been handed to Cloud Softphone, but I can't see your phone's connection from here right now. Tap *Check connection* to look again.`
      : `Your line${did(f)} has been handed to Cloud Softphone, but your phone isn't connected right now. Open Cloud Softphone on this phone, then tap *Check connection*.`, choices: ch }
    case 'registered_no_call': return { stage, text: `📶 Your line${did(f)} is connected in Cloud Softphone. Next step: make your first call.`, choices: ch }
    case 'active': return { stage, text: `✅ Your line${did(f)} is working. What would you like to do?`, choices: ch }
    case 'attention': {
      const why = (j.attention ?? []).map((r) => ATTENTION_TEXT[r]?.(f)).filter(Boolean).join(' ')
      const pay = j.payment?.topup_available ? '' : ` Top-ups and plan purchases aren't available in this chat yet - tap *Talk to a person* and our team will help.`
      return { stage, text: `Your line${did(f)}: ${why}${pay}`, choices: ch }
    }
    default: return null
  }
}
const rates = (o) => `Dominica EC$${o.overage_dominica_xcd}/min, US/Canada EC$${o.overage_uscan_xcd}/min`
export function composePlans(o, hasLine) {
  const pool = (p) => (p.pool === 'shared' ? 'minutes for Dominica, US & Canada' : 'Dominica minutes')
  const lines = [`• Free trial - ${o.trial_days} days, ${o.trial_minutes} Dominica minutes, EC$${o.trial_price_xcd}`,
    ...(o.plans ?? []).map((p) => `• ${p.name} - ${p.days} days, ${p.minutes} ${pool(p)}, EC$${p.price_xcd}`)]
  const buy = hasLine ? `Buying a plan isn't available in this chat yet - tap *Talk to a person* and our team will help.` : `Paid plans can't be bought in this chat yet - start with the free trial.`
  return [`*Personal Line plans*`, ``, ...lines, ``, `After your included minutes, calls are charged from wallet credit: ${rates(o)}.`, ``, buy, ``, VOICE_ONLY_DISCLOSURE].join('\n')
}
export function composeExplainerRc12(o) {
  return [`Here's how *Isola Personal Line* works:`, ``,
    `1️⃣ Tap *Get my number* - a form opens here in WhatsApp and your +1 767 line is created when you confirm`,
    `2️⃣ The same form helps you install *Cloud Softphone* (free) and puts your line into it - no settings to type`,
    `3️⃣ Your *${o.trial_days}-day free trial* includes ${o.trial_minutes} minutes of calls to Dominica - call from the app`,
    `4️⃣ Any time: your balance, recent calls and calling help are a tap away in this chat, and a real person is one tap away too`,
    ``, VOICE_ONLY_DISCLOSURE].join('\n')
}
export function composeHowToCall(o, f) {
  return [`*How to make a call*`, ``,
    `1. Open *Cloud Softphone* on this phone.`,
    `2. Type the full number with its country code - for example +1 767 for Dominica, +1 for the US or Canada.`,
    `3. Tap the call button.`, ``,
    `Your included minutes cover the calls your plan includes (the free trial covers calls to Dominica). Other calls, and calls after your included minutes run out, are charged from wallet credit: ${rates(o)}.${f?.wallet_xcd != null ? ` Your wallet credit is EC$${f.wallet_xcd}.` : ''}`,
  ].join('\n')
}
/** Troubleshooting from a FRESH registration read; never claims a cause it did not read. */
export function composeTroubleshoot(st) {
  const reg = st?.registration
  const connected = ['registered', 'reachable', 'lagged'].includes(reg)
  if (connected) return { connected, text: [`Your phone is connected to your line right now, so calls should go through.`, ``, `If a call still fails:`,
    `• Dial the full number with its country code (+1 767 ... for Dominica).`,
    `• Calls outside your included minutes need wallet credit.`,
    `• Make sure Cloud Softphone has microphone permission.`].join('\n') }
  if (reg === 'unknown' || !reg) return { connected: false, text: [`I can't see your phone's connection from here right now.`, ``, `Meanwhile:`,
    `• Open Cloud Softphone on this phone and keep it open for a few seconds.`, `• Check that the phone has internet (Wi-Fi or data).`].join('\n') }
  if (st?.first_call_done === true) return { connected: false, text: [`Your app isn't connected at this moment - that's normal while Cloud Softphone is closed; it reconnects when you open it.`, ``,
    `If calls fail with the app open:`, `• Check that the phone has internet (Wi-Fi or data).`, `• Allow Cloud Softphone notifications and microphone access.`].join('\n') }
  return { connected: false, text: [`Your phone isn't connected to your line yet.`, ``,
    `• Open Cloud Softphone on this phone and keep it open for a few seconds.`,
    `• Check that the phone has internet (Wi-Fi or data) and that notifications are allowed.`,
    `• If you set it up on a different phone, or a setup link expired, tap *Continue setup* for a fresh link.`].join('\n') }
}
// rc13: calling guidance per destination, from the balance read (pool = which calls the plan includes; wallet = credit). An unread fact
// is said plainly, never assumed. Included minutes and wallet credit stay separate sentences.
export function composeCallGuide(dest, o, bal) {
  const known = bal?.known === true
  const left = known && bal.minutes_remaining != null ? ` (${bal.minutes_remaining} left)` : ''
  const wallet = typeof bal?.wallet_xcd === 'string' ? bal.wallet_xcd : null
  const walletLine = wallet !== null ? ` You have EC$${wallet} wallet credit.` : ` I couldn't read your wallet credit just now.`
  const dm = `Calls to Dominica use your included minutes${left}. After they run out, Dominica calls cost EC$${o.overage_dominica_xcd} a minute from wallet credit.`
  const usShared = `Your plan's included minutes cover calls to the US and Canada too${left}.`
  const usWallet = `Your current plan includes Dominica calls only, so calls to the US and Canada cost EC$${o.overage_uscan_xcd} a minute from wallet credit.`
  const noCredit = wallet === '0.00' ? ` With EC$0.00 credit those calls can't connect yet - adding credit isn't available in this chat yet, so tap *Talk to a person* and our team will help.` : walletLine
  if (dest === 'dominica') return [`*Calling Dominica*`, ``, `Open Cloud Softphone, dial +1 767 and the 7-digit number, then tap call.`, ``, dm + walletLine].join('\n')
  if (dest === 'uscan') {
    const cover = !known ? `I couldn't read which calls your plan includes just now - tap *Balance* to check, or ask me again shortly.` : bal.pool === 'shared' ? usShared : usWallet + noCredit
    return [`*Calling the US or Canada*`, ``, `Open Cloud Softphone, dial +1 and the 10-digit number, then tap call.`, ``, cover].join('\n')
  }
  return [`*Making a call*`, ``, `1. Open *Cloud Softphone* on this phone.`, `2. Dial the full number with its country code: +1 767 ... for Dominica, +1 ... for the US or Canada.`, `3. Tap call.`, ``, dm + walletLine].join('\n')
}
/** A failed call, diagnosed in order from FRESH facts: registration now -> credit/destination -> app/network -> a person. */
export function composeCallFailed(fx, bal) {
  const reg = fx?.registration
  const connected = ['registered', 'reachable', 'lagged'].includes(reg)
  if (!connected && (reg === 'unknown' || !reg)) return { connected, stage: 'call_failed_unknown', text: [`I can't see your phone's connection from here right now, so let's check the basics:`, `• Open Cloud Softphone on this phone and keep it open for a few seconds.`, `• Make sure the phone has internet (Wi-Fi or data).`, ``, `Then tap *Check connection*. If it still fails, tap *Talk to a person*.`].join('\n') }
  if (!connected) return { connected, stage: 'call_failed_not_connected', text: fx?.first_call_done === true
    ? [`Right now Cloud Softphone isn't connected to your line - that's why the call didn't go through.`, `• Open Cloud Softphone on this phone and wait a few seconds; it reconnects by itself.`, `• Make sure the phone has internet and that Cloud Softphone may use the microphone and send notifications.`, ``, `Then tap *Check connection*.`].join('\n')
    : [`Your phone isn't connected to your line yet, so calls can't go out.`, `• Open Cloud Softphone on this phone and keep it open for a few seconds.`, `• If you set it up on a different phone, or a setup link expired, tap *Continue setup* for a fresh link.`].join('\n') }
  const known = bal?.known === true
  const wallet = typeof bal?.wallet_xcd === 'string' ? bal.wallet_xcd : null
  if (known && bal.minutes_remaining != null && bal.minutes_remaining <= 0 && wallet === '0.00') return { connected, stage: 'call_failed_no_credit', text: `Your phone is connected, but you have no included minutes left and EC$0.00 wallet credit - so calls can't connect right now. Adding credit isn't available in this chat yet; tap *Talk to a person* and our team will sort it out with you.` }
  const facts = [known && bal.minutes_remaining != null ? `${bal.minutes_remaining} included minutes left` : null, wallet !== null ? `EC$${wallet} wallet credit` : null].filter(Boolean).join(' and ')
  return { connected, stage: 'call_failed_connected', text: [
    `Your phone is connected to your line right now${facts ? ` and you have ${facts}` : ''}, so the line itself is working. The usual causes then are:`,
    `• The number format - dial the country code: +1 767 ... for Dominica, +1 ... for the US or Canada.`,
    known && bal.pool !== 'shared' ? `• Calls to the US or Canada aren't included in your plan and need wallet credit.` : null,
    `• Cloud Softphone needs permission to use the microphone.`,
    ``, `If it still fails, tap *Talk to a person* and tell us the number you called and what you heard - we'll pick it up from there.`].filter((x) => x !== null).join('\n') }
}
// ── rc13: verified facts for the native agent (it writes the reply; the relay attaches `choices`) ─────────────────────────────────
export const GUIDE_TOPICS = ['how_it_works', 'plans', 'calling', 'call_failed', 'check_connection', 'how_to_call', 'calling_help', 'troubleshoot']
// Uplink's critical price validator accepts only catalogue amounts after a `$` and reads EC$0.135 as 0.13, so customer-specific money
// (wallet credit) and the 3-decimal Dominica rate are handed over WITHOUT a `$`; catalogue prices keep EC$ (they are in pricingFacts).
export const FACTS_NOTE = 'Verified facts for THIS customer. Write ONE short, natural reply in your own words from them - answer what they asked, recommend when useful, ask at most one question. Never invent or round a number. Write catalogue prices exactly as given (EC$...); write wallet credit and the Dominica rate exactly as given (no $ sign). The buttons in `choices` are attached to your reply automatically - you may point to them, never list them as text.'
// rc13d: the calling app, so the agent can always tell a customer where their line lives and how to get it.
export const APP_FACTS = { name: 'Cloud Softphone', maker: 'Acrobits', where_the_line_lives: 'calls are made from this app on the customer phone (incoming calls to the number are NOT available yet - never say the number rings or that they can receive calls); the setup form puts the line into it with a one-tap link',
  ios_app_store: IOS_URL, android_google_play: ANDROID_URL }
export const titlesOf = (choices) => (choices ?? []).map((c) => ({ title: c.title, value: c.value }))
const ecWords = (xcd) => (typeof xcd === 'string' && xcd !== '' ? `${xcd} EC dollars` : null)
export function modelFacts(j) {
  const f = j?.facts ?? {}
  return {
    // rc13b: MASKED - Uplink's critical no_pii_leak validator trusts a full number only from pl_provision/pl_status results in the same
    // turn; a full DID from this facts tool made a correct reply fail and hand off (staging S2, 2026-10-11 01:43Z).
    line: f.did_masked ?? null, journey_state: j?.state ?? null,
    registration_now: f.registration ?? 'unknown', ever_completed_a_call: f.first_call_done ?? null,
    included_minutes_left: f.balance_known ? f.minutes_remaining ?? null : null, included_minutes_total: f.balance_known ? f.minutes_included ?? null : null,
    plan: f.plan_name ?? f.plan ?? null, plan_ends: f.expires_date_pretty ?? null,
    wallet_credit: ecWords(f.wallet_xcd) ?? 'could not be read', minutes_running_low: f.low === true, attention: j?.attention ?? [],
    app: APP_FACTS,
  }
}
export function catalogueFacts(o) {
  const covers = (p) => (p.pool === 'shared' ? 'Dominica, US and Canada' : 'Dominica only')
  return {
    free_trial: { price: `EC$${Number(o.trial_price_xcd)}`, days: o.trial_days, included_minutes: o.trial_minutes, covers: 'Dominica only' },
    plans: (o.plans ?? []).map((p) => ({ name: p.name, price: `EC$${Number(p.price_xcd)}`, days: p.days, included_minutes: p.minutes, covers: covers(p) })),
    after_included_minutes: { dominica: '13.5 EC cents a minute', us_canada: `EC$${o.overage_uscan_xcd} a minute`, paid_from: 'wallet credit' },
    voice_only: VOICE_ONLY_DISCLOSURE,
  }
}
/** What a completed onboarding Flow means, from the VERIFIED journey state - never from the Flow's own reported status. */
export function composeFlowDone(j) {
  const f = j?.facts ?? {}
  const ch = choicesFor(j?.actions)
  switch (j?.state) {
    case 'active': return { stage: 'flow_done_active', text: `✅ All set - your line${did(f)} is working. Here's what you can do any time:`, choices: ch }
    case 'attention': return { ...composeJourney(j), stage: 'flow_done_attention' }
    case 'registered_no_call': return { stage: 'flow_done_registered', text: `📶 Your phone is connected to your line${did(f)}. Next step: make your first call.`, choices: ch }
    case 'activated_not_registered': return { stage: 'flow_done_not_registered', text: `Your line${did(f)} has been handed to Cloud Softphone, but your phone isn't connected yet - so setup isn't finished. Open Cloud Softphone on this phone, then tap *Check connection*.`, choices: ch }
    case 'setup_not_activated': return { stage: 'flow_done_not_activated', text: `Your line${did(f)} is created, but it isn't set up in Cloud Softphone yet. Tap *Continue setup* whenever you're ready.`, choices: ch }
    case 'no_line': return { stage: 'flow_done_no_line', text: `Your line wasn't set up. You can start again any time.`, choices: ch }
    default: return null
  }
}
export const STOP_TEXT = `Done - you won't get any more automatic updates from us. You can still message here any time, and tap *Talk to a person* whenever you need us. Send START to turn updates back on.`
export const START_TEXT = `Updates are back on - we'll message you here about your line's setup and calls.`
/** Proactive follow-ups, worded from the CURRENT journey (the verdict only says why we are speaking). */
export function composeProactive(key, j) {
  const f = j?.facts ?? {}
  const ch = choicesFor(j?.actions)
  const st = j?.state
  if (key === 'activated' || key === 'first_call') {
    if (st === 'active' || st === 'attention') return { stage: 'proactive_first_call', covered: ['activated', 'first_call'], text: `🎉 Your first call went through - your line${did(f)} is working. Your balance, recent calls and calling help are one tap away here.`, choices: ch }
    if (key === 'activated' && st === 'registered_no_call') return { stage: 'proactive_registered', covered: ['activated'], text: `📶 Your phone is now connected to your line${did(f)}. Next step: make your first call from Cloud Softphone.`, choices: ch }
    return null
  }
  if (key === 'stalled:handoff_no_register' && st === 'activated_not_registered') return { stage: 'proactive_stalled', text: `Your line${did(f)} was handed to Cloud Softphone, but your phone hasn't connected yet. Open Cloud Softphone on this phone, then tap *Check connection* - or *Continue setup* for a fresh link.`, choices: ch }
  if ((key === 'stalled:link_not_opened' || key === 'stalled:no_handoff') && st === 'setup_not_activated') return { stage: 'proactive_link_expired', text: `Your setup link expired before your line went into Cloud Softphone. Tap *Continue setup* for a fresh one.`, choices: ch }
  return null
}

export function makeHandlers(cfg, db, stats, f = fetch) {
  // One customer message + one event = ONE delivered message (the model can call a tool twice in a turn). Never claims a message that was not posted.
  async function deliverOwn(who, event, build) {
    const h = waHash(cfg, who.waId)
    const claim = await db.query(`INSERT INTO pl_adapter_guidance (cw_conversation, wa_hash, message_id, event) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING id`, [who.conversationId, h, who.messageId, event])
    if (claim.rowCount !== 1) {
      const prior = (await db.query(`SELECT stage FROM pl_adapter_guidance WHERE cw_conversation=$1 AND wa_hash=$2 AND message_id=$3 AND event=$4`, [who.conversationId, h, who.messageId, event])).rows[0]
      return done({ code: 'message_sent', stage: prior?.stage ?? null, already: true, note: 'This was ALREADY delivered to the customer as its own message. Reply with ONE short friendly sentence only; add nothing else.' })
    }
    const release = () => db.query(`DELETE FROM pl_adapter_guidance WHERE id=$1`, [claim.rows[0].id]).catch(() => {})
    let built
    try { built = await build() } catch { await release(); return refuse('service_unavailable') }
    if (built.refusal) { await release(); return built.refusal }
    const g = built.g
    if (!g) { await release(); return refuse('nothing_to_say') }
    // rc12: a person may hold the conversation by now - post only while it is still the AI's (Chatwoot status pending).
    if (!(await aiOwned(who.conversationId))) { await release(); return refuse('conversation_not_ai_owned') }
    const posted = await cwPost(cfg, `/conversations/${who.conversationId}/messages`, {
      content: g.text, message_type: 'outgoing', private: false, content_type: 'input_select',
      content_attributes: { items: g.choices.map((c) => ({ title: c.title, value: c.value })) },
    }, f).catch(() => null)
    if (!posted?.id) { await release(); return refuse('message_send_failed') }
    await db.query(`UPDATE pl_adapter_guidance SET stage=$2, posted_msg_id=$3 WHERE id=$1`, [claim.rows[0].id, g.stage, String(posted.id)])
    return done({ code: 'message_sent', stage: g.stage, ...(built.extra ?? {}), note: 'The answer (with tap buttons) has ALREADY been delivered to the customer as its own message. Do NOT repeat, restate, summarise or paraphrase it, or add numbers, links or claims. Reply with ONE short friendly sentence only.' })
  }
  async function aiOwned(conversationId) {
    try { const c = await cw(cfg, `/conversations/${conversationId}`, f); return c?.status === 'pending' } catch { return false }
  }
  async function journeyRead(who) {
    const r = await pl(cfg, stats, 'account/journey', who, {}, {}, f)
    return r.code === 'journey' ? { ok: true, j: r.data } : { ok: false, code: r.code === 'bad_response' ? 'service_unavailable' : r.code }
  }
  async function offerRead(who) {
    const o = await pl(cfg, stats, 'offer', who, {}, {}, f)
    return o.code === 'offer' ? o.data : null
  }
  const NEEDS_LINE = new Set(['balance', 'recent_calls', 'check_connection', 'troubleshoot', 'how_to_call', 'calling_help', 'call_dominica', 'call_uscan', 'call_failed'])
  const SETUP_DONE = new Set(['registered_no_call', 'active', 'attention'])
  /** One deterministic action for the verified sender, chosen and worded from the CURRENT journey. Never a model turn. */
  async function runAction(who, action) {
    const jr = await journeyRead(who)
    if (!jr.ok) return refuse(jr.code)
    const j = jr.j, fx = j.facts ?? {}
    const say = (g) => deliverOwn(who, `act:${action}`, async () => (g ? { g } : { refusal: refuse('nothing_to_say') }))
    // Someone without a line who taps an account action gets the no-line menu, never an account error.
    if (!j.has_line && NEEDS_LINE.has(action)) return say(composeJourney(j))
    switch (action) {
      case 'get_number': case 'continue_setup': {
        // Never restart a finished setup: show the customer where they are instead.
        if (SETUP_DONE.has(j.state)) return say(composeJourney(j))
        const fl = await pl(cfg, stats, 'flows/launch', who, { flow: 'signup' }, {}, f).catch(() => null)
        if (fl?.code === 'flow_sent') return done({ code: 'setup_flow_sent', state: j.state, existing_line: j.has_line === true })
        if (fl?.code === 'rate_limited') return say({ stage: 'flow_recently_sent', text: `I sent you the setup form a little while ago - open the most recent one in this chat (${j.has_line ? '"Manage your line"' : '"Get your free number"'}) and tap its button.`, choices: [BTN.human] })
        return refuse(fl?.code && fl.code !== 'bad_response' ? fl.code : 'service_unavailable')
      }
      case 'how_it_works': {
        const o = await offerRead(who); if (!o) return refuse('offer_unavailable')
        return say({ stage: 'how_it_works', text: composeExplainerRc12(o), choices: j.has_line ? choicesFor(j.actions) : choicesFor(['get_number', 'plans', 'human']) })
      }
      case 'plans': {
        const o = await offerRead(who); if (!o) return refuse('offer_unavailable')
        return say({ stage: 'plans', text: composePlans(o, j.has_line === true), choices: choicesFor(j.has_line ? j.actions : ['get_number', 'how_it_works', 'human'], 'plans') })
      }
      case 'check_connection': {
        const connected = ['registered', 'reachable', 'lagged'].includes(fx.registration)
        // rc13: a check never sends the customer back into a tutorial; connected -> the state's own next steps (minus this check).
        if (connected) return say({ stage: 'check_connected', text: `✅ Your phone is connected to your line right now.${fx.first_call_done === true ? '' : ' Next step: make your first call.'}`, choices: choicesFor(j.state === 'registered_no_call' ? ['how_to_call', 'human'] : j.actions, 'check_connection') })
        const t = composeTroubleshoot(fx)
        return say({ stage: 'check_not_connected', text: t.text, choices: fx.first_call_done === true ? choicesFor(['check_connection', 'human']) : choicesFor(['check_connection', 'continue_setup', 'human']) })
      }
      case 'calling_help':
        // rc13: ONE question, three answers - never a tutorial wall, never a loop.
        return say({ stage: 'calling_help_menu', text: `Happy to help with calling. What do you need?`, choices: [ACT.call_dominica, ACT.call_uscan, ACT.call_failed] })
      case 'how_to_call': case 'call_dominica': case 'call_uscan': {
        const o = await offerRead(who); if (!o) return refuse('offer_unavailable')
        const b = await pl(cfg, stats, 'account/balance', who, {}, {}, f).catch(() => null)
        const bal = b?.code === 'balance' ? b.data : null
        const dest = action === 'call_uscan' ? 'uscan' : action === 'call_dominica' ? 'dominica' : 'first'
        return say({ stage: `howcall_${dest}`, text: composeCallGuide(dest, o, bal), choices: choicesFor(['call_failed', 'balance', 'human']) })
      }
      case 'troubleshoot': case 'call_failed': {
        // rc13: diagnosis from FRESH facts, in the PM's order: registration now -> destination/credit -> app/network -> a person.
        const b = await pl(cfg, stats, 'account/balance', who, {}, {}, f).catch(() => null)
        const bal = b?.code === 'balance' ? b.data : null
        const d = composeCallFailed(fx, bal)
        return say({ stage: d.stage, text: d.text, choices: d.connected ? choicesFor(['check_connection', 'human']) : fx.first_call_done === true ? choicesFor(['check_connection', 'human']) : choicesFor(['check_connection', 'continue_setup', 'human']) })
      }
      case 'balance': {
        const r = await pl(cfg, stats, 'account/balance', who, {}, {}, f)
        if (r.code !== 'balance') return refuse(r.code === 'bad_response' ? 'service_unavailable' : r.code)
        return say(composeBalance(r.data, choicesFor(j.actions, 'balance')))
      }
      case 'recent_calls': {
        const r = await pl(cfg, stats, 'account/recent-calls', who, {}, {}, f)
        if (r.code !== 'recent_calls') return refuse(r.code === 'bad_response' ? 'service_unavailable' : r.code)
        return say(composeCalls(r.data, choicesFor(j.actions, 'recent_calls')))
      }
      case 'flow_done': return deliverOwn(who, 'flow_done', async () => { const g = composeFlowDone(j); return g ? { g, extra: { state: j.state } } : { refusal: refuse('nothing_to_say') } })
      default: return refuse('unknown_action')
    }
  }
  async function setPreference(who, stopped) {
    await db.query(`INSERT INTO pl_adapter_preference (wa_hash, proactive_stopped, source, updated_at) VALUES ($1,$2,$3,now())
      ON CONFLICT (wa_hash) DO UPDATE SET proactive_stopped=EXCLUDED.proactive_stopped, source=EXCLUDED.source, updated_at=now()`, [waHash(cfg, who.waId), stopped, stopped ? 'stop_keyword' : 'start_keyword'])
    return deliverOwn(who, stopped ? 'stop' : 'start', async () => ({ g: { stage: stopped ? 'proactive_stopped' : 'proactive_started', text: stopped ? STOP_TEXT : START_TEXT, choices: [BTN.human] } }))
  }
  const ok = (c) => c === 'offer' || c === 'line_status' || c === 'line_created' || c === 'line_exists' || c === 'link_minted' || c === 'no_account' || c === 'provisioning'
  return {
    async pl_offer(who) {
      const r = await pl(cfg, stats, 'offer', who, {}, {}, f)
      return r.code === 'offer' ? done({ code: 'offer', ...pick(r.data, ['trial_days', 'trial_minutes', 'trial_pool', 'trial_price_xcd', 'plans', 'overage_dominica_xcd', 'overage_uscan_xcd', 'voice_only']) }) : refuse(r.code)
    },
    async pl_present_offer(who, args) {
      if (args.offer_key !== 'trial') return refuse('offer_key_invalid')
      const st = await pl(cfg, stats, 'account/line-status', who, {}, {}, f)
      if (st.code === 'line_status') {
        // The customer ALREADY holds a line: a verified, successful outcome (never a failed offer). Return their number and status; if the
        // app is not connected yet, continue their setup in the native onboarding WhatsApp Flow (it greets them with their own number and
        // creates nothing). The relay accepts code line_exists + offer_key trial as a verified non-offer outcome.
        const d = st.data ?? {}
        const connected = ['registered', 'reachable', 'lagged'].includes(d.registration) || d.first_call_done === true
        let setupFlowSent = false
        if (cfg.flowOnboarding) {   // connected or not: the Flow shows their number and live status, and continues setup if needed - it creates nothing
          const fl = await pl(cfg, stats, 'flows/launch', who, { flow: 'signup' }, {}, f).catch(() => null)
          setupFlowSent = fl?.code === 'flow_sent'
        }
        return done({ code: 'line_exists', offer_key: 'trial', ...pick(d, ['did_pretty', 'did_masked', 'registration', 'softphone_activated', 'first_call_done', 'plan', 'plan_expires_at']), connected, setup_flow_sent: setupFlowSent,
          note: connected && setupFlowSent
            ? 'This customer ALREADY HAS this Isola line and it is working. Tell them their number (did_pretty) and that their line is active; a form showing their line and status has ALREADY been sent as its own WhatsApp message (its button is "Manage my line"). Do NOT offer a trial, a new number, or ask them to reply 1.'
            : connected
            ? 'This customer ALREADY HAS this Isola line and it is working. Tell them their number (did_pretty) and that their line is active. Do NOT offer a trial, a new number, or ask them to reply 1.'
            : setupFlowSent
              ? 'This customer ALREADY HAS this Isola line (did_pretty). A setup form has ALREADY been sent to them as its own WhatsApp message to finish setting up the app. Tell them to open that form (its button is "Manage my line"). Do NOT offer a trial or ask them to reply 1.'
              : 'This customer ALREADY HAS this Isola line (did_pretty) but the app is not connected yet. Tell them their number and offer to send the setup steps. Do NOT offer a trial or ask them to reply 1.' })
      }
      if (st.code === 'no_account' && cfg.flowOnboarding) {
        // New customer: the whole onboarding happens in the native WhatsApp Flow (offer, confirmation, line, app setup). The confirmation
        // and identity checks live in the Flow endpoint. If the Flow cannot be sent, fall back to the existing chat offer below.
        const fl = await pl(cfg, stats, 'flows/launch', who, { flow: 'signup' }, {}, f).catch(() => null)
        if (fl?.code === 'flow_sent') return done({ code: 'setup_flow_sent', offer_key: 'trial',
          note: 'A signup form has ALREADY been sent to the customer as its own WhatsApp message. Tell them to open it (its button is "Start signup") - it shows the free trial terms and sets up their line. Do NOT repeat any offer terms, prices or minutes, and do NOT ask them to reply 1.' })
      }
      const o = await pl(cfg, stats, 'offer', who, {}, {}, f)
      if (o.code !== 'offer') return refuse(o.code)
      const figures = pick(o.data, ['trial_days', 'trial_minutes', 'trial_pool', 'trial_price_xcd'])
      const h = waHash(cfg, who.waId)
      await db.query(`UPDATE pl_adapter_offer SET state='expired' WHERE cw_conversation=$1 AND wa_hash=$2 AND offer_key='trial' AND state='presented'`, [who.conversationId, h])
      const customerMessage = offerMessage(figures)
      await db.query(`INSERT INTO pl_adapter_offer (wa_hash, cw_conversation, offer_key, state, presented_wamid, figures, offer_text) VALUES ($1,$2,'trial','presented',$3,$4,$5) ON CONFLICT DO NOTHING`, [h, who.conversationId, who.wamid, { ...figures, choices: OFFER_CHOICES }, customerMessage])
      if (cfg.directOffer) {
        // LANE A STAGING-ONLY (plan v2.9/3.0 interim until Codex's relay renders the offer): send the canonical offer DETERMINISTICALLY as its own message, rendered from the durable
        // offered terms, never by the model. The conversational reply is separate and cannot authorise confirmation (exact-equality delivery readback still decides).
        const posted = await cwPost(cfg, `/conversations/${who.conversationId}/messages`, { content: customerMessage, message_type: 'outgoing', private: false }, f).catch(() => null)
        if (!posted?.id) return refuse('offer_send_failed')
        await db.query(`UPDATE pl_adapter_offer SET offer_msg_id=$3 WHERE wa_hash=$1 AND cw_conversation=$2 AND offer_key='trial' AND state='presented'`, [h, who.conversationId, String(posted.id)])
        return done({ code: 'offer_sent', offer_key: 'trial', confirm_with: '1', expires_in_min: Math.round(cfg.offerTtlS / 60),
          note: 'The exact offer terms have ALREADY been delivered to the customer as their own separate message. Do NOT repeat, restate, summarise or paraphrase any figure, price, day or minute count. Reply with ONE short friendly sentence only, telling them to reply 1 if they want it.' })
      }
      return done({ code: 'offer_issued', offer_key: 'trial', ...figures, confirm_with: '1', expires_in_min: Math.round(cfg.offerTtlS / 60), customer_message: customerMessage, choices: OFFER_CHOICES,
        note: 'Send customer_message to the customer VERBATIM. The offer only counts once that exact text has been delivered in the conversation; a paraphrase does not.' })
    },
    async pl_provision(who, args) {
      if (args.offer_key !== 'trial') return refuse('offer_key_invalid')
      const h = waHash(cfg, who.waId)
      // The confirmation must be the customer's OWN later message, read back from Chatwoot, and exactly "1".
      const { rows } = await db.query(`SELECT id, state, presented_wamid, confirm_wamid, offer_text, offer_msg_id, figures, extract(epoch from (now()-created_at)) AS age, extract(epoch from created_at) AS created_epoch FROM pl_adapter_offer WHERE cw_conversation=$1 AND wa_hash=$2 AND offer_key='trial' AND state IN ('presented','confirmed') ORDER BY id DESC LIMIT 1`, [who.conversationId, h])
      const row = rows[0]
      if (!row) return refuse('offer_not_presented')
      if (row.state === 'confirmed' && row.confirm_wamid === who.wamid) { /* same customer message re-presented: fall through to the service (idempotent per message) */ }
      else {
        if (row.state !== 'presented') return refuse('offer_already_used')
        if (Number(row.age) > cfg.offerTtlS) { await db.query(`UPDATE pl_adapter_offer SET state='expired' WHERE id=$1 AND state='presented'`, [row.id]); return refuse('offer_expired') }
        if (row.presented_wamid === who.wamid) return refuse('confirmation_must_be_a_later_message')
        const norm = (t) => String(t ?? '').replace(/\s+/g, ' ').trim()
        // Two ways to confirm, both bound to the DELIVERED offer: the typed digit 1, or a tapped button whose exact title was an item of the delivered offer message (checked below).
        const yesChoice = (row.figures?.choices ?? []).find((c) => c.value === 'confirm_yes')
        const typedOne = /^1\.?$/.test(who.content.trim())
        const tappedYes = !!yesChoice && norm(who.content) === norm(yesChoice.title)
        if (!typedOne && !tappedYes) return refuse('confirmation_not_given')
        // DELIVERY READBACK: the canonical wording must actually exist in the conversation as an OUTGOING, non-private, non-failed message,
        // posted after the offer was issued and BEFORE this confirming customer message, and EXACTLY equal (whitespace-normalised) to the canonical text. A tool result, a paraphrase or the canonical text wrapped in other prose is not delivery.
        const confirmId = Number(who.messageId)
        const delivered = (who.messages || []).filter((m) => (m.message_type === 1 || m.message_type === 'outgoing') && !m.private && String(m.status ?? '') !== 'failed'
          && Number(m.id) < confirmId && Number(m.created_at) + 5 >= Number(row.created_epoch) && norm(m.content) === norm(row.offer_text))   // EXACT equality (PM decision v2.9): appended/prepended prose is not delivery evidence
        if (delivered.length === 0) return refuse('offer_not_delivered')
        // A tapped title confirms only if the delivered offer message ITSELF carried that exact confirm item - never because the words happen to match what the customer typed.
        if (!typedOne && !delivered.some((m) => (m.content_attributes?.items ?? []).some((i) => i.value === 'confirm_yes' && norm(i.title) === norm(yesChoice.title)))) return refuse('confirmation_not_offered')
        const offerMsg = delivered.sort((a, b) => Number(b.id) - Number(a.id))[0]
        const up = await db.query(`UPDATE pl_adapter_offer SET state='confirmed', confirm_wamid=$2, confirmed_at=now(), offer_msg_id=$3 WHERE id=$1 AND state='presented' RETURNING id`, [row.id, who.wamid, String(offerMsg.id)])
        if (up.rowCount !== 1) return refuse('offer_already_used')                                   // lost a race: single use
      }
      // The service stops waiting after ~9 s and answers 'provisioning' while real Magnus work (~12 s) finishes. The MODEL must never be left to decide whether to retry
      // (measured 2026-10-10: two parallel provision calls both got 'provisioning', the model gave up and the relay handed off a line that was in fact created).
      // Re-ask the SAME (idempotent per customer message) provision inside the tool call, bounded to stay under the Uplink MCP client timeout (20 s).
      // TRUTHFUL ACKNOWLEDGEMENT: posted only if the attempt is STILL running after cfg.provisionAckMs (a line that already exists answers instantly and gets none), at most ONCE per
      // customer message, and never again while an earlier attempt for this customer in this conversation is inside the 15-minute window (an unresolved/fenced attempt re-asked by "1").
      let finished = false
      const ackTimer = setTimeout(async () => {
        try {
          if (finished) return
          const recent = await db.query(`SELECT 1 FROM pl_adapter_guidance WHERE cw_conversation=$1 AND wa_hash=$2 AND event='provision_ack' AND created_at > now() - interval '15 minutes' LIMIT 1`, [who.conversationId, h])
          if (recent.rowCount) return
          const claim = await db.query(`INSERT INTO pl_adapter_guidance (cw_conversation, wa_hash, message_id, event) VALUES ($1,$2,$3,'provision_ack') ON CONFLICT DO NOTHING RETURNING id`, [who.conversationId, h, who.messageId])
          if (claim.rowCount !== 1) return
          if (finished) { await db.query(`DELETE FROM pl_adapter_guidance WHERE id=$1`, [claim.rows[0].id]).catch(() => {}); return }   // it finished while we were checking: no acknowledgement
          const posted = await cwPost(cfg, `/conversations/${who.conversationId}/messages`, { content: PROVISIONING_ACK, message_type: 'outgoing', private: false }, f).catch(() => null)
          if (!posted?.id) { await db.query(`DELETE FROM pl_adapter_guidance WHERE id=$1`, [claim.rows[0].id]).catch(() => {}); return }
          await db.query(`UPDATE pl_adapter_guidance SET stage='provisioning', posted_msg_id=$2 WHERE id=$1`, [claim.rows[0].id, String(posted.id)])
        } catch { /* an acknowledgement must never break provisioning */ }
      }, cfg.provisionAckMs)
      let r
      try {
        r = await pl(cfg, stats, 'lines/provision', who, { acquisition_source: 'uplink-whatsapp' }, { act: 'pl.confirm_signup', act_src: 'numbered' }, f)
        const t0 = Date.now()
        while (r.code === 'provisioning' && Date.now() - t0 < cfg.provisionPollMs) {
          await new Promise((res) => setTimeout(res, 2000))
          r = await pl(cfg, stats, 'lines/provision', who, { acquisition_source: 'uplink-whatsapp' }, { act: 'pl.confirm_signup', act_src: 'numbered' }, f)
        }
      } finally { finished = true; clearTimeout(ackTimer) }
      await db.query(`UPDATE pl_adapter_offer SET outcome_code=$2 WHERE id=$1`, [row.id, r.code])
      if (r.code === 'line_created' || r.code === 'line_exists') return done({ code: r.code, ...pick(r.data, ['did_pretty', 'did_masked', 'trial', 'trial_ends_pretty']) })
      if (r.code === 'provisioning') return done({ code: 'provisioning', retry_after_s: r.data?.retry_after_s ?? 15 })
      return refuse(r.code, r.data?.retry_after_s ? { retry_after_s: r.data.retry_after_s } : {})
    },
    async pl_next_step(who, args) {
      if (args.event !== undefined && !['status', 'installed', 'resend'].includes(args.event)) return refuse('invalid_arguments')
      if (cfg.flowOnboarding) {
        const fl = await pl(cfg, stats, 'flows/launch', who, { flow: 'signup' }, {}, f).catch(() => null)
        if (fl?.code === 'flow_sent') return done({ code: 'setup_flow_sent', offer_key: 'trial', existing_line: fl.data?.existing_line === true,
          note: 'The setup form has ALREADY been sent to the customer as its own WhatsApp message - it shows their line, the app install, the setup link, a connection check and their balance. Tell them to open it - its button is "Manage my line" if they already have a line (existing_line true), otherwise "Start signup". Do NOT list steps, links or numbers yourself.' })
        if (fl?.code === 'rate_limited') return done({ code: 'setup_flow_recently_sent',
          note: 'A setup form was already sent to this customer in the last hour. Tell them to open the most recent setup form in this chat (button "Manage my line" or "Start signup"). Do NOT list steps or links yourself.' })
        if (fl?.code === 'no_account') return refuse('no_account')
        // Flow mode never posts the legacy chat guidance (its buttons depend on a model turn): any other outcome is reported honestly.
        return refuse(fl?.code && fl.code !== 'bad_response' ? fl.code : 'service_unavailable')
      }
      const event = args.event ?? 'status'
      const h = waHash(cfg, who.waId)
      // The model can call a tool twice in one turn (measured: two parallel pl_provision calls). One customer message + one event = ONE delivered guidance message.
      const claim = await db.query(`INSERT INTO pl_adapter_guidance (cw_conversation, wa_hash, message_id, event) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING id`, [who.conversationId, h, who.messageId, event])
      if (claim.rowCount !== 1) {
        const prior = (await db.query(`SELECT stage, posted_msg_id FROM pl_adapter_guidance WHERE cw_conversation=$1 AND wa_hash=$2 AND message_id=$3 AND event=$4`, [who.conversationId, h, who.messageId, event])).rows[0]
        return done({ code: 'guidance_sent', stage: prior?.stage ?? null, already: true, note: 'This step was ALREADY delivered to the customer as its own message. Reply with ONE short friendly sentence only; add nothing else.' })
      }
      const r = await pl(cfg, stats, 'account/next-step', who, { event }, {}, f)
      const release = () => db.query(`DELETE FROM pl_adapter_guidance WHERE id=$1`, [claim.rows[0].id]).catch(() => {})
      if (r.code === 'no_account') { await release(); return refuse('no_account') }
      const g = (r.code === 'next_step' || r.code === 'activation_paused' || r.code === 'link_rate_limited') ? composeGuidance(r.code, { ...r.data }) : null
      if (!g) { await release(); return refuse(r.code === 'bad_response' ? 'service_unavailable' : r.code) }
      const posted = await cwPost(cfg, `/conversations/${who.conversationId}/messages`, {
        content: g.text, message_type: 'outgoing', private: false, content_type: 'input_select',
        content_attributes: { items: g.choices.map((c) => ({ title: c.title, value: c.value })) },
      }, f).catch(() => null)
      if (!posted?.id) { await release(); return refuse('guidance_send_failed') }       // never claim a step that was not delivered
      await db.query(`UPDATE pl_adapter_guidance SET stage=$2, posted_msg_id=$3 WHERE id=$1`, [claim.rows[0].id, g.stage, String(posted.id)])
      const fx = r.data?.facts ?? {}
      return done({ code: 'guidance_sent', stage: g.stage, facts: { sip_registration: fx.sip_registration ?? null, first_call_done: fx.first_call_done ?? null, credential_handed_to_app: fx.credential_handed_to_app ?? null },
        note: 'The next step (with tap buttons) has ALREADY been delivered to the customer as its own message. Do NOT repeat, restate, summarise or paraphrase it, add links, or claim the line is working, set up or connected. Reply with ONE short friendly sentence only.' })
    },
    // ── tools that deliver their own message with tap-buttons (identity-bound: the subject is the verified sender only) ──
    async pl_explain(who) {
      return deliverOwn(who, 'explain', async () => {
        const o = await pl(cfg, stats, 'offer', who, {}, {}, f)
        if (o.code !== 'offer') return { refusal: refuse(o.code) }
        return { g: composeExplainer(pick(o.data, ['trial_days', 'trial_minutes'])) }
      })
    },
    // rc12: the model's balance / calls requests run the SAME deterministic action a tap runs (state-aware buttons, one message).
    async pl_balance(who) { return runAction(who, 'balance') },
    async pl_recent_calls(who) { return runAction(who, 'recent_calls') },
    // rc13 (PM 2026-10-10: the native agent converses; tools return verified facts): pl_journey and pl_guide post NOTHING. They
    // return facts + the contextual buttons for this state; the agent writes ONE reply and the relay attaches these buttons to it.
    async pl_journey(who) {
      const jr = await journeyRead(who)
      if (!jr.ok) return refuse(jr.code)
      const j = jr.j
      return done({ code: 'facts', topic: 'journey', state: j.state, next_action: j.next_action, has_line: j.has_line === true,
        attention: j.attention ?? [], facts: modelFacts(j), payment: { topup_or_purchase_in_chat: j.payment?.topup_available === true },
        choices: titlesOf(choicesFor(j.actions)), note: FACTS_NOTE })
    },
    async pl_guide(who, args) {
      const topic = args.topic
      if (!GUIDE_TOPICS.includes(topic)) return refuse('invalid_arguments')
      const jr = await journeyRead(who)
      if (!jr.ok) return refuse(jr.code)
      const j = jr.j, fx = j.facts ?? {}
      const needsLine = !['how_it_works', 'plans'].includes(topic)
      if (needsLine && !j.has_line) return done({ code: 'facts', topic, state: j.state, has_line: false, facts: null, note: 'This person has no line yet, so there is nothing account-specific to check. Explain briefly and offer to get them a number. ' + FACTS_NOTE, choices: titlesOf(choicesFor(j.actions)) })
      const out = { code: 'facts', topic, state: j.state, has_line: j.has_line === true, note: FACTS_NOTE }
      if (topic === 'how_it_works' || topic === 'plans') {
        const o = await offerRead(who); if (!o) return refuse('offer_unavailable')
        out.catalogue = catalogueFacts(o)
        out.purchase_in_chat = j.payment?.topup_available === true
        if (j.has_line) out.current = modelFacts(j)
        out.choices = titlesOf(j.has_line ? choicesFor(['balance', 'human']) : choicesFor(topic === 'plans' ? ['get_number', 'how_it_works', 'human'] : ['get_number', 'plans', 'human']))
        return done(out)
      }
      const b = await pl(cfg, stats, 'account/balance', who, {}, {}, f).catch(() => null)
      const bal = b?.code === 'balance' ? b.data : null
      const o = await offerRead(who)
      out.facts = { ...modelFacts(j), plan_covers_us_canada: bal?.known === true ? bal.pool === 'shared' : null }
      if (o) out.rates = { dominica_after_included: '13.5 EC cents a minute (from wallet credit)', us_canada_when_not_included: `EC$${o.overage_uscan_xcd} a minute (from wallet credit)` }
      out.dialing = { dominica: '+1 767 then the 7-digit number', us_canada: '+1 then the 10-digit number', app: 'Cloud Softphone on this phone' }
      if (topic === 'calling' || topic === 'how_to_call' || topic === 'calling_help') out.choices = titlesOf([ACT.call_dominica, ACT.call_uscan, ACT.call_failed])
      else if (topic === 'call_failed' || topic === 'troubleshoot') {
        const d = composeCallFailed(fx, bal)
        out.diagnosis = d.stage
        out.choices = titlesOf(d.connected || fx.first_call_done === true ? choicesFor(['check_connection', 'human']) : choicesFor(['check_connection', 'continue_setup', 'human']))
      } else out.choices = titlesOf(choicesFor(j.state === 'registered_no_call' ? ['how_to_call', 'human'] : j.actions))
      return done(out)
    },
    _runAction: runAction, _setPreference: setPreference, _journeyRead: journeyRead, _aiOwned: aiOwned,
    async pl_status(who) {
      const r = await pl(cfg, stats, 'account/line-status', who, {}, {}, f)
      if (r.code === 'no_account') return done({ code: 'no_account' })
      return r.code === 'line_status' ? done({ code: 'line_status', ...pick(r.data, ['did_pretty', 'did_masked', 'registration', 'softphone_activated', 'first_call_done', 'plan', 'plan_expires_at', 'next_step']) }) : refuse(r.code)
    },
    async pl_setup_link(who, args) {
      if (!['softphone_activation', 'app_signin'].includes(args.kind)) return refuse('kind_invalid')
      const r = await pl(cfg, stats, 'links/activation', who, { kind: args.kind, reason: 'initial' }, {}, f)
      return r.code === 'link_minted' ? done({ code: 'link_minted', kind: r.data.kind, url: r.data.url, expires_in_min: r.data.expires_in_min }) : refuse(r.code, pick(r.data, ['retry_after_s', 'reason']))
    },
  }
}
function pick(o, keys) { const out = {}; for (const k of keys) if (o && o[k] !== undefined) out[k] = o[k]; return out }

// ── rc12: deterministic taps (relay -> /v1/action) ───────────────────────────────────────────────────────────────────────────────────
// WhatsApp delivers a tapped reply button / list row as the customer's message whose text is the TITLE. A tap is honoured only if the
// LATEST earlier outgoing message that carried choices actually offered that exact title - the readback, not the relay's say-so.
const normTitle = (t) => String(t ?? '').replace(/\s+/g, ' ').trim().toLowerCase()
export function resolveTap(messages, messageId, content) {
  const mine = Number(messageId)
  const prior = (messages || []).filter((m) => (m.message_type === 1 || m.message_type === 'outgoing') && !m.private && Number(m.id) < mine
    && Array.isArray(m.content_attributes?.items) && m.content_attributes.items.length > 0).sort((a, b) => Number(b.id) - Number(a.id))[0]
  if (!prior) return null
  const item = prior.content_attributes.items.find((i) => normTitle(i.title) === normTitle(content))
  if (!item) return null
  const action = VALUE_TO_ACTION[item.value]
  return action ? { action, value: item.value, offeredIn: String(prior.id) } : null
}
export const STOP_RE = /^\s*(stop|unsubscribe)\s*[.!]?\s*$/i
export const START_RE = /^\s*start\s*[.!]?\s*$/i

// ── rc12: proactive follow-ups (plsvc registration watch -> /v1/proactive) ───────────────────────────────────────────────────────────
// Signed by plsvc with the PL concierge key both services already hold, under its own purpose label. Every check that made the old
// direct-to-Meta senders unsafe lives here: Chatwoot ownership (pending only), STOP, the customer's own 24 h window, one delivery per
// verdict per hand-off (unique row), and wording from the CURRENT journey (a verdict the customer has moved past is not sent).
export const PROACTIVE_PURPOSE = 'pl-proactive-v1'
export const WINDOW_S = 23.5 * 3600
export const STAFF_NOTE_PEER_ABSENT = 'Registration stalled - the SIP peer for this line is MISSING on the voice server (Magnus user/sip row), so the phone cannot register no matter what the customer does. Do NOT ask the customer to retry or reinstall; check the Magnus user and its SIP row.'
const PROACTIVE_KEYS = new Set(['activated', 'first_call', 'stalled:handoff_no_register', 'stalled:link_not_opened', 'stalled:no_handoff', 'stalled:peer_absent_from_conf'])
export function verifyProactive(raw, sig, cfg, nowMs = Date.now()) {
  if (typeof sig !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(sig)) return { ok: false, why: 'no_signature' }
  const mac = crypto.createHmac('sha256', Buffer.from(cfg.plKey, 'utf8')).update(`${PROACTIVE_PURPOSE}.${raw}`, 'utf8').digest('base64url')
  if (!eq(mac, sig)) return { ok: false, why: 'bad_signature' }
  let b; try { b = JSON.parse(raw) } catch { return { ok: false, why: 'bad_json' } }
  if (!b || b.kid !== cfg.plKid || !Number.isSafeInteger(b.iat) || Math.abs(Math.floor(nowMs / 1000) - b.iat) > 120) return { ok: false, why: 'stale_or_wrong_key' }
  if (!WA_ID.test(String(b.wa_id)) || !PROACTIVE_KEYS.has(b.key) || typeof b.ref !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(b.ref)) return { ok: false, why: 'bad_fields' }
  return { ok: true, b }
}
/** The customer's WhatsApp conversation in the PL inbox, found by their EXACT numeric wa_id (never a fuzzy phone match). */
async function conversationFor(cfg, waId, f) {
  const found = await cw(cfg, `/contacts/search?q=${encodeURIComponent(waId)}`, f)
  const ids = (Array.isArray(found?.payload) ? found.payload : []).map((c) => c.id).filter(Boolean).slice(0, 5)
  const matches = []
  for (const id of ids) {
    const c = (await cw(cfg, `/contacts/${id}`, f))?.payload ?? null
    const src = (c?.contact_inboxes ?? []).filter((x) => Number(x?.inbox?.id ?? x?.inbox_id) === cfg.cwInbox).map((x) => String(x.source_id)).filter((s) => WA_ID.test(s))
    if (src.length === 1 && src[0] === waId) matches.push(id)
  }
  if (matches.length !== 1) return { ok: false, why: matches.length ? 'contact_ambiguous' : 'no_contact' }
  const convs = (await cw(cfg, `/contacts/${matches[0]}/conversations`, f))?.payload ?? []
  const mine = convs.filter((c) => Number(c.inbox_id) === cfg.cwInbox).sort((a, b) => Number(b.last_activity_at ?? 0) - Number(a.last_activity_at ?? 0) || Number(b.id) - Number(a.id))
  if (!mine.length) return { ok: false, why: 'no_conversation' }
  return { ok: true, conversationId: String(mine[0].id) }
}
export async function handleProactive(cfg, db, stats, b, f = fetch, nowMs = Date.now()) {
  const fc = await conversationFor(cfg, String(b.wa_id), f).catch(() => ({ ok: false, why: 'chatwoot_unreachable' }))
  if (!fc.ok) return { code: fc.why === 'chatwoot_unreachable' ? 'failed' : 'no_conversation', detail: fc.why }
  const conversationId = fc.conversationId
  const conv = await cw(cfg, `/conversations/${conversationId}`, f).catch(() => null)
  if (!conv) return { code: 'failed', detail: 'conversation_unreadable' }
  const h = waHash(cfg, String(b.wa_id))
  const msgKey = `proactive:${b.key}:${b.ref}`
  const claimRow = async () => (await db.query(`INSERT INTO pl_adapter_guidance (cw_conversation, wa_hash, message_id, event) VALUES ($1,$2,$3,'proactive') ON CONFLICT DO NOTHING RETURNING id`, [conversationId, h, msgKey])).rows[0]?.id ?? null
  // Staff-only verdict: a private note, no customer message (so no window / STOP / ownership question).
  if (b.key === 'stalled:peer_absent_from_conf') {
    const id = await claimRow(); if (!id) return { code: 'duplicate' }
    const posted = await cwPost(cfg, `/conversations/${conversationId}/messages`, { content: STAFF_NOTE_PEER_ABSENT, message_type: 'outgoing', private: true }, f).catch(() => null)
    if (!posted?.id) { await db.query(`DELETE FROM pl_adapter_guidance WHERE id=$1`, [id]).catch(() => {}); return { code: 'failed', detail: 'note_not_posted' } }
    await db.query(`UPDATE pl_adapter_guidance SET stage='staff_note', posted_msg_id=$2 WHERE id=$1`, [id, String(posted.id)])
    return { code: 'sent' }
  }
  if (conv.status !== 'pending') return { code: 'held', detail: `status_${conv.status}` }
  const pref = (await db.query(`SELECT proactive_stopped FROM pl_adapter_preference WHERE wa_hash=$1`, [h])).rows[0]
  if (pref?.proactive_stopped === true) return { code: 'stopped' }
  const msgs = await cw(cfg, `/conversations/${conversationId}/messages`, f).catch(() => null)
  const list = Array.isArray(msgs?.payload) ? msgs.payload : []
  const lastIn = list.filter(isIncomingContactMsg).sort((x, y) => Number(y.created_at) - Number(x.created_at))[0]
  if (!lastIn || Math.floor(nowMs / 1000) - Number(lastIn.created_at) > WINDOW_S) return { code: 'outside_window' }
  const wamid = /^wamid\.[A-Za-z0-9+/=_-]{8,120}$/.test(String(lastIn.source_id ?? '')) ? String(lastIn.source_id) : `proactive.${b.ref}`
  const who = { waId: String(b.wa_id), conversationId, wamid, messageId: msgKey }
  const r = await pl(cfg, stats, 'account/journey', who, {}, {}, f)
  if (r.code !== 'journey') return { code: 'failed', detail: `journey_${r.code}` }
  // rc13: the estate STOP stores (Meta STOP -> Contact.doNotContact / WhatsappOptIn revoked) outrank everything; consent that
  // cannot be read is HELD (retried later), never assumed (PM 2026-10-10 STOP unification).
  const consent = r.data?.consent
  if (consent?.known === true && consent.estate_suppressed === true) return { code: 'stopped', detail: 'estate_suppressed' }
  if (consent?.known !== true) return { code: 'held', detail: 'consent_unknown' }
  const g = composeProactive(b.key, r.data)
  if (!g) return { code: 'superseded_by_state', detail: String(r.data?.state ?? '') }
  // The first-call message may already have gone out as the answer to this hand-off's 'activated' verdict.
  if (b.key === 'first_call' && (await db.query(`SELECT 1 FROM pl_adapter_guidance WHERE cw_conversation=$1 AND wa_hash=$2 AND message_id=$3 AND stage='proactive_first_call'`, [conversationId, h, `proactive:activated:${b.ref}`])).rowCount) return { code: 'duplicate' }
  const id = await claimRow(); if (!id) return { code: 'duplicate' }
  const release = () => db.query(`DELETE FROM pl_adapter_guidance WHERE id=$1`, [id]).catch(() => {})
  const again = await cw(cfg, `/conversations/${conversationId}`, f).catch(() => null)   // ownership re-read right before the send
  if (again?.status !== 'pending') { await release(); return { code: 'held', detail: `status_${again?.status ?? 'unreadable'}` } }
  const posted = await cwPost(cfg, `/conversations/${conversationId}/messages`, { content: g.text, message_type: 'outgoing', private: false, content_type: 'input_select',
    content_attributes: { items: g.choices.map((c) => ({ title: c.title, value: c.value })) } }, f).catch(() => null)
  if (!posted?.id) { await release(); return { code: 'failed', detail: 'send_failed' } }
  await db.query(`UPDATE pl_adapter_guidance SET stage=$2, posted_msg_id=$3 WHERE id=$1`, [id, g.stage, String(posted.id)])
  return { code: 'sent', covered: g.covered ?? [b.key], stage: g.stage }
}

// ── MCP (Streamable HTTP, JSON-RPC 2.0) ─────────────────────────────────────────────────────────────────────────────────────────────────────
const ACCOUNT_TOOLS = new Set(['pl_explain', 'pl_balance', 'pl_recent_calls', 'pl_journey', 'pl_guide'])
const NEVER_EXPOSED = new Set(['pl_explain'])   // its 'Get my number' button would depend on a model turn; onboarding starts from the Flow
export function makeServer(cfg, db, f = fetch) {
  const stats = {}
  const handlers = makeHandlers(cfg, db, stats, f)
  const rpcErr = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } })
  const toolResult = (id, ok, payload) => ({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(payload) }], isError: !ok } })
  async function handle(req) {
    const { method, params, id } = req
    if (method === 'initialize') return { jsonrpc: '2.0', id, result: { protocolVersion: params?.protocolVersion || '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'pl-action-adapter', version: '1' } } }
    if (method === 'notifications/initialized') return null
    const exposed = (name) => !!SCHEMAS[name] && !NEVER_EXPOSED.has(name) && (cfg.accountTools || !ACCOUNT_TOOLS.has(name))
    if (method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: Object.entries(SCHEMAS).filter(([name]) => exposed(name)).map(([name, s]) => ({ name, ...s })) } }
    if (method !== 'tools/call') return rpcErr(id, -32601, 'method not found')
    const name = params?.name, args = params?.arguments ?? {}
    if (!exposed(name)) return toolResult(id, false, { code: 'unknown_tool' })
    // strict argument schema: unknown keys (a smuggled phone / user id / confirmation flag) are refused, never ignored
    const allowed = Object.keys(SCHEMAS[name].inputSchema.properties)
    if (typeof args !== 'object' || args === null || Array.isArray(args) || Object.keys(args).some((k) => !allowed.includes(k))) return toolResult(id, false, { code: 'invalid_arguments' })
    const v = verifyContext(params?._meta?.[META_KEY], cfg)
    if (!v.ok) return toolResult(id, false, { code: 'identity_unverified', detail: v.why })
    let who
    try { who = await resolveSender(cfg, v.claims, f) } catch (e) { return toolResult(id, false, { code: 'identity_unverified', detail: e?.code || 'chatwoot_unreachable' }) }
    if (!who.ok) return toolResult(id, false, { code: 'identity_unverified', detail: who.why })
    try {
      const out = await handlers[name](who, args)
      // rc2 envelope contract (Codex native validator): provision/status/link results also carry the customer-visible fields under `data`; pl_present_offer stays FLAT (the relay reads customer_message at the top level).
      if (out.ok && out.result && ENVELOPE_DATA_TOOLS.has(name)) { const { code, ...rest } = out.result; return toolResult(id, true, { code, ...rest, data: rest }) }
      return toolResult(id, out.ok, out.result)
    }
    catch (e) { console.error('[adapter] tool error', name, String(e?.message || e).slice(0, 120)); return toolResult(id, false, { code: 'service_unavailable' }) }
  }
  // rc12: a deterministic action for the verified sender of ONE customer message (the relay's tap / STOP / START / Flow Done path).
  // Identity is the same signed relay context + Chatwoot readback the MCP tools use; a tap is honoured only by readback (resolveTap).
  async function handleAction(body) {
    const v = verifyContext(body?.context, cfg)
    if (!v.ok) return { code: 'identity_unverified', detail: v.why }
    let who
    try { who = await resolveSender(cfg, v.claims, f) } catch (e) { return { code: 'identity_unverified', detail: e?.code || 'chatwoot_unreachable' } }
    if (!who.ok) return { code: 'identity_unverified', detail: who.why }
    const run = async (action, fn) => { const out = await fn(); return { code: out.ok ? 'handled' : 'refused', action, result: out.result } }
    if (body.action === 'flow_done') return run('flow_done', () => handlers._runAction(who, 'flow_done'))
    if (body.action !== 'auto') return { code: 'invalid_action' }
    if (STOP_RE.test(who.content)) return run('stop', () => handlers._setPreference(who, true))
    if (START_RE.test(who.content)) return run('start', () => handlers._setPreference(who, false))
    if (cfg.deterministicTaps === false) return { code: 'not_handled' }   // the agent answers taps (rc13d)
    const tap = resolveTap(who.messages, who.messageId, who.content)
    if (!tap) return { code: 'not_handled' }
    return run(tap.action, () => handlers._runAction(who, tap.action))
  }
  const readRaw = async (rq) => { let raw = ''; for await (const c of rq) { raw += c; if (raw.length > 65536) return null } return raw }
  const handler = async (rq, rs) => {
    const send = (code, obj) => { rs.writeHead(code, { 'content-type': 'application/json' }); rs.end(JSON.stringify(obj)) }
    if (rq.url === '/health') return send(200, { ok: true })
    if (!sourceAllowed(rq.socket.remoteAddress, cfg.sourceCidrs)) return send(403, { error: 'source_not_allowed' })     // network restriction in addition to the bearer
    // rc12: the PL service's proactive follow-ups authenticate with their own signature (plsvc holds the PL key, not this bearer).
    if (rq.method === 'POST' && rq.url === '/v1/proactive') {
      const raw = await readRaw(rq); if (raw === null) return send(413, { error: 'too_large' })
      const v = verifyProactive(raw, rq.headers['x-pl-proactive-signature'], cfg)
      if (!v.ok) return send(401, { error: 'unauthorized', detail: v.why })
      try { return send(200, await handleProactive(cfg, db, stats, v.b, f)) }
      catch (e) { console.error('[adapter] proactive error', String(e?.message || e).slice(0, 120)); return send(200, { code: 'failed', detail: 'internal' }) }
    }
    if (!eq(rq.headers.authorization || '', `Bearer ${cfg.bearer}`)) return send(401, { error: 'unauthorized' })
    if (cfg.debug && rq.url === '/__stats') return send(200, stats)
    if (rq.method === 'POST' && rq.url === '/v1/action') {
      const raw = await readRaw(rq); if (raw === null) return send(413, { error: 'too_large' })
      let body; try { body = JSON.parse(raw) } catch { return send(400, { error: 'bad_json' }) }
      try { return send(200, await handleAction(body)) }
      catch (e) { console.error('[adapter] action error', String(e?.message || e).slice(0, 120)); return send(200, { code: 'refused', result: { code: 'service_unavailable' } }) }
    }
    if (rq.method !== 'POST' || rq.url !== '/mcp') return send(404, { error: 'not_found' })
    let raw = ''; for await (const c of rq) { raw += c; if (raw.length > 65536) return send(413, { error: 'too_large' }) }
    let body; try { body = JSON.parse(raw) } catch { return send(400, rpcErr(null, -32700, 'parse error')) }
    const out = await handle(body)
    if (out === null) { rs.writeHead(202); return rs.end() }
    send(200, out)
  }
  const server = cfg.tlsKey && cfg.tlsCert ? https.createServer({ key: cfg.tlsKey, cert: cfg.tlsCert, minVersion: 'TLSv1.2' }, handler) : http.createServer(handler)
  return { server, stats }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const cfg = loadConfig()
  const pg = createRequire((process.env.PG_RESOLVE_FROM || '/app') + '/package.json')('pg')   // ESM import() ignores NODE_PATH; resolve from the image's node_modules
  const db = new pg.Pool({ connectionString: cfg.dbUrl, max: 4 })
  await db.query(DDL)
  makeServer(cfg, db).server.listen(cfg.port, '0.0.0.0', () => console.log(`pl-action-adapter listening ${cfg.port}`))
}
