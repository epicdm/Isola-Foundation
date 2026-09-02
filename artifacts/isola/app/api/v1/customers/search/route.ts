/**
 * GET /api/v1/customers/search?q=<term>
 *
 * Finds customers so a staff member can open the authoritative workspace. It
 * returns the minimum needed to choose between results and nothing more — the
 * workspace itself is one navigation away and owns everything else.
 *
 * THE STATE THAT MATTERS MOST HERE
 * -------------------------------
 * `empty` means Odoo answered and there is no such customer. `unavailable`
 * means Odoo did not answer. Search is the FIRST thing a staff member does, so
 * collapsing those two would greet an outage with "no customer found" — and the
 * reader's next move is to conclude the customer is not in the system.
 *
 * Transport only. The term parsing, the domains and the failure classification
 * live in lib/context and are tested without a server.
 */

import { NextResponse } from 'next/server'

import { odooCallerFor } from '@/lib/context/customer-sources'
import { parseSearchTerm, searchCustomers, MAX_SEARCH_RESULTS } from '@/lib/context/customer-search'
import { classifyOdooFailure } from '@/lib/context/odoo-failure'
import { resolveOdooConfigForTenant } from '@/lib/engine-bindings'
import { getSession } from '@/lib/session'
import { requireWorkspaceAccess } from '@/lib/workspace/authz'

export const revalidate = 0

export type SearchState = 'available' | 'empty' | 'unavailable' | 'error'

export async function GET(req: Request) {
  // AUTHENTICATION FIRST. An anonymous caller gets the same 401 whatever they
  // search for, so a malformed term cannot answer a question a 401 would not.
  const ctx = await getSession()
  if (!ctx || !ctx.effectiveTenantId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const guard = await requireWorkspaceAccess(ctx, 'manager')
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status })

  // From the SESSION. It selects which Odoo instance is searched, which is the
  // whole cross-tenant boundary: another tenant's customers are not hidden,
  // they are absent from the instance this session can reach.
  const tenantId = ctx.effectiveTenantId

  const raw = new URL(req.url).searchParams.get('q')
  const term = parseSearchTerm(raw)
  if (!term) {
    // Not an error and not an empty result — no question was asked.
    return NextResponse.json(
      { version: 'customer-search@1', state: 'empty', term: null, count: 0, results: [], reason: null },
      { status: 200 },
    )
  }

  let config
  try {
    config = await resolveOdooConfigForTenant(tenantId)
  } catch {
    return NextResponse.json(
      {
        version: 'customer-search@1',
        state: 'unavailable' as SearchState,
        term: term.kind,
        count: 0,
        results: [],
        reason: 'no customer directory is connected to this workspace',
        retryable: false,
      },
      { status: 200 },
    )
  }

  try {
    const results = await searchCustomers(
      odooCallerFor(config),
      term,
      MAX_SEARCH_RESULTS,
      config.url || null,
    )
    return NextResponse.json(
      {
        version: 'customer-search@1',
        // Answered with nothing is `empty`. It is a real answer.
        state: (results.length > 0 ? 'available' : 'empty') as SearchState,
        term: term.kind,
        count: results.length,
        results,
        reason: null,
      },
      { status: 200 },
    )
  } catch (err) {
    // Could not ask. NOT "no customer found".
    const failure = classifyOdooFailure(err)
    return NextResponse.json(
      {
        version: 'customer-search@1',
        state: 'unavailable' as SearchState,
        term: term.kind,
        count: 0,
        results: [],
        reason: failure.message,
        retryable: failure.retryable,
      },
      { status: 200 },
    )
  }
}
