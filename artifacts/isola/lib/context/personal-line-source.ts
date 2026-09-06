/**
 * personal-line-source@1 — the Personal Line half of the Customer 360 workspace.
 *
 * dec-CC-DISPATCH-app-support-phase-B-line-context-panel-2026-09-02: a
 * Personal Line customer arrives at support as a WhatsApp phone number, not
 * an Odoo record. If they message support, the agent needs to see their
 * number, wallet balance, plan and expiry, recent calls, and whether their
 * line is active — beside whatever Odoo data (if any) also exists for them.
 *
 * NOT a BundleAdapter / bundle section. `buildContextBundle`'s adapters all
 * answer with a LIST of records (SectionResult<T[]>) — the record-list shape
 * `customer-context.ts` builds envelopes for. This is a single object with
 * its own three-way outcome (found / ambiguous / not-found), which doesn't
 * fit that shape any better than `activity` did — same reasoning, same
 * pattern: fetched here, assembled into the response by
 * `assembleCustomerContext` as its own top-level field, never squeezed into
 * `sections`.
 *
 * REUSE, NOT A NEW INTEGRATION: `engines/bff.ts::getLiteContext` +
 * `lib/engines.ts::getBffConfig` already exist for this exact bff-v2 (BFF
 * Lite, bff.epic.dm) server-to-server door — used today for mirror-account
 * and top-up. This module adds no new transport, no new secret, no new host.
 *
 * WHO THIS APPLIES TO: keyed on the customer's OWN res.partner.phone. A
 * business customer with no Personal Line subscription is the ordinary case,
 * not a failure — bff-v2 answers `{found:false}` and this reports
 * `not-a-personal-line-customer`, which the panel renders as "not shown",
 * never as "broken".
 */
import { getLiteContext, type LiteContextResult, type LitePlanSummary, type LiteRecentCallItem } from '@/engines/bff'
import { getBffConfig, isBffConfigured } from '@/lib/engines'

export const PERSONAL_LINE_SOURCE_VERSION = 'personal-line-source@1' as const

export type PersonalLineState =
  | { state: 'no-phone-on-file' }
  | { state: 'not-connected'; reason: string }
  | { state: 'unavailable'; reason: string }
  | { state: 'not-a-personal-line-customer' }
  | { state: 'ambiguous'; count: number }
  | {
      state: 'found'
      did: string | null
      status: 'active' | 'blocked' | 'unknown' | 'not_provisioned'
      balanceEc: number | null
      routingMode: 'app' | 'app_then_cell' | 'cell' | 'unknown'
      signupAt: string
      plan: LitePlanSummary | null
      recent: readonly LiteRecentCallItem[]
      recentActivityUnavailable: boolean
    }

export interface PersonalLineEnvelope {
  fetchedAt: string
  data: PersonalLineState
}

/**
 * `phone` is whatever `res.partner.phone` holds for this customer — never
 * accepted from a browser request directly; the caller (the context route)
 * already resolved it server-side from the tenant's own Odoo read.
 */
export async function readPersonalLineContext(phone: string | null): Promise<PersonalLineEnvelope> {
  const fetchedAt = new Date().toISOString()

  if (!phone || !phone.trim()) {
    return { fetchedAt, data: { state: 'no-phone-on-file' } }
  }

  if (!isBffConfigured()) {
    return {
      fetchedAt,
      data: {
        state: 'not-connected',
        reason: 'bff-v2 is not configured for this environment (BFF_BASE_URL / BFF_INTERNAL_SECRET)',
      },
    }
  }

  let result: LiteContextResult
  try {
    result = await getLiteContext(getBffConfig(), phone)
  } catch (err) {
    return {
      fetchedAt,
      data: { state: 'not-connected', reason: err instanceof Error ? err.message : 'BFF not configured' },
    }
  }

  if (!result.ok) {
    return { fetchedAt, data: { state: 'unavailable', reason: result.error } }
  }
  if (!result.found) {
    return { fetchedAt, data: { state: 'not-a-personal-line-customer' } }
  }
  if (result.ambiguous) {
    return { fetchedAt, data: { state: 'ambiguous', count: result.count } }
  }

  return {
    fetchedAt,
    data: {
      state: 'found',
      did: result.did,
      status: result.status,
      balanceEc: result.balanceEc,
      routingMode: result.routingMode,
      signupAt: result.signupAt,
      plan: result.plan,
      recent: result.recent,
      recentActivityUnavailable: result.recentActivityUnavailable,
    },
  }
}
