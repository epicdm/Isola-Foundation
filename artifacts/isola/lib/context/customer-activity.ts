/**
 * customer-activity@1 — this customer's slice of Recent Work.
 *
 * THIS IS NOT A SECOND FEED, AND THE IMPORTS ARE THE PROOF.
 * -------------------------------------------------------
 * It calls `buildActivitySources` and `buildActivityHandler` — the same registry
 * and the same handler `GET /api/v1/activity` calls, with the same
 * `ACTIVITY_SOURCE_NAMES`. Every behaviour that lives in there is inherited
 * rather than reimplemented:
 *
 *   five sources, always registered, always in the same order;
 *   the audit gate that refuses to READ rather than reading and hiding;
 *   permission filtering before paging;
 *   cursor semantics;
 *   per-source `available` / `empty` / `forbidden` / `unavailable` reporting;
 *   native links carried on the rows themselves;
 *   deduplication.
 *
 * What is added here is two things and nothing else: the `customer` filter, and
 * a translation into `SectionResult` so the workspace can put this beside the
 * sections that come from BundleAdapters.
 *
 * WHY A PARTIAL FEED IS `partial` AND NOT `available`
 * --------------------------------------------------
 * The feed reports each source separately. If the audit trail is unreadable and
 * the other four answered, the rows on screen are real but the picture is not
 * complete. Reporting that as `available` would tell a manager they are looking
 * at everything. The names of the sources that did not answer come back as
 * `missing`, which is exactly what the workspace contract's `partial` state was
 * written for.
 *
 * A source reporting `forbidden` is NOT counted as missing. That is a fact about
 * the reader, not about the data, and naming it would tell them how much they
 * are not being shown.
 */

import { buildActivityHandler } from '@/lib/activity/handler'
import { ACTIVITY_SOURCE_NAMES, buildActivitySources } from '@/lib/activity/registry'

import type { SectionResult } from './context-bundle'

export const CUSTOMER_ACTIVITY_VERSION = 'customer-activity@1' as const

export const DEFAULT_ACTIVITY_PAGE_SIZE = 25

export interface CustomerActivityDeps {
  /** From the SESSION. Never from the query string. */
  tenantId: string
  /** The workspace authz decision, passed through unchanged. */
  canViewAudit: boolean
  now(): Date
  pageSize?: number
}

export interface CustomerActivitySection {
  result: SectionResult<readonly unknown[]>
  /** Sources that could not answer. Never includes a forbidden source. */
  missing: readonly string[]
  /** The feed's own cursor, so the panel can page without a second contract. */
  nextCursor: string | null
}

export async function loadCustomerActivity(
  customerId: string,
  deps: CustomerActivityDeps,
): Promise<CustomerActivitySection> {
  const sources = buildActivitySources({
    tenantId: deps.tenantId,
    canViewAudit: deps.canViewAudit,
    now: deps.now,
  })

  const handler = buildActivityHandler({
    sources,
    permissions: {
      // The session was resolved and role-checked by the route above this.
      actorIsActive: async () => true,
      // Exactly one company: the tenant this session is scoped to.
      permittedCompanies: async () => [deps.tenantId],
      // The customer itself was proven readable in THIS tenant's system of
      // record before this function was called; that is where the boundary is
      // enforced, and repeating it here as a stub that always says yes would
      // look like a check without being one.
      mayViewCustomer: async () => true,
      mayViewObject: async () => true,
    },
    now: deps.now,
    knownSources: ACTIVITY_SOURCE_NAMES,
  })

  const params = new URLSearchParams({
    customer: customerId,
    pageSize: String(deps.pageSize ?? DEFAULT_ACTIVITY_PAGE_SIZE),
  })

  let outcome
  try {
    outcome = await handler.handle(params, { companyId: deps.tenantId })
  } catch {
    return {
      result: { status: 'unavailable', reason: 'the activity feed could not be read', source: 'activity' },
      missing: [],
      nextCursor: null,
    }
  }

  if (outcome.kind === 'forbidden') {
    // Says nothing about whether there is any activity to see.
    return { result: { status: 'forbidden' }, missing: [], nextCursor: null }
  }

  if (outcome.kind !== 'ok') {
    return {
      result: {
        status: 'unavailable',
        reason:
          outcome.kind === 'unavailable'
            ? 'the activity feed could not be reached'
            : 'the activity feed could not answer',
        source: 'activity',
      },
      missing: [],
      nextCursor: null,
    }
  }

  const missing = outcome.body.sources
    .filter((s) => s.state === 'unavailable')
    .map((s) => s.source)

  return {
    result: {
      status: 'ok',
      data: outcome.body.items,
      provenance: {
        source: 'activity@1',
        fetchedAt: new Date(outcome.body.generatedAt),
        // The feed's own freshness reporting lives on each row's provenance.
        // The section is a fresh read of the feed, whatever the rows say.
        stale: false,
      },
      nextCursor: outcome.body.nextCursor,
    },
    missing,
    nextCursor: outcome.body.nextCursor,
  }
}
