/**
 * /customers — find a customer, open their workspace.
 *
 * WHY THIS EXISTS, GIVEN THE EARLIER DECISION NOT TO BUILD IT
 * ---------------------------------------------------------
 * Mutation 11 deliberately gave Customer 360 exactly one door — a Recent Work
 * row's related customer — so that two routes could not both be authoritative
 * for the same object. That reasoning was sound and it is superseded by
 * evidence, not by preference: in production every one of the 59 activity rows
 * carries `customerId: null`, because no activity source populates it. The one
 * door is real and nothing is standing in it, so the workspace was reachable
 * only by typing a URL.
 *
 * THE INVARIANT IS PRESERVED, BECAUSE THIS IS NOT A SECOND WORKSPACE.
 * This route finds a partner id and navigates to `/customer/<id>`. It renders
 * no context section, holds no customer state, and duplicates nothing. There is
 * still exactly one authoritative Customer 360 route; there are now two ways to
 * reach it, which is a different thing entirely.
 *
 * The guard, the shell and the streaming arrangement are identical to
 * /customer/[customerId] — see that file for why the page component is
 * synchronous and the heading sits outside the Suspense boundary.
 */

import { Suspense } from 'react'
import { redirect } from 'next/navigation'

import { CustomersSearch } from '@/components/customer/customers-search'
import { WorkspaceAccessDenied } from '@/components/workspace/access-denied'
import { getSession } from '@/lib/session'
import { requireWorkspaceAccess } from '@/lib/workspace/authz'

export const revalidate = 0

export default function CustomersPage() {
  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 id="customers-title" className="text-2xl font-semibold tracking-tight">
          Customers
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Find a customer and open their workspace.
        </p>
      </div>
      <Suspense fallback={<p className="text-sm text-muted-foreground">Loading…</p>}>
        <GuardedCustomersSearch />
      </Suspense>
    </div>
  )
}

async function GuardedCustomersSearch() {
  const session = await getSession()
  if (!session) redirect('/')

  // The same manager gate the search endpoint applies, checked here too so a
  // reader without the role gets the role message rather than a working search
  // box that only ever refuses.
  const guard = await requireWorkspaceAccess(session, 'manager')
  if (!guard.ok) return <WorkspaceAccessDenied message={guard.error} />

  return <CustomersSearch />
}
