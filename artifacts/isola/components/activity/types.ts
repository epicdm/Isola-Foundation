/**
 * The wire shape of GET /api/v1/activity, as the browser sees it.
 *
 * These are TYPE-ONLY re-exports of the contract the endpoint already owns, not
 * a second copy of it. Re-declaring the shape here would let this screen drift
 * from the API without a compile error, which is the only way it could start
 * rendering a field the API stopped sending, or quietly keep a field the API
 * renamed.
 *
 * "export type" is erased at build time, so nothing server-side (Prisma, the
 * projection store, node:crypto) is dragged into the client bundle by this
 * file. It costs nothing at runtime and it breaks the build on the day the
 * contract moves underneath us, which is exactly when we want to hear about it.
 */

export type {
  ActivityActor,
  ActivityFeedItem,
  DataMode,
  DataState,
  NativeLink,
  OwnershipState,
  Provenance,
} from "@/lib/activity/feed"

export type {
  ActivityResponseBody as ActivityFeedResponse,
  ActivitySourceReport,
} from "@/lib/activity/handler"

/**
 * The six sources, in the order the registry builds them.
 *
 * Rendered in this order EVERY time, including the ones that answered with
 * nothing and the ones this account may not read. A source that disappears from
 * the panel when it fails is indistinguishable from a source that was never
 * asked, and that confusion is the whole reason this screen reports per-source
 * state instead of one number.
 *
 * A literal rather than an import of ACTIVITY_SOURCE_NAMES: that module reaches
 * for Prisma and the projection store at import time, which is not something a
 * client bundle should be pulled into for the sake of six strings. The route
 * test asserts the server list; labels.test.ts asserts this one still matches.
 */
export const ACTIVITY_SOURCE_ORDER = [
  "audit_log",
  "approval_request",
  "staff_work_action",
  "conversation_ownership",
  "lane2",
  "customer_tool_operation",
] as const

export type ActivitySourceName = (typeof ACTIVITY_SOURCE_ORDER)[number]
