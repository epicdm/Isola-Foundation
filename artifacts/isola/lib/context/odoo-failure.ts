/**
 * odoo-failure@1 — what actually went wrong, and what a reader should be told.
 *
 * THE DEFECT THIS EXISTS TO CLOSE
 * ------------------------------
 * Production, 2026-08-01, three reads of the same customer seconds apart:
 *
 *   21:41:16   contacts UNAVAILABLE      opportunities ok
 *   21:41:57   contacts ok               opportunities UNAVAILABLE
 *   21:42:44   contacts ok               opportunities UNAVAILABLE
 *
 * The failure moved between models, so it was never about a model. Both
 * failures were reported as:
 *
 *   "this Odoo plan does not expose the external API, so it cannot be read"
 *
 * which is a permanent condition, stated with confidence, and disproved by the
 * three concurrent reads that succeeded against the same instance in the same
 * request. An operator reading it would go and price an Odoo plan upgrade.
 *
 * WHERE IT COMES FROM
 * ------------------
 * `engines/odoo.ts::json2Call` throws `OdooNoApiError` when the response is not
 * JSON and the status is 404, 405 **or >= 500**:
 *
 *   if (!contentType.includes('application/json')) {
 *     if (res.status === 404 || res.status === 405 || res.status >= 500) {
 *       throw new OdooNoApiError(res.status)
 *     }
 *
 * For 404/405 that is right: Free and Standard Odoo Online genuinely have no
 * `/json/2` route and answer with an HTML not-found. For a 5xx it is exactly
 * backwards — an HTML 502 from odoo.com means the route exists and the server
 * is briefly unwell. Grouping them makes a transient outage indistinguishable
 * from a permanent plan limitation, and only the permanent wording survives.
 *
 * WHY THE FIX IS HERE AND NOT IN THE ENGINE
 * ----------------------------------------
 * `OdooNoApiError` already carries `httpStatus`, so the distinction is fully
 * recoverable at this boundary. Changing the throw in `engines/odoo.ts` would
 * alter behaviour for `lib/customer-tools/**`, `lib/agent-tools.ts` and
 * `app/api/crm/customer` — a much wider blast radius than a launch release
 * should take for a wording defect. The engine-level correction is recorded as
 * the follow-up; this module makes the screen honest today.
 */

import { OdooApiError, OdooNoApiError } from '@/engines/odoo'

export const ODOO_FAILURE_VERSION = 'odoo-failure@1' as const

/**
 * Every way a bounded Odoo read can fail. Deliberately granular: the whole
 * point is that "we cannot reach it right now" and "this account cannot do this
 * at all" lead an operator to completely different actions.
 */
export const ODOO_FAILURE_CATEGORIES = [
  'api_not_available',
  'authentication_rejected',
  'permission_refused',
  'model_unavailable',
  'request_throttled',
  'dependency_timeout',
  'dependency_unreachable',
  'malformed_dependency_response',
  'temporary_dependency_failure',
  'unknown_dependency_failure',
] as const
export type OdooFailureCategory = (typeof ODOO_FAILURE_CATEGORIES)[number]

export interface OdooFailure {
  category: OdooFailureCategory
  /** Safe for a screen. Never a hostname, a database name or driver text. */
  message: string
  /** True when retrying this exact read is a sensible thing to do. */
  retryable: boolean
  /** True only when the response actually proves the plan has no external API. */
  provesNoApi: boolean
  /** Sanitised, for the diagnostic record. Never part of the screen message. */
  httpStatus: number | null
}

const MESSAGE: Readonly<Record<OdooFailureCategory, string>> = {
  // The ONLY message that may mention the plan. It is a claim about the
  // account, and it is made only when the response proves it.
  api_not_available:
    'this Odoo plan does not expose the external API, so it cannot be read',
  authentication_rejected: 'the source did not accept our credentials',
  permission_refused: 'the source refused the read',
  model_unavailable: 'the source does not have this record type',
  request_throttled:
    'Odoo asked us to slow down, so this read was not completed. Other customer information may still be available. Retry this section.',
  dependency_timeout: 'the source did not answer in time',
  dependency_unreachable: 'the source could not be reached',
  malformed_dependency_response:
    'the source answered with something we could not read',
  temporary_dependency_failure:
    'Odoo temporarily could not complete this read. Other customer information may still be available. Retry this section.',
  unknown_dependency_failure: 'the source failed to answer',
}

const RETRYABLE: readonly OdooFailureCategory[] = [
  'request_throttled',
  'dependency_timeout',
  'dependency_unreachable',
  'temporary_dependency_failure',
]

function build(category: OdooFailureCategory, httpStatus: number | null): OdooFailure {
  return {
    category,
    message: MESSAGE[category],
    retryable: RETRYABLE.includes(category),
    provesNoApi: category === 'api_not_available',
    httpStatus,
  }
}

/**
 * Classify a thrown Odoo error.
 *
 * The `OdooNoApiError` branch is the one that matters. That class is thrown for
 * three quite different situations and only the first is permanent:
 *
 *   404 / 405  the /json/2 route is genuinely absent  → api_not_available
 *   >= 500     an HTML error page from a busy server  → temporary_dependency_failure
 *   2xx        a non-JSON body on a success status    → malformed_dependency_response
 */
export function classifyOdooFailure(err: unknown): OdooFailure {
  if (err instanceof OdooNoApiError) {
    const status = err.httpStatus
    if (status === 404 || status === 405) return build('api_not_available', status)
    if (status >= 500) return build('temporary_dependency_failure', status)
    if (status === 429) return build('request_throttled', status)
    return build('malformed_dependency_response', status)
  }

  if (err instanceof OdooApiError) {
    const status = err.httpStatus
    if (status === 401) return build('authentication_rejected', status)
    if (status === 403) return build('permission_refused', status)
    if (status === 404) return build('model_unavailable', status)
    if (status === 429) return build('request_throttled', status)
    if (status >= 500) return build('temporary_dependency_failure', status)
    return build('unknown_dependency_failure', status)
  }

  const raw = err instanceof Error ? err.message : String(err)
  if (/timeout|timed out|abort/i.test(raw)) return build('dependency_timeout', null)
  if (/ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|socket|fetch failed/i.test(raw)) {
    return build('dependency_unreachable', null)
  }
  return build('unknown_dependency_failure', null)
}

/* ── the diagnostic record ─────────────────────────────────────────────────*/

/**
 * What we are willing to write down about a failure.
 *
 * Everything here is either a status code, a category we assigned, a model and
 * method fixed in our own code, or a duration. No credential, no header, no
 * request body, no response body, no customer field. The point is to be able to
 * classify the next occurrence without ever holding anything worth leaking.
 */
export interface OdooFailureDiagnostic {
  version: typeof ODOO_FAILURE_VERSION
  correlationId: string
  section: string
  model: string
  method: string
  category: OdooFailureCategory
  httpStatus: number | null
  durationMs: number
  /**
   * The fact that settles the plan question. If another read of the SAME
   * instance succeeded in the SAME context request, a permanent plan
   * limitation is definitively not the explanation.
   */
  siblingReadSucceeded: boolean | null
}

export function buildDiagnostic(input: {
  correlationId: string
  section: string
  model: string
  method: string
  failure: OdooFailure
  durationMs: number
  siblingReadSucceeded: boolean | null
}): OdooFailureDiagnostic {
  return {
    version: ODOO_FAILURE_VERSION,
    correlationId: input.correlationId,
    section: input.section,
    model: input.model,
    method: input.method,
    category: input.failure.category,
    httpStatus: input.failure.httpStatus,
    durationMs: input.durationMs,
    siblingReadSucceeded: input.siblingReadSucceeded,
  }
}

/**
 * A claim of `api_not_available` is contradicted by any concurrent success
 * against the same instance. When that happens the diagnostic says so, and the
 * category is downgraded to the transient one — because a permanent limitation
 * cannot be true for one read and false for another at the same moment.
 */
export function reconcileWithSiblings(
  failure: OdooFailure,
  siblingReadSucceeded: boolean | null,
): OdooFailure {
  if (failure.category === 'api_not_available' && siblingReadSucceeded === true) {
    return build('temporary_dependency_failure', failure.httpStatus)
  }
  return failure
}
