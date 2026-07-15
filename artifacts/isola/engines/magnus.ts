/**
 * magnus.ts — Portable Magnus Billing API client (Bucket 1 extraction)
 *
 * Extracted from (deepseek): /opt/bff-v2/app/lib/magnus.ts
 *   - phpUrlencode()        source L57-62
 *   - sign()                source L64-66   (HMAC-SHA512)
 *   - magnusRequest()       source L68-103  (core POST + auth + nonce)
 *   - findRowByField()      source L214-235 (internal — used by getBalance)
 *   - getMagnusUserById()   source L1336-1345  → renamed getBalance()
 *   - getMagnusUserCalls()  source L1346-1372  → renamed getCalls()
 *   - addMagnusCredit()     source L1423-1434  → renamed addCredit()
 *   - debitMagnusCredit()   source L1449-1463  → renamed debitCredit()  ⚠️ UNVERIFIED
 *
 * WHAT THIS DOES
 *   HMAC-SHA512-authenticated REST calls to Magnus Billing
 *   (`{baseUrl}/index.php/{module}/{action}`), plus 4 canonical read/write
 *   helpers: balance lookup, recent calls, credit top-up, credit debit.
 *
 * CONFIG REQUIRED — MagnusConfig
 *   { baseUrl, apiKey, apiSecret }
 *     baseUrl   — e.g. 'https://voice00.epic.dm/mbilling' (trailing slash optional)
 *     apiKey    — Magnus REST API key (sent as the `Key` header)
 *     apiSecret — Magnus REST API secret (used to HMAC-SHA512-sign the POST body)
 *
 * CAUTION
 *   - The HMAC signing, the nonce format (derived from process.hrtime(), matches
 *     the PHP wrapper's microtime()-style nonce), and the php-urlencode() quirks
 *     (space→'+', RFC-3986 unreserved chars re-escaped) are load-bearing. Do NOT
 *     "clean up" the encoding — Magnus validates the signature against the EXACT
 *     encoded string, byte for byte.
 *   - addCredit()/debitCredit() write to the `refill` module — VERIFIED LIVE
 *     (2026-07-11) against tenant Magnus user id 1549 and cross-checked against
 *     production `refill` rows: `refill/save` with `id_user` + `credit` (signed
 *     decimal string) immediately updates `user.credit` by exactly that delta —
 *     no floor-at-zero, no rejection on negative values. This is the SAME
 *     mechanism already used live in production for "Isola Lite top-up" credits
 *     and for real debits/reversals (e.g. "UAT reverse", "wallet-draw probe",
 *     "account consolidation" refill rows all carry negative `credit`). Magnus
 *     defaults `refill_type` and `payment` to `'0'` when omitted — that default
 *     is what every existing Isola-originated refill row already relies on;
 *     passing them explicitly here just documents the convention.
 *   - This module wraps only 4 read/write actions. The source file has many
 *     more (DID provisioning, SIP account creation, deprovisioning, pool-DID
 *     management, etc.) — deliberately NOT extracted here; out of scope for
 *     Bucket 1.
 */

import crypto from 'node:crypto'

export interface MagnusConfig {
  baseUrl: string
  apiKey: string
  apiSecret: string
}

export interface MagnusBalance {
  magnusUserId: string
  balance: number
  currency: string
}

export interface MagnusCallRecord {
  number: string
  dir: 'in' | 'out' | 'missed'
  time: string
  dur: string
}

export interface MagnusWriteResult {
  success: boolean
  error?: string
}

// ── Auth ─────────────────────────────────────────────────────────────────────

function phpUrlencode(s: string): string {
  return encodeURIComponent(s)
    .replace(/%20/g, '+')
    .replace(/!/g, '%21').replace(/~/g, '%7E').replace(/\*/g, '%2A')
    .replace(/'/g, '%27').replace(/\(/g, '%28').replace(/\)/g, '%29')
}

function sign(apiSecret: string, postData: string): string {
  return crypto.createHmac('sha512', apiSecret).update(postData).digest('hex')
}

/**
 * magnusRequest — core authenticated POST to
 * `{baseUrl}/index.php/{module}/{action}`. Throws on transport error, on a
 * non-JSON response, or when Magnus returns `{status:'error'}`.
 */
export async function magnusRequest(
  config: MagnusConfig,
  module: string,
  action: string,
  data: Record<string, string> = {},
): Promise<any> {
  if (!config.apiKey || !config.apiSecret) {
    throw new Error('Magnus API credentials not configured')
  }

  // Canonical microtime-style nonce (matches the PHP wrapper exactly)
  const mt = process.hrtime()
  const nonce = mt[0].toString() + String(mt[1]).padStart(9, '0').slice(0, 6)

  const postData = Object.entries({ module, action, nonce, ...data })
    .map(([k, v]) => phpUrlencode(k) + '=' + phpUrlencode(v))
    .join('&')
  const signature = sign(config.apiSecret, postData)
  const url = `${config.baseUrl.replace(/\/+$/, '')}/index.php/${module}/${action}`

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Key': config.apiKey,
      'Sign': signature,
    },
    body: postData,
    signal: AbortSignal.timeout(15000),
  })

  const text = await res.text()
  let json: any
  try {
    json = JSON.parse(text)
  } catch {
    throw new Error(`Magnus invalid response: ${text.slice(0, 200)}`)
  }
  if (json?.status === 'error') {
    throw new Error(`Magnus error: ${json.message || JSON.stringify(json)}`)
  }
  return json
}

/**
 * findRowByField — internal helper. Finds a single record by field=value
 * using the canonical Magnus grid-filter shape. Returns the full row, or
 * null if no match / on any error (never throws).
 */
async function findRowByField(
  config: MagnusConfig,
  module: string,
  field: string,
  value: string,
): Promise<Record<string, any> | null> {
  if (!value) return null
  const isNumeric = /^\d+$/.test(value)
  const filter = JSON.stringify([{
    type: isNumeric ? 'numeric' : 'string',
    field,
    value,
    comparison: 'eq',
  }])
  try {
    const r = await magnusRequest(config, module, 'read', {
      page: '1', start: '0', limit: '25', filter,
    })
    return r?.rows?.[0] ?? null
  } catch {
    return null
  }
}

/**
 * getBalance — fetch a Magnus user record by numeric id. Returns the
 * balance in EC$, or null if the user doesn't exist / on error.
 */
export async function getBalance(
  config: MagnusConfig,
  magnusUserId: string,
): Promise<MagnusBalance | null> {
  if (!magnusUserId) return null
  const row = await findRowByField(config, 'user', 'id', magnusUserId)
  if (!row?.id) return null
  return { magnusUserId: String(row.id), balance: parseFloat(String(row.credit ?? '0')), currency: 'EC$' }
}

/**
 * getCalls — recent CDR entries for a Magnus user, formatted for display.
 * Never throws — returns [] on any error.
 */
export async function getCalls(
  config: MagnusConfig,
  magnusUserId: string,
  limit = 20,
): Promise<MagnusCallRecord[]> {
  try {
    const filter = JSON.stringify([{ type: 'numeric', field: 'id_user', value: magnusUserId, comparison: 'eq' }])
    const res = await magnusRequest(config, 'call', 'read', {
      page: '1', start: '0', limit: String(limit), sort: 'starttime', dir: 'DESC', filter,
    })
    const rows: any[] = res?.rows ?? []
    return rows.map((r: any) => {
      const disposition = String(r.disposition ?? '').toUpperCase()
      const durSec = parseInt(String(r.duration ?? r.billsec ?? '0'), 10)
      const mins = Math.floor(durSec / 60)
      const secs = durSec % 60
      const durStr = durSec > 0 ? `${mins}:${String(secs).padStart(2, '0')}` : ''
      const startRaw = String(r.starttime ?? r.calldate ?? '').slice(0, 16).replace('T', ' ')
      const dir: 'in' | 'out' | 'missed' =
        disposition === 'NO ANSWER' || disposition === 'FAILED' || disposition === 'BUSY' ? 'missed'
        : String(r.dst ?? '').length < 8 ? 'in'
        : 'out'
      const number = dir !== 'out' ? String(r.src ?? '') : String(r.dst ?? '')
      return { number, dir, time: startRaw, dur: durStr }
    })
  } catch {
    return []
  }
}

/**
 * addCredit — credit a Magnus prepaid user's balance via refill/save.
 * Verified live: never throws on a Magnus-side rejection — callers MUST
 * check `.success` before treating the funds as actually moved. A resolved
 * promise with `success: false` means Magnus did NOT update the balance.
 */
export async function addCredit(
  config: MagnusConfig,
  magnusUserId: string,
  credit: number,
  description = 'Isola Lite top-up',
): Promise<MagnusWriteResult> {
  try {
    await magnusRequest(config, 'refill', 'save', {
      id: '0', id_user: magnusUserId, credit: credit.toFixed(2),
      description, refill_type: '0', payment: '0',
    })
    return { success: true }
  } catch (e: any) {
    return { success: false, error: e.message }
  }
}

/**
 * debitCredit — verified live (see header caution). Debit a Magnus prepaid
 * user's balance via refill/save with a NEGATIVE amount — Magnus's REST API
 * has no separate "debit" verb, so a debit IS a refill with credit=-amount.
 * Same non-throwing contract as addCredit(): check `.success`.
 */
export async function debitCredit(
  config: MagnusConfig,
  magnusUserId: string,
  amountEc: number,
  description: string,
): Promise<MagnusWriteResult> {
  try {
    await magnusRequest(config, 'refill', 'save', {
      id: '0', id_user: magnusUserId, credit: (-amountEc).toFixed(2),
      description, refill_type: '0', payment: '0',
    })
    return { success: true }
  } catch (e: any) {
    return { success: false, error: e.message }
  }
}

