// rc16g STAGING one-shot: how long does the adapter take to answer /v1/eligibility (real adapter + real plsvc journey + mock Chatwoot)?
// Direct signed calls for ONE synthetic sender; prints milliseconds only. PHASES=START,STOP,... performs that keyword through the
// adapter's real /v1/action route before the n-th call (to see whether a keyword makes the NEXT answer slow).
import crypto from 'node:crypto'
import { readFileSync } from 'node:fs'
const rd = (p) => readFileSync(p, 'utf8').replace(/\r?\n$/, '')
const PLKEY = rd('/run/secrets/plkey'), CTXKEY = rd('/run/secrets/ctxkey'), BEARER = rd('/run/secrets/bearer')
const P = process.env, b64u = (b) => Buffer.from(b).toString('base64url')
const wa = P.USE_WA, AD = 'http://zzrc16g-adapter:9100', CW = 'http://zzrc16g-cw:9300'
if (!/^176755501\d\d$/.test(wa || '')) { console.log('USE_WA must be synthetic'); process.exit(2) }
const cw = (o) => fetch(`${CW}/__state`, { method: 'POST', body: JSON.stringify({ wa, ...o }) })
await cw({ status: 'pending', inboundAgoS: 3600, delayMs: 0, failMessages: false, failConversation: false, noContact: false, outgoingOnly: false, inboundText: 'hi' })
async function keyword(text) {
  await cw({ status: 'pending', inboundText: text, inboundAgoS: 30 })
  const claims = { kid: P.ADAPTER_ENV_RELAY_KID, iat: Math.floor(Date.now() / 1000), nonce: crypto.randomBytes(16).toString('base64url').slice(0, 22), accountId: Number(P.ADAPTER_ENV_ACCOUNT), inboxId: Number(P.ADAPTER_ENV_INBOX), workspaceId: P.ADAPTER_ENV_WORKSPACE, agentId: P.ADAPTER_ENV_AGENT, agentSlug: P.ADAPTER_ENV_SLUG, chatwootConversationId: String(Number(wa.slice(-6)) + 100000), chatwootMessageId: String(5000 + Number(wa.slice(-4))), messageSha256: crypto.createHash('sha256').update(text).digest('hex') }
  const Pp = b64u(JSON.stringify(claims)), ctx = `v1.${Pp}.${b64u(crypto.createHmac('sha256', Buffer.from(CTXKEY, 'utf8')).update('v1.' + Pp).digest())}`
  const t0 = Date.now(); const r = await fetch(`${AD}/v1/action`, { method: 'POST', headers: { authorization: `Bearer ${BEARER}`, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'auto', context: ctx }) }); const j = await r.json()
  await cw({ inboundText: 'hi', inboundAgoS: 3600 })
  console.log(`${text} -> ${r.status} ${j.action} ${Date.now() - t0} ms`)
}
const PHASES = (P.PHASES || '').split(',').filter(Boolean)
const ms = []
for (let i = 0; i < 8; i++) {
  if (PHASES[i]) await keyword(PHASES[i])
  const body = JSON.stringify({ kid: P.ADAPTER_ENV_PL_KID, wa_id: wa, ref: 'cw-lat', iat: Math.floor(Date.now() / 1000), nonce: crypto.randomBytes(16).toString('base64url') })
  const sig = crypto.createHmac('sha256', Buffer.from(PLKEY, 'utf8')).update(`pl-eligibility-v1.${body}`, 'utf8').digest('base64url')
  const t0 = Date.now(); const r = await fetch(`${AD}/v1/eligibility`, { method: 'POST', headers: { 'x-pl-eligibility-signature': sig }, body }); const j = await r.json()
  ms.push(Date.now() - t0); console.log(`#${i + 1}${PHASES[i] ? ` (after ${PHASES[i]})` : ''} http=${r.status} ${j.reason} ${ms.at(-1)} ms`)
}
console.log(`min=${Math.min(...ms)} median=${[...ms].sort((a, b) => a - b)[4]} max=${Math.max(...ms)} ms`)
