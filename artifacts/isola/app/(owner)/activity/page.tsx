/**
 * /activity -- Recent Work.
 *
 * This route used to render a summary built from lib/workspace/tenant-workspace:
 * counts, a short unnormalised "recent activity" list, a handoff card and a
 * conversation list. That was a SECOND activity implementation living beside
 * GET /api/v1/activity, with no per-source state, no cursor, no freshness and no
 * data-state. Two feeds that can disagree is worse than one that admits it is
 * incomplete, so this route now consumes the normalised endpoint and nothing
 * else.
 *
 * lib/workspace/tenant-workspace.ts and /api/workspace/activity are untouched
 * and still serve the dashboard. That contract is a summary and stays one.
 *
 * The server part is only the guard. Rendering the feed here would mean no
 * refresh, no filters and no pagination without a full round trip, and the guard
 * is the one thing that must not be left to the browser.
 */

import { Suspense } from "react"
import { redirect } from "next/navigation"

import { getSession } from "@/lib/session"
import { requireWorkspaceAccess } from "@/lib/workspace/authz"
import { WorkspaceAccessDenied } from "@/components/workspace/access-denied"
import { RecentWork } from "@/components/activity/recent-work"
import { RecentWorkLoading, RecentWorkShell } from "@/components/activity/recent-work-view"

export const revalidate = 0

/**
 * THE PAGE COMPONENT IS SYNCHRONOUS, AND THAT IS THE POINT.
 *
 * It used to be `async` and to await getSession() and requireWorkspaceAccess()
 * BEFORE returning any JSX. Under streaming SSR a segment emits nothing at all
 * until its own component returns, so the Suspense boundary below could not
 * help: its fallback is only reachable once the element tree containing it
 * exists. Every navigation to /activity therefore showed the layout chrome
 * above an empty content area for the whole duration of the guard -- a blank
 * shell, indistinguishable from a broken page
 * (defect-activity-blank-shell-while-loading).
 *
 * Moving the awaits into a child UNDER the boundary means the shell -- and with
 * it the full-page skeleton -- is emitted on the first flush, and the guarded
 * content streams in behind it. The guard is not weakened by this: nothing the
 * guard protects renders until it resolves. It just stops being the reason the
 * screen is empty.
 *
 * THE HEADING AND THE LANDMARK ID LIVE OUT HERE, ABOVE THE BOUNDARY.
 *
 * They used to live in BOTH the fallback and the resolved content, so while the
 * boundary was streaming the document held two elements with id="recent-work",
 * two with id="recent-work-title" and two h1s. React reveals a boundary by
 * inserting the resolved subtree next to the fallback and then removing the
 * fallback, so those duplicates are in the real DOM -- an ambiguous landmark, a
 * skip link with two targets, and two page headings for anything navigating by
 * heading (defect-activity-duplicate-heading-and-id-while-streaming).
 *
 * A page heading is not a loading state: it is true before, during and after the
 * fetch. Rendering it ONCE, outside the boundary, is what makes it stable --
 * and it leaves the fallback free to be nothing but the skeleton.
 */
export default function ActivityPage() {
  // useSearchParams needs a Suspense boundary above it, and the fallback is the
  // honest first paint: this list is not here yet, rather than an empty list.
  return (
    <RecentWorkShell>
      <Suspense fallback={<RecentWorkLoading />}>
        <GuardedRecentWork />
      </Suspense>
    </RecentWorkShell>
  )
}

async function GuardedRecentWork() {
  const session = await getSession()
  if (!session) redirect("/")

  // The same manager gate the endpoint applies. Checked here as well so a reader
  // without the role gets the role message, rather than a working screen that
  // fills up with refusals.
  const guard = await requireWorkspaceAccess(session, "manager")
  if (!guard.ok) return <WorkspaceAccessDenied message={guard.error} />

  return <RecentWork />
}
