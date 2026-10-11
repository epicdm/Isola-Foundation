// zz-emit-driver.mjs — runs INSIDE the plstg_zzemit_web container (node 22, no deps). STAGING ONLY, synthetic numbers only.
// It uses the container's own env (assertion key, cron credential, events key FILE) in-process and NEVER prints them.
//   node zz-emit-driver.mjs provision <wa_id> <mid-suffix>
//   node zz-emit-driver.mjs get <path-and-query>            (cron auth header added)
//   node zz-emit-driver.mjs post <path> '<json>'            (cron auth header added)
//   node zz-emit-driver.mjs fork <case> [json]              (direct probes at the fork webhook: good | badsig | oldts | otherpath | rawtype)
import { createHmac, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'

const BASE = 'http://127.0.0.1:3005'
const E = process.env
const [cmd, ...args] = process.argv.slice(2)
const out = (o) => console.log(typeof o === 'string' ? o : JSON.stringify(o))
const b64u = (b) => Buffer.from(b).toString('base64url')

async function provision(wa, midSuffix) {
  const payload = { kid: E.PL_ASSERTION_KID, wa_id: wa, pnid: '100000000000009', rid: 'zzemit-conv-' + midSuffix, mid: 'wamid.ZZEMIT' + midSuffix,
    iat: Math.floor(Date.now() / 1000), nonce: b64u(randomBytes(16)).slice(0, 22), act: 'pl.confirm_signup', act_src: 'button' }
  const p = b64u(JSON.stringify(payload))
  const sig = createHmac('sha256', Buffer.from(E.PL_ASSERTION_HMAC_KEY, 'utf8')).update('v1.' + p).digest('base64url')
  const res = await fetch(`${BASE}/api/internal/pl-concierge/v1/lines/provision`, { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-isola-assertion': `v1.${p}.${sig}`, 'x-conversation-id': payload.rid, 'x-forwarded-for': '127.0.0.1' }, body: '{}' })
  const j = await res.json().catch(() => ({}))
  out({ http: res.status, code: j.code, already: j.already, did_masked: j.data?.did_masked, trial: j.data?.trial })
}

async function cron(method, path, body) {
  const res = await fetch(BASE + path, { method, headers: { 'x-cron-secret': E.CRON_SECRET, ...(body ? { 'content-type': 'application/json' } : {}) }, body, signal: AbortSignal.timeout(60000) })
  out({ http: res.status, body: await res.json().catch(() => null) })
}

function eventsKey() { return readFileSync(E.PL_SF_EVENTS_KEY_FILE, 'utf8').trim() }
async function forkProbe(kind, jsonArg) {
  const url = new URL(E.PL_SF_EVENTS_URL)
  const ev = jsonArg ? JSON.parse(jsonArg) : {}
  const body = JSON.stringify({ event_id: ev.event_id ?? crypto.randomUUID(), type: ev.type ?? 'pl.registration_changed', occurred_at: new Date().toISOString(), version: ev.version ?? 1,
    pl_account_id: ev.pl_account_id ?? 'zzemitprobe', wa_id: ev.wa_id ?? '17675590199', facts: ev.facts ?? { registration_now: 'registered' } })
  let key = eventsKey(), ts = Math.floor(Date.now() / 1000), target = url
  if (kind === 'badsig') key = 'x'.repeat(48)
  if (kind === 'oldts') ts -= 3600
  if (kind === 'otherpath') { target = new URL(url); target.pathname = '/api/webhooks/personal-line/' + (ev.other_org ?? 'f221e842-2b26-450d-b20f-13474e232cf8') }
  const sig = createHmac('sha256', Buffer.from(key, 'utf8')).update(`${ts}.${body}`).digest('base64url')
  const res = await fetch(target, { method: 'POST', headers: { 'content-type': 'application/json', 'x-pl-sf-kid': E.PL_SF_EVENTS_KID, 'x-pl-sf-ts': String(ts), 'x-pl-sf-sig': sig }, body })
  out({ case: kind, http: res.status, body: await res.json().catch(() => null), event_id: JSON.parse(body).event_id })
}

if (cmd === 'provision') await provision(args[0], args[1])
else if (cmd === 'get') await cron('GET', args[0])
else if (cmd === 'post') await cron('POST', args[0], args[1])
else if (cmd === 'fork') await forkProbe(args[0], args[1])
else { console.error('usage'); process.exit(2) }
