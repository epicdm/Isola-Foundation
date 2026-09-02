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

import { NextRequest, NextResponse } from 'next/server'

import { odooCallerFor } from '@/lib/context/customer-sources'
import { parseSearchTerm, searchCustomers, MAX_SEARCH_RESULTS } from '@/lib/context/customer-search'
import { classifyOdooFailure } from '@/lib/context/odoo-failure'
import { resolveCaller } from '@/lib/customer-360/route-context'
import { resolveOdooConfigForTenant } from '@/lib/engine-bindings'

export const revalidate = 0

export type SearchState = 'available' | 'empty' | 'unavailable' | 'error'

export async function GET(req: NextRequest) {
  // AUTHENTICATION FIRST. An anonymous caller gets the same 401 whatever they
  // search for, so a malformed term cannot answer a question a 401 would not.
  //
  // BOTH DOORS, via the SAME preamble /api/isola-360/context already uses.
  // This route previously took the cookie door only, which made the published
  // customer-search@1 contract unreachable by the consumer it was published
  // for: the portal calls Foundation server-to-server with a per-tenant service
  // token and would be answered 401 by a route whose contract says nothing
  // about sessions. Reusing resolveCaller rather than adding a second bespoke
  // door is the point — the service/cookie ordering, the refuse-on-mismatch
  // tenant header, and the "a presented bearer never falls through to the
  // cookie" rule are a security boundary, and a hand-written copy here is
  // exactly the divergence route-context.ts was extracted to prevent.
  const resolved = await resolveCaller(req)
  if (!resolved.ok) return resolved.response
  const caller = resolved.caller

  // THE ROLE FLOOR IS UNCHANGED, AND IS RE-ASSERTED RATHER THAN INHERITED.
  // The route it replaces required 'manager' via requireWorkspaceAccess.
  // resolveCaller's cookie door admits any membership, including 'staff', so
  // swapping it in without this check would have quietly WIDENED who can
  // enumerate customers — the opposite of a refactor. A service caller is
  // 'manager' by construction, so the new door passes; a staff session gets
  // the same 403 it got before.
  if (caller.actorRole !== 'owner' && caller.actorRole !== 'manager') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  // From the CALLER — session or service token. It selects which Odoo instance
  // is searched, which is the whole cross-tenant boundary: another tenant's
  // customers are not hidden, they are absent from the instance this caller can
  // reach. Neither door takes the tenant from anything in the request.
  const tenantId = caller.tenantId

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
