/**
 * odoo.ts — Portable Odoo JSON-2 transport client (Bucket 1 extraction)
 *
 * Extracted from (deepseek):
 *   /opt/bff-v2/app/lib/odoo/transport.ts   — json2Call() core (fetch path only, see CAUTION)
 *     OdooApiError    source L33-42
 *     OdooNoApiError  source L48-55
 *     fetchCall()     source L164-184  (the cloud/per-host POST path)
 *     json2Call()     source L192-226  (wired to fetchCall only — see CAUTION)
 *   /opt/bff-v2/app/lib/odoo-client.ts      — findCustomerByPhone() logic re-platformed onto json2Call
 *     CUSTOMER_FIELDS         source L3291
 *     normalizePhone()        source L3293-3295
 *     findCustomerByPhone()   source L3301-3336 (rewritten to call json2Call
 *       directly instead of the legacy /jsonrpc execute_kw path / crud.ts
 *       gate — this module has no policy-tier gate, it's a raw client)
 *
 * WHAT THIS DOES
 *   POST {url}/json/2/{model}/{method} with bearer auth + X-Odoo-Database,
 *   NAMED-args body only (Odoo saas-19.1/19.0 JSON-2 transport). Throws
 *   OdooApiError on a 4xx/5xx JSON error body, OdooNoApiError when the
 *   /json/2 route doesn't exist on this Odoo plan (Free/Standard Odoo
 *   Online — the upgrade-funnel signal). Plus findCustomerByPhone(), a
 *   res.partner search_read helper built on top of json2Call.
 *
 * CONFIG REQUIRED — OdooConfig
 *   { url, apiKey, db }
 *     url    — Odoo base URL, e.g. 'https://mytenant.odoo.com' (no trailing slash)
 *     apiKey — Odoo API key (sent as `Authorization: bearer <apiKey>`, NEVER logged)
 *     db     — Odoo database name (sent as `X-Odoo-Database`)
 *
 * CAUTION
 *   - LOCAL SELF-HOSTED ODOO CAVEAT (deliberately skipped): the source
 *     transport.ts has a SECOND code path (isLocalSelfHostedOdoo() +
 *     localHttpCall() via node:http with an explicit Host:<db> header) for
 *     Isola-hosted local Odoo containers that run `dbfilter = ^%d$` +
 *     `proxy_mode = True` and therefore select the DB from the HTTP Host
 *     header instead of X-Odoo-Database (undici/global fetch silently
 *     strips a custom Host header, so that path requires node:http). THAT
 *     PATH IS NOT INCLUDED HERE — this module only implements the CLOUD /
 *     per-host fetch path. If isola-platform ever talks to a
 *     self-hosted/local Odoo container with Host-header DB routing, you
 *     must re-add that branch (see source transport.ts L77-152) — calling
 *     json2Call() against such an instance with only this module will hit
 *     "No database is selected".
 *   - NEVER log/echo apiKey.
 *   - findCustomerByPhone() tries, in order: E.164 with implied +1 (10-digit
 *     input), bare +digits, then a last-10-digit `ilike` fallback. This
 *     ordering matches the source exactly — don't reorder without checking
 *     downstream callers that depend on the "most specific match wins"
 *     behavior.
 */

const USER_AGENT = 'Isola/1.0'

export interface OdooConfig {
  url:    string   // e.g. 'https://mytenant.odoo.com' (no trailing slash)
  apiKey: string
  db:     string
}

/** An Odoo-side error: HTTP 4xx/5xx with a JSON {name,message,...} body. */
export class OdooApiError extends Error {
  readonly httpStatus: number
  readonly odooName?: string
  readonly odooArguments?: unknown[]
  constructor(httpStatus: number, body: { name?: string; message?: string; arguments?: unknown[] }) {
    super(body?.message || body?.name || `Odoo API error (HTTP ${httpStatus})`)
    this.name = 'OdooApiError'
    this.httpStatus = httpStatus
    this.odooName = body?.name
    this.odooArguments = body?.arguments
  }
}

/**
 * The /json/2 route does not exist on this Odoo instance (Free/Standard Odoo
 * Online has no external API). Never a crash — surface upstream as an
 * upgrade-funnel signal.
 */
export class OdooNoApiError extends Error {
  readonly httpStatus: number
  constructor(httpStatus: number) {
    super('This Odoo plan does not expose the external API (/json/2). A Custom Odoo plan or Isola-hosted Odoo is required.')
    this.name = 'OdooNoApiError'
    this.httpStatus = httpStatus
  }
}

/**
 * json2Call — single JSON-2 POST. `params` is the NAMED-args object for the
 * method (e.g. { domain, fields, limit } for search_read). Throws
 * OdooApiError / OdooNoApiError; never returns an error shape.
 *
 * CLOUD / per-host Odoo only — see CAUTION above re: local self-hosted Odoo
 * with Host-header DB routing.
 */
export async function json2Call(
  config: OdooConfig,
  model: string,
  method: string,
  params: Record<string, unknown> = {},
  // Optional wall-clock guard. Omitted (default) → no timeout.
  timeoutMs?: number,
): Promise<unknown> {
  const base = config.url.replace(/\/+$/, '')
  const endpoint = `${base}/json/2/${encodeURIComponent(model)}/${encodeURIComponent(method)}`
  const payload = JSON.stringify(params ?? {})

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `bearer ${config.apiKey}`,
      'Content-Type': 'application/json; charset=utf-8',
      'X-Odoo-Database': config.db,
      'User-Agent': USER_AGENT,
    },
    body: payload,
    // Per-call transaction: each request commits on success / rolls back on error.
    cache: 'no-store',
    ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
  })

  const contentType = res.headers.get('content-type') || ''
  const text = await res.text()

  // No-external-API detection: the /json/2 route is absent on Free/Standard
  // Odoo Online → server returns a non-JSON (HTML) 404 / route-not-found.
  if (!contentType.includes('application/json')) {
    if (res.status === 404 || res.status === 405 || res.status >= 500) {
      throw new OdooNoApiError(res.status)
    }
    // Unexpected non-JSON on a 2xx is also treated as no-API rather than a crash.
    if (res.status >= 200 && res.status < 300) {
      throw new OdooNoApiError(res.status)
    }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    // Body wasn't JSON at all → treat as no external API.
    throw new OdooNoApiError(res.status)
  }

  if (!(res.status >= 200 && res.status < 300)) {
    const errBody = (parsed && typeof parsed === 'object' ? parsed : {}) as {
      name?: string
      message?: string
      arguments?: unknown[]
    }
    throw new OdooApiError(res.status, errBody)
  }

  return parsed
}

export interface OdooCustomer {
  id: number
  name: string
  email: string | null
  phone: string | null
  phone_sanitized: string | null
  street: string | null
  city: string | null
  is_company: boolean
}

const CUSTOMER_FIELDS = ['id', 'name', 'email', 'phone', 'phone_sanitized', 'street', 'city', 'is_company']

function normalizePhone(raw: string): string {
  return raw.replace(/[^\d]/g, '')
}

/**
 * findCustomerByPhone — res.partner lookup by phone, via search_read over
 * json2Call. Tries (in order): 10-digit input as +1XXXXXXXXXX, bare
 * +digits, a last-10-digit `phone_sanitized ilike` fallback, and finally a
 * raw-`phone` fallback for numbers `phone_sanitized` never populates for.
 * Returns null if the number is too short (<7 digits) or no match is found.
 *
 * THE RAW-PHONE FALLBACK, WHY IT EXISTS (def-odoo-phone-sanitized-false-
 * for-767818-range). Odoo computes `phone_sanitized` from `phone`, and for
 * the entire 767-818 exchange (Dominica) that computation returns the
 * BOOLEAN `false`, not a phone string -- confirmed live, not assumed. Both
 * stages above filter on `phone_sanitized`, so for every customer in that
 * exchange they search a field that is never a phone string, and always
 * return nothing regardless of whether the customer exists. This third
 * stage searches the raw `phone` field instead, so those customers become
 * resolvable at all.
 *
 * REFUSE-ON-AMBIGUITY, UNCHANGED. This fallback must not weaken the rule
 * it inherits: `ilike` on the raw field cannot itself prove a match, since
 * `phone` is free-text and may carry separators an unformatted digit
 * pattern cannot reliably substring-match position-for-position. So the
 * ilike search only gathers CANDIDATES (on the last 4 digits, a substring
 * essentially every real formatting style leaves contiguous); each
 * candidate's own `phone` is then normalized and compared in full against
 * the target's last 10 digits. Exactly one strict match resolves; zero
 * means genuinely not found; MORE than one is refused, not guessed --
 * the same shape as the phone_sanitized stages' own ambiguity refusal,
 * applied honestly to a field this function does not otherwise trust.
 */
export async function findCustomerByPhone(config: OdooConfig, phone: string): Promise<OdooCustomer | null> {
  const digits = normalizePhone(phone)
  if (digits.length < 7) return null

  const e164Candidates = [
    digits.length === 10 ? `+1${digits}` : `+${digits}`,
    `+${digits}`,
  ]

  for (const candidate of e164Candidates) {
    const rows = (await json2Call(config, 'res.partner', 'search_read', {
      domain: [['phone_sanitized', '=', candidate]],
      fields: CUSTOMER_FIELDS,
      limit: 1,
    }).catch(() => [])) as OdooCustomer[]
    if (rows && rows.length > 0) return rows[0]
  }

  const last10 = digits.slice(-10)
  const byIlike = (await json2Call(config, 'res.partner', 'search_read', {
    domain: [['phone_sanitized', 'ilike', last10]],
    fields: CUSTOMER_FIELDS,
    limit: 1,
  }).catch(() => [])) as OdooCustomer[]
  if (byIlike && byIlike.length > 0) return byIlike[0]

  const last4 = last10.slice(-4)
  const rawCandidates = (await json2Call(config, 'res.partner', 'search_read', {
    domain: [['phone', 'ilike', last4]],
    fields: CUSTOMER_FIELDS,
    limit: 20,
  }).catch(() => [])) as OdooCustomer[]

  const strictMatches = (rawCandidates ?? []).filter(
    (row) => row.phone && normalizePhone(row.phone).endsWith(last10),
  )
  return strictMatches.length === 1 ? strictMatches[0] : null
}

// ── Marketing / CRM funnel (P6 — EMA landing page) ──────────────────────────
// Added for the public landing page's UTM-attribution funnel. Uses the same
// raw json2Call transport; no policy/gate layer here either (see module
// header) — callers are responsible for deciding when to invoke this.

/**
 * find-or-create a utm.source / utm.medium / utm.campaign record by name.
 * Odoo's JSON-2 `create` expects a `vals_list` array of dicts and returns an
 * array of created ids (verified live against this project's Odoo instance).
 * Returns null if `name` is empty/falsy — callers should treat that as "no
 * UTM value supplied", not an error.
 */
export async function findOrCreateUtmRecord(
  config: OdooConfig,
  model: 'utm.source' | 'utm.medium' | 'utm.campaign',
  name: string | null | undefined,
): Promise<number | null> {
  if (!name || !name.trim()) return null
  const trimmed = name.trim()

  const existing = (await json2Call(config, model, 'search_read', {
    domain: [['name', '=', trimmed]],
    fields: ['id'],
    limit: 1,
  }).catch(() => [])) as { id: number }[]
  if (existing && existing.length > 0) return existing[0].id

  const created = (await json2Call(config, model, 'create', {
    vals_list: [{ name: trimmed }],
  }).catch(() => null)) as number[] | null
  return created && created.length > 0 ? created[0] : null
}

// ── Work-queue task lookup (IL-1 workspace work-queue) ──────────────────────
// A tenant may have its own Odoo instance via OdooBinding (see
// lib/connector.ts resolveConfig / lib/engine-bindings.ts — S2), or fall
// through to the platform-default env config; either way there is still no
// tenant dimension on project.task itself to filter by. Callers must always
// scope by assignee, never "all tasks", or they will leak another tenant's
// (or another Odoo instance's) data.

export interface OdooTask {
  id: number
  name: string
  projectName: string | null
  stageName: string | null
  priority: string | null
  dateDeadline: string | null
}

interface OdooTaskRow {
  id: number
  name: string
  project_id: unknown
  stage_id: unknown
  priority: string | null
  date_deadline: string | null
}

/** Odoo many2one fields come back as either an [id, name] tuple (classic) or
 *  an {id, display_name} object (JSON-2) depending on server version. */
function displayNameOf(value: unknown): string | null {
  if (!value) return null
  if (Array.isArray(value)) return typeof value[1] === 'string' ? value[1] : null
  if (typeof value === 'object' && 'display_name' in (value as Record<string, unknown>)) {
    const v = (value as { display_name?: unknown }).display_name
    return typeof v === 'string' ? v : null
  }
  return null
}

/**
 * findOpenTasksByAssignee — project.task search_read filtered to active
 * tasks assigned to `assigneeEmail`, soonest-deadline first. Odoo 17+ uses
 * the many2many `user_ids` field for task assignees (multiple assignees per
 * task); matched via `user_ids.login` since Isola has no local Odoo-user-id
 * mapping, only the signed-in person's email. Returns [] on any failure —
 * callers treat Odoo as best-effort and must not let a queue page 500 just
 * because Odoo is unreachable.
 */
export async function findOpenTasksByAssignee(
  config: OdooConfig,
  assigneeEmail: string,
  limit = 25,
): Promise<OdooTask[]> {
  const rows = (await json2Call(config, 'project.task', 'search_read', {
    domain: [['user_ids.login', '=', assigneeEmail], ['active', '=', true]],
    fields: ['id', 'name', 'project_id', 'stage_id', 'priority', 'date_deadline'],
    order: 'date_deadline asc, priority desc',
    limit,
  }, 10000).catch(() => [])) as OdooTaskRow[]

  return (rows ?? []).map((r) => ({
    id: r.id,
    name: r.name,
    projectName: displayNameOf(r.project_id),
    stageName: displayNameOf(r.stage_id),
    priority: r.priority ?? null,
    dateDeadline: r.date_deadline ?? null,
  }))
}

export interface CrmLeadInput {
  name: string // opportunity/lead title
  contactName?: string
  phone?: string
  utmSource?: string
  utmMedium?: string
  utmCampaign?: string
  description?: string
}

/**
 * Creates a crm.lead (type: 'lead') in Odoo, resolving/creating the
 * utm.source / utm.medium / utm.campaign records by name first. Returns the
 * new lead's id, or null if the create call failed (never throws — callers
 * treat Odoo as best-effort and always keep their own local record too).
 */
export async function createCrmLead(config: OdooConfig, input: CrmLeadInput): Promise<number | null> {
  try {
    const [sourceId, mediumId, campaignId] = await Promise.all([
      findOrCreateUtmRecord(config, 'utm.source', input.utmSource),
      findOrCreateUtmRecord(config, 'utm.medium', input.utmMedium),
      findOrCreateUtmRecord(config, 'utm.campaign', input.utmCampaign),
    ])

    const vals: Record<string, unknown> = {
      name: input.name,
      type: 'lead',
    }
    if (input.contactName) vals.contact_name = input.contactName
    if (input.phone) vals.phone = input.phone
    if (input.description) vals.description = input.description
    if (sourceId) vals.source_id = sourceId
    if (mediumId) vals.medium_id = mediumId
    if (campaignId) vals.campaign_id = campaignId

    const created = (await json2Call(config, 'crm.lead', 'create', {
      vals_list: [vals],
    })) as number[]
    return created && created.length > 0 ? created[0] : null
  } catch {
    return null
  }
}

