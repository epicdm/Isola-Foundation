/**
 * fiserv.ts — Portable Fiserv payment-charge client (Bucket 1 extraction)
 *
 * Extracted from (deepseek): /opt/bff-v2/app/lib/payments/fiserv.ts (full file)
 *   fiservCharge() → renamed charge(config, input)
 *
 * WHAT THIS DOES
 *   POSTs a card charge to the EPIC Fiserv gateway wrapper endpoint
 *   (`{baseUrl}/v1/payments/fiserv/charge`) and validates the response with
 *   the hard-won success rule: HTTP ok AND an approved-or-absent status AND
 *   a non-empty transaction ref. HTTP 200 alone is NOT proof of a successful
 *   charge (see CAUTION).
 *
 * CONFIG REQUIRED — FiservConfig
 *   { apiKey, baseUrl }
 *     apiKey  — Fiserv wrapper API key (sent as the X-API-Key header, never logged)
 *     baseUrl — optional, defaults to 'https://api01.epic.dm'
 *
 * CAUTION
 *   - FISERV_CHARGE_ENABLED gating (a disabled-by-default kill switch) lived
 *     in the ORIGINAL source as a hard guard inside this function. That gate
 *     has been REMOVED from this module — gating is now the CALLING APP's
 *     responsibility (e.g. check your own feature flag / config BEFORE
 *     calling charge()). This module attempts a real charge every time it is
 *     invoked.
 *   - Incident 2026-07-07T00:15Z (source system): the gateway returned HTTP
 *     200 with {"status":"declined"} and no ref. res.ok is NOT sufficient
 *     proof of success — do not weaken isDeclineishStatus()/the ref
 *     requirement below.
 *   - PAN/CVV/apiKey are NEVER logged, echoed, stored, or returned by this
 *     module. Preserve the redact() logic if you add any new log line.
 *   - No card-entry UI here — that remains a separate, PCI-scoped decision
 *     for the calling app.
 */

export interface FiservConfig {
  apiKey: string
  baseUrl?: string   // defaults to 'https://api01.epic.dm'
}

export interface FiservChargeInput {
  cardNumber:    string
  expMonth:      string   // "MM" e.g. "04"
  expYear:       string   // "YYYY" e.g. "2027"
  cvv:           string
  amount:        number   // in major currency units (e.g. 25.00)
  currency:      string   // "USD" | "XCD" | a 3-digit ISO-4217 numeric code
  payerName:     string
  payerEmail:    string
  payerAddress:  string
}

export interface FiservChargeResult {
  ok:       boolean
  disabled?: boolean
  ref?:     string     // transaction reference from Fiserv (never a PAN)
  status?:  string     // e.g. "APPROVED" | "DECLINED"
  error?:   string     // plain-English, no sensitive data
}

const DEFAULT_BASE_URL = 'https://api01.epic.dm'

// Statuses that count as a genuine, successful charge. Anything else present
// in the `status` field — or nothing at all when `ref` is also missing — is
// treated as a decline/failure. Case-insensitive match.
const APPROVED_STATUSES = new Set([
  'approved',
  'success',
  'succeeded',
  'ok',
  'captured',
  'completed',
  'paid',
])

/**
 * True when `status` is present and is NOT one of the approved values above —
 * i.e. the gateway told us explicitly that the charge did not succeed
 * (e.g. "declined", "failed", "error", "denied"), even though HTTP itself
 * returned 200.
 */
function isDeclineishStatus(status: string | undefined): boolean {
  if (!status) return false
  return !APPROVED_STATUSES.has(status.trim().toLowerCase())
}

/**
 * Redacts PAN-shaped digit runs and obvious card JSON fields from a string
 * before it touches any log sink. Applied to raw response bodies only.
 * NEVER applied to inputs (inputs are not logged at all).
 */
function redact(s: string): string {
  return s
    // Replace any 13-19 consecutive digit run (PAN-shaped) with a placeholder
    .replace(/\b\d{13,19}\b/g, '[redacted-pan]')
    // Blank the value of "cardNumber" JSON fields (any casing)
    .replace(/"cardNumber"\s*:\s*"[^"]*"/gi, '"cardNumber":"[redacted]"')
    // Blank the value of "cvv" JSON fields (any casing)
    .replace(/"cvv"\s*:\s*"[^"]*"/gi, '"cvv":"[redacted]"')
}

export async function charge(config: FiservConfig, input: FiservChargeInput): Promise<FiservChargeResult> {
  if (!config.apiKey) {
    return {
      ok:    false,
      error: 'Fiserv not configured (apiKey missing).',
    }
  }

  // ── Normalise currency to ISO-4217 numeric (Fiserv wrapper requirement) ─────
  // The wrapper rejects alphabetic codes; map USD→840 and XCD→951.
  const FISERV_CURRENCY: Record<string, string> = { USD: '840', XCD: '951' }
  const currencyUpper  = input.currency.toUpperCase()
  let numericCurrency: string
  if (FISERV_CURRENCY[currencyUpper]) {
    numericCurrency = FISERV_CURRENCY[currencyUpper]
  } else if (/^\d{3}$/.test(input.currency)) {
    // Already a 3-digit numeric string — pass through unchanged
    numericCurrency = input.currency
  } else {
    return {
      ok:    false,
      error: `Unsupported currency "${input.currency}" (expected USD or XCD).`,
    }
  }

  const endpoint = `${(config.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '')}/v1/payments/fiserv/charge`

  // ── POST to EPIC Fiserv endpoint ────────────────────────────────────────────
  // NOTE: PAN/CVV are sent to the endpoint but never appear in logs or return values.
  let res: Response
  try {
    res = await fetch(endpoint, {
      method:  'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key':    config.apiKey,  // key goes in header only, never logged
      },
      body: JSON.stringify({
        cardNumber:   input.cardNumber,
        expMonth:     input.expMonth,
        expYear:      input.expYear,
        cvv:          input.cvv,
        amount:       input.amount,
        currency:     numericCurrency,
        payerName:    input.payerName,
        payerEmail:   input.payerEmail,
        payerAddress: input.payerAddress,
      }),
      signal: AbortSignal.timeout(30_000),
    })
  } catch (e) {
    // Network error — no sensitive data in message
    const detail = e instanceof Error ? e.message : 'network error'
    // Deliberately NOT logging the full error to avoid any accidental PAN leakage
    // from exception message interpolation
    console.error('[fiserv] network error reaching charge endpoint:', detail)
    return { ok: false, error: `Fiserv endpoint unreachable: ${detail}` }
  }

  // ── Parse response as text first, then attempt JSON ─────────────────────────
  // Reading as text first means we never fail silently when Fiserv returns
  // a non-JSON error body (HTML gateway errors, plain-text declines, etc.).
  const raw = await res.text()
  let body: Record<string, unknown> = {}
  try {
    body = JSON.parse(raw) as Record<string, unknown>
  } catch {
    // Not JSON — body stays {}; raw will be used for diagnostics below
  }

  // Extract ref + status — these are transaction identifiers, never PANs
  const ref    = typeof body.ref           === 'string' ? body.ref           :
                 typeof body.transactionId  === 'string' ? body.transactionId :
                 typeof body.id             === 'string' ? body.id            : undefined
  const status = typeof body.status === 'string' ? body.status : undefined

  if (!res.ok) {
    // Log the full (redacted) response body so operator logs capture the real Fiserv reason
    console.error('[fiserv] charge rejected HTTP', res.status, redact(raw).slice(0, 500))

    // Pull the best available operator-facing reason from the parsed body,
    // trying progressively less specific fields before falling back to raw snippet.
    const firstArrayMsg = (() => {
      if (!Array.isArray(body.errors) || body.errors.length === 0) return undefined
      const e0 = body.errors[0] as Record<string, unknown>
      if (typeof e0.message === 'string') return e0.message
      if (typeof e0.detail  === 'string') return e0.detail
      return undefined
    })()

    const msg =
      (typeof body.message === 'string' && body.message) ||
      (typeof body.error   === 'string' && body.error)   ||
      (typeof body.detail  === 'string' && body.detail)  ||
      (typeof body.title   === 'string' && body.title)   ||
      firstArrayMsg ||
      // Short redacted snippet of raw body — gives the operator actual Fiserv text
      (raw.trim().length > 0
        ? `Fiserv error: ${redact(raw).trim().slice(0, 200)}`
        : `Fiserv returned HTTP ${res.status}.`)

    return { ok: false, ref, status, error: msg }
  }

  // ── HTTP 200 does NOT mean the charge succeeded ─────────────────────────────
  // res.ok alone is not sufficient proof of a successful charge — validate the
  // reported status and require a ref.
  const declineish = isDeclineishStatus(status)
  if (declineish || !ref) {
    console.error(
      '[fiserv] HTTP 200 but not a genuine approval — status:', status ?? '(none)',
      'ref:', ref ? 'present' : '(missing)',
    )
    return {
      ok:     false,
      ref,
      status,
      error: status
        ? `Card ${status}.`
        : 'No transaction reference returned — treating as failed.',
    }
  }

  return { ok: true, ref, status }
}

