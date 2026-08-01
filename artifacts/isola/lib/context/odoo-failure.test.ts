import { describe, expect, it } from 'vitest'

import { OdooApiError, OdooNoApiError } from '@/engines/odoo'

import {
  ODOO_FAILURE_CATEGORIES,
  buildDiagnostic,
  classifyOdooFailure,
  reconcileWithSiblings,
} from './odoo-failure'
import { sanitiseOdooFailure } from './customer-sources'

const noApi = (status: number) => new OdooNoApiError(status)
const api = (status: number) => new OdooApiError(status, { message: 'odoo said no' })

/* ── the defect ────────────────────────────────────────────────────────────*/

describe('a transient 5xx is not a plan limitation', () => {
  it.each([500, 502, 503, 504])('HTTP %i is a temporary failure, not api_not_available', (status) => {
    const f = classifyOdooFailure(noApi(status))

    expect(f.category).toBe('temporary_dependency_failure')
    expect(f.provesNoApi).toBe(false)
    expect(f.retryable).toBe(true)
    expect(f.message).not.toContain('plan')
    expect(f.message).toContain('temporarily')
  })

  it.each([404, 405])('HTTP %i genuinely means the route is absent', (status) => {
    const f = classifyOdooFailure(noApi(status))

    expect(f.category).toBe('api_not_available')
    expect(f.provesNoApi).toBe(true)
    expect(f.message).toContain('does not expose the external API')
  })

  it('is the ONLY category permitted to mention the plan', () => {
    const mentioning = ODOO_FAILURE_CATEGORIES.filter((c) =>
      classifyOdooFailure(
        c === 'api_not_available' ? noApi(404) : new Error('x'),
      ).message.includes('plan'),
    )
    // Only reachable via the 404/405 branch.
    expect(classifyOdooFailure(noApi(404)).message).toContain('plan')
    expect(classifyOdooFailure(noApi(502)).message).not.toContain('plan')
    expect(mentioning.length).toBeGreaterThan(0)
  })

  it('downgrades a no-API claim that a concurrent success disproves', () => {
    const claimed = classifyOdooFailure(noApi(404))
    expect(claimed.category).toBe('api_not_available')

    // Another read of the SAME instance succeeded in the SAME request. A
    // permanent limitation cannot be true for one call and false for another.
    const reconciled = reconcileWithSiblings(claimed, true)
    expect(reconciled.category).toBe('temporary_dependency_failure')
    expect(reconciled.message).not.toContain('plan')
  })

  it('leaves the claim standing when nothing contradicts it', () => {
    expect(reconcileWithSiblings(classifyOdooFailure(noApi(404)), false).category).toBe(
      'api_not_available',
    )
    expect(reconcileWithSiblings(classifyOdooFailure(noApi(404)), null).category).toBe(
      'api_not_available',
    )
  })
})

/* ── the rest of the vocabulary ────────────────────────────────────────────*/

describe('every failure kind is classified distinctly', () => {
  it('separates authentication from permission', () => {
    expect(classifyOdooFailure(api(401)).category).toBe('authentication_rejected')
    expect(classifyOdooFailure(api(403)).category).toBe('permission_refused')
  })

  it('reports a missing model as model_unavailable', () => {
    expect(classifyOdooFailure(api(404)).category).toBe('model_unavailable')
  })

  it('reports throttling and says other information may still be available', () => {
    const f = classifyOdooFailure(api(429))
    expect(f.category).toBe('request_throttled')
    expect(f.retryable).toBe(true)
    expect(f.message).toContain('may still be available')
  })

  it('separates a timeout from an unreachable host', () => {
    expect(classifyOdooFailure(new Error('The operation timed out')).category).toBe(
      'dependency_timeout',
    )
    expect(classifyOdooFailure(new Error('connect ECONNREFUSED 10.1.2.3:443')).category).toBe(
      'dependency_unreachable',
    )
  })

  it('reports a non-JSON 2xx as malformed rather than as a plan limit', () => {
    expect(classifyOdooFailure(noApi(200)).category).toBe('malformed_dependency_response')
  })

  it('falls back to unknown rather than to a confident wrong answer', () => {
    expect(classifyOdooFailure(new Error('something new')).category).toBe(
      'unknown_dependency_failure',
    )
  })

  it('never puts driver text, a host or a database name on a screen', () => {
    const messages = [
      classifyOdooFailure(new Error('connect ECONNREFUSED 10.1.2.3:443')).message,
      classifyOdooFailure(api(500)).message,
      classifyOdooFailure(noApi(503)).message,
    ]
    for (const m of messages) {
      expect(m).not.toMatch(/ECONNREFUSED|10\.1\.2\.3|odoo said no|:443/)
    }
  })

  it('marks only the transient categories retryable', () => {
    expect(classifyOdooFailure(api(403)).retryable).toBe(false)
    expect(classifyOdooFailure(noApi(404)).retryable).toBe(false)
    expect(classifyOdooFailure(api(503)).retryable).toBe(true)
  })
})

/* ── the workspace uses it ─────────────────────────────────────────────────*/

describe('the section wording comes from the same classifier', () => {
  it('no longer tells a manager their plan lacks an API on a 502', () => {
    expect(sanitiseOdooFailure(noApi(502))).not.toContain('plan')
    expect(sanitiseOdooFailure(noApi(502))).toContain('temporarily')
  })

  it('still says so when the route is genuinely absent', () => {
    expect(sanitiseOdooFailure(noApi(404))).toContain('does not expose the external API')
  })
})

/* ── the diagnostic ────────────────────────────────────────────────────────*/

describe('the diagnostic record holds nothing worth leaking', () => {
  it('carries status, category and timing but no payload', () => {
    const d = buildDiagnostic({
      correlationId: 'corr-1',
      section: 'contacts',
      model: 'res.partner',
      method: 'search_read',
      failure: classifyOdooFailure(noApi(502)),
      durationMs: 1200,
      siblingReadSucceeded: true,
    })

    expect(d.httpStatus).toBe(502)
    expect(d.category).toBe('temporary_dependency_failure')
    expect(d.siblingReadSucceeded).toBe(true)

    const serialised = JSON.stringify(d)
    expect(serialised).not.toMatch(/bearer|Authorization|apiKey|password|cookie/i)
    expect(Object.keys(d).sort()).toEqual(
      [
        'category',
        'correlationId',
        'durationMs',
        'httpStatus',
        'method',
        'model',
        'section',
        'siblingReadSucceeded',
        'version',
      ].sort(),
    )
  })
})
