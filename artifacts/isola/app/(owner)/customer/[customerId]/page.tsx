/**
 * /customer/<customerId> — the Customer 360 workspace.
 *
 * WHY THIS ROUTE AND NOT /workspace/[type]/[id]
 * --------------------------------------------
 * That route is bound to `getWorkQueueItemDetail` over work QUEUE ITEMS —
 * `odoo_task`, `conversation`, `voicemail`, `approval` — and redirects
 * `conversation` to /inbox. A customer is a different object model, and
 * overloading `[type]` would make one route serve two contracts whose only
 * shared property is having an id.
 *
 * ONE DOOR
 * --------
 * There is deliberately NO customer index page and no navigation entry. The
 * authoritative entry is a Recent Work row's related customer, which is what
 * keeps `AUTHORITATIVE_RECENT_WORK_ROUTES=1` true. Reaching this URL directly
 * still passes through the same guards — the entry point is a product
 * decision, not a security boundary, and the two are not confused here.
 *
 * THE SHELL IS EMITTED BEFORE THE GUARD RESOLVES
 * ----------------------------------------------
 * The page component is synchronous and the awaits live in a child under the
 * Suspense boundary. Under streaming SSR a segment emits nothing until its own
 * component returns, so an `async` page would show layout chrome above an empty
 * content area for the whole duration of the guard — a blank shell,
 * indistinguishable from a broken page
 * (defect-activity-blank-shell-while-loading, same shape, same fix).
 *
 * The heading lives OUTSIDE the boundary because a page heading is not a
 * loading state: it is true before, during and after the fetch. Rendering it in
 * both the fallback and the resolved subtree would put two h1s and two copies
 * of the same id in the real DOM while the boundary streams.
 */

import { Suspense } from 'react'
import { redirect } from 'next/navigation'

import { CustomerWorkspace } from '@/components/customer/customer-workspace'
import { WorkspaceAccessDenied } from '@/components/workspace/access-denied'
import { getSession } from '@/lib/session'
import { requireWorkspaceAccess } from '@/lib/workspace/authz'

export const revalidate = 0

type Params = { params: Promise<{ customerId: string }> }

export default function CustomerPage({ params }: Params) {
  return (
    <div id="customer" className="flex flex-col gap-5">
      <h1 id="customer-title" className="text-2xl font-semibold tracking-tight">
        Customer
      </h1>
      <Suspense fallback={<p className="text-sm text-muted-foreground">Loading this customer…</p>}>
        <GuardedCustomerWorkspace params={params} />
      </Suspense>
    </div>
  )
}

async function GuardedCustomerWorkspace({ params }: Params) {
  const session = await getSession()
  if (!session) redirect('/')

  // The same manager gate the endpoints apply. Checked here as well so a reader
  // without the role gets the role message, rather than a working screen that
  // fills up with refusals.
  const guard = await requireWorkspaceAccess(session, 'manager')
  if (!guard.ok) return <WorkspaceAccessDenied message={guard.error} />

  const { customerId } = await params
  return <CustomerWorkspace customerId={customerId} />
}
