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
import { RecentWorkLoading } from "@/components/activity/recent-work-view"

export const revalidate = 0

export default async function ActivityPage() {
  const session = await getSession()
  if (!session) redirect("/")

  // The same manager gate the endpoint applies. Checked here as well so a reader
  // without the role gets the role message, rather than a working screen that
  // fills up with refusals.
  const guard = await requireWorkspaceAccess(session, "manager")
  if (!guard.ok) return <WorkspaceAccessDenied message={guard.error} />

  // useSearchParams needs a Suspense boundary above it, and the fallback is the
  // honest first paint: this list is not here yet, rather than an empty list.
  return (
    <Suspense fallback={<RecentWorkLoading />}>
      <RecentWork />
    </Suspense>
  )
}
