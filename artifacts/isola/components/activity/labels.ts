/**
 * Every string this screen puts in front of a person, and nothing else.
 *
 * Pure functions with no React and no clock of their own: the time helpers take
 * "now" as an argument so a test can assert the exact sentence a reader sees,
 * and so the server and the browser cannot render two different answers for the
 * same row.
 *
 * THREE RULES THIS FILE EXISTS TO KEEP
 * ------------------------------------
 * 1. NOTHING IS INVENTED. A field that is absent renders as "Unknown" or is
 *    omitted. There is no place here that turns a missing actor into a plausible
 *    one, or a missing timestamp into "recently".
 * 2. A FAILURE NEVER READS AS A SUCCESS. statusPresentation checks for failure
 *    words BEFORE success words, so "readback_failed" cannot be classified by
 *    the "ed" ending of some future "succeeded_but_readback_failed".
 * 3. NO RAW KEY IS EVER THE WHOLE LABEL. Source keys, event types and statuses
 *    are mapped to human wording; the fallback humanises rather than printing
 *    the identifier verbatim.
 */

import type { ActivitySourceReport, DataState, OwnershipState } from "./types"

// ── generic ──────────────────────────────────────────────────

/**
 * Turns an identifier into something a person can read.
 *
 * The fallback for every map below. It is deliberately dumb: it will not guess
 * meaning, it only removes the punctuation that marks a string as machine-facing
 * so an unmapped value reads as a phrase rather than as a database column.
 */
export function humanise(key: string | null | undefined): string {
  const words = (key ?? "").replace(/[._-]+/g, " ").trim()
  if (!words) return "Unknown"
  return words.charAt(0).toUpperCase() + words.slice(1)
}

// ── identifiers ─────────────────────────────────────────────

/**
 * True when a string is a machine identifier rather than something a person
 * wrote.
 *
 * The test is deliberately narrow: an unbroken run of at least sixteen
 * alphanumerics containing BOTH a letter and a digit. That matches a cuid
 * ("cmrewcr5e0001s617dpr2qm3e") and the tail of "agent:cmrew...", and it does
 * not match a name, however long, because names carry no digits. Getting this
 * wrong in the permissive direction would hide a real label behind an ellipsis,
 * so the rule errs towards leaving text alone.
 */
export function isOpaqueIdentifier(value: string | null | undefined): boolean {
  const raw = (value ?? "").trim()
  if (!raw || /\s/.test(raw)) return false
  const runs = raw.match(/[A-Za-z0-9]{16,}/g) ?? []
  return runs.some((run) => /[0-9]/.test(run) && /[A-Za-z]/.test(run))
}

/**
 * The last few characters of an identifier, marked as a fragment.
 *
 * Enough to tell two rows apart, short enough to read, and unmistakably partial
 * so nobody copies it thinking it is the whole reference. The full value always
 * travels alongside it in a title attribute -- it is shortened for display, not
 * withheld.
 */
export function shortReference(value: string | null | undefined): string {
  const raw = (value ?? "").trim()
  if (!raw) return ""
  return "…" + (raw.length <= 5 ? raw : raw.slice(-5))
}

/** What to print, and what to keep on hover. `title` is null when there is nothing extra to reveal. */
export interface DisplayValue {
  text: string
  title: string | null
}

// ── parameter labels ─────────────────────────────────────────

/**
 * The API's parameter names, in the words this screen uses for them.
 *
 * ONE SOURCE, USED BY BOTH SIDES. The filter bar renders its control labels from
 * this map and the error notice resolves the rejected parameter through it, so
 * "The filter pageSize was refused" became "The filter Records per page was
 * refused" and cannot drift back apart: a control renamed here is renamed in the
 * error in the same edit (defect-activity-raw-parameter-name-in-error).
 */
const PARAMETER_LABELS: Readonly<Record<string, string>> = {
  source: "System",
  eventFamily: "Kind of record",
  ownershipState: "Who was handling it",
  status: "Status",
  occurredFrom: "From",
  occurredTo: "To",
  customer: "Customer reference",
  actor: "Person or assistant reference",
  pageSize: "Records per page",
  cursor: "Page position",
  company: "Company",
  filter: "Filter",
}

export function parameterLabel(parameter: string | null | undefined): string {
  const key = (parameter ?? "").trim()
  if (!key) return "Filter"
  return PARAMETER_LABELS[key] ?? humanise(key)
}

// ── sources ─────────────────────────────────────────────────

const SOURCE_LABELS: Readonly<Record<string, string>> = {
  audit_log: "Security and audit trail",
  approval_request: "Approvals",
  staff_work_action: "Work your team recorded",
  conversation_ownership: "Conversation handovers",
  lane2: "Live channel and assistant events",
  customer_tool_operation: "Governed customer actions",
}

const SOURCE_DESCRIPTIONS: Readonly<Record<string, string>> = {
  audit_log: "Who changed what in this workspace.",
  approval_request: "Actions that waited for a person to say yes or no.",
  staff_work_action: "Notes, tasks and leads your team recorded against a customer.",
  conversation_ownership:
    "When a person took a conversation over from the assistant, and when it went back.",
  lane2: "Messages, channel health and assistant activity as they arrive.",
  customer_tool_operation:
    "Actions taken against a specific customer through the governed workbench, with whatever the system could confirm about the result.",
}

export function sourceLabel(source: string): string {
  return SOURCE_LABELS[source] ?? humanise(source)
}

export function sourceDescription(source: string): string | null {
  return SOURCE_DESCRIPTIONS[source] ?? null
}

export const SOURCE_OPTIONS: readonly { value: string; label: string }[] = Object.keys(
  SOURCE_LABELS,
).map((value) => ({ value, label: SOURCE_LABELS[value] }))

export type SourceTone = "available" | "empty" | "stale" | "unavailable" | "not_permitted"

export interface SourceStatusPresentation {
  tone: SourceTone
  /** The word a person reads. Colour is never the only carrier of this. */
  label: string
  explanation: string
  /**
   * False for a forbidden source, and false on purpose. A count of records the
   * account may not read still tells the reader how many exist, which is the
   * same leak as showing the rows greyed out.
   */
  showCount: boolean
  showFetchedAt: boolean
}

const NOT_LOADED: SourceStatusPresentation = {
  tone: "empty",
  label: "Not checked yet",
  explanation: "This system has not been asked yet.",
  showCount: false,
  showFetchedAt: false,
}

export function notLoadedSourceStatus(): SourceStatusPresentation {
  return NOT_LOADED
}

/**
 * How one source is described to the reader.
 *
 * "Unavailable" and "Not permitted" are worded so that they cannot be mistaken
 * for one another: one says we could not reach the system, the other says the
 * account is not allowed to see it. Collapsing them into "no data" would hide a
 * broken integration behind a permissions message, or vice versa.
 */
export function sourceStatus(
  report: ActivitySourceReport,
  rowsOnPage: number,
): SourceStatusPresentation {
  switch (report.state) {
    case "forbidden":
      return {
        tone: "not_permitted",
        label: "Not permitted",
        explanation: "These records are not available to this account.",
        showCount: false,
        showFetchedAt: false,
      }
    case "unavailable":
      return {
        tone: "unavailable",
        label: "Unavailable",
        explanation:
          "We could not reach this system, so anything it holds is missing from the list below.",
        showCount: false,
        showFetchedAt: false,
      }
    case "stale":
      return {
        tone: "stale",
        label: "Older information",
        explanation: "This system answered, but with information older than the rest.",
        showCount: true,
        showFetchedAt: true,
      }
    case "ok":
    default:
      return rowsOnPage === 0
        ? {
            tone: "empty",
            label: "Nothing to show",
            explanation: "This system answered and had nothing for this page.",
            showCount: true,
            showFetchedAt: true,
          }
        : {
            tone: "available",
            label: "Available",
            explanation: "This system answered with current information.",
            showCount: true,
            showFetchedAt: true,
          }
  }
}

// ── event families ────────────────────────────────────────────

const FAMILY_LABELS: Readonly<Record<string, string>> = {
  "staff.note": "Note from your team",
  "business.note": "Business note",
  "task.created": "Task created",
  "task.updated": "Task updated",
  "activity.scheduled": "Activity scheduled",
  "lead.created": "Lead created",
  "lead.updated": "Lead updated",
  "followup.scheduled": "Follow-up scheduled",
  "approval.requested": "Approval requested",
  "approval.approved": "Approval granted",
  "approval.rejected": "Approval refused",
  "governed.action.started": "Action started",
  "governed.action.completed": "Action completed",
  "governed.action.failed": "Action failed",
  "governed.readback": "Result checked back",
  "audit.event": "Audit entry",
  "customer.message": "Customer message",
  "clawith.activity": "Assistant activity",
  "ownership.human_takeover": "A person took over",
  "ownership.human_reply": "A person replied",
  "ownership.handback": "Handed back to the assistant",
  "channel.health": "Channel health",
  "agent.health": "Assistant health",
}

export function familyLabel(eventType: string): string {
  return FAMILY_LABELS[eventType] ?? humanise(eventType)
}

export const EVENT_FAMILY_OPTIONS: readonly { value: string; label: string }[] = Object.keys(
  FAMILY_LABELS,
).map((value) => ({ value, label: FAMILY_LABELS[value] }))

// ── ownership ──────────────────────────────────────────────

export const OWNERSHIP_OPTIONS: readonly { value: string; label: string }[] = [
  { value: "ai", label: "Handled by the assistant" },
  { value: "human", label: "Handled by a person" },
  { value: "unknown", label: "Not known" },
]

/**
 * Null means the record does not carry an ownership state at all, which is not
 * the same as the API telling us it is "unknown". The first is omitted from the
 * row; the second is printed, because the API went to the trouble of saying so.
 */
export function ownershipLabel(state: OwnershipState | null | undefined): string | null {
  if (state === "ai") return "Handled by the assistant"
  if (state === "human") return "Handled by a person"
  if (state === "unknown") return "Not known"
  return null
}

// ── status ──────────────────────────────────────────────────

export type StatusTone = "success" | "failure" | "pending" | "neutral"

export interface StatusPresentation {
  tone: StatusTone
  label: string
  /** Shown in full when there is something a reader would otherwise misread. */
  note?: string
}

const READBACK_NOTE =
  "The change was sent but could not be read back afterwards, so it is not confirmed."

const STATUS_LABELS: Readonly<Record<string, StatusPresentation>> = {
  approved: { tone: "success", label: "Approved" },
  consumed: { tone: "success", label: "Approved and used" },
  completed: { tone: "success", label: "Completed" },
  succeeded: { tone: "success", label: "Succeeded" },
  healthy: { tone: "success", label: "Healthy" },
  ok: { tone: "success", label: "Healthy" },
  pending: { tone: "pending", label: "Waiting for a decision" },
  recorded: { tone: "neutral", label: "Recorded" },
  unknown: { tone: "neutral", label: "Unknown" },
  denied: { tone: "failure", label: "Refused" },
  rejected: { tone: "failure", label: "Refused" },
  expired: { tone: "failure", label: "Expired without a decision" },
  degraded: { tone: "failure", label: "Degraded" },
  down: { tone: "failure", label: "Down" },
  readback_failed: { tone: "failure", label: "Not confirmed", note: READBACK_NOTE },
  activity_readback_failed: { tone: "failure", label: "Not confirmed", note: READBACK_NOTE },
}

const FAILURE_WORDS =
  /(fail|error|refus|reject|deny|denied|expir|degrad|unreachable|timeout|unavailable|abort|cancel|\bdown\b)/i
const SUCCESS_WORDS = /(success|succeed|complete|approved|healthy|delivered|\bok\b)/i

/**
 * FAILURE IS TESTED FIRST AND THAT ORDER IS THE POINT.
 *
 * "readback_failed" carries no success word today, but the moment a source emits
 * something like "completed_readback_failed" a success-first check would render
 * a row that did not land as one that did. Getting this backwards is silent: the
 * screen looks fine and the reader believes a write happened.
 */
export function statusPresentation(status: string | null | undefined): StatusPresentation {
  const raw = (status ?? "").trim()
  if (!raw) return { tone: "neutral", label: "Unknown" }

  const exact = STATUS_LABELS[raw.toLowerCase()]
  if (exact) return exact

  if (FAILURE_WORDS.test(raw)) return { tone: "failure", label: humanise(raw) }
  if (SUCCESS_WORDS.test(raw)) return { tone: "success", label: humanise(raw) }
  return { tone: "neutral", label: humanise(raw) }
}

/**
 * The statuses offered as a filter. An exact-match list, not a search box: the
 * API matches "status" exactly, so offering free text would let a reader type
 * something that silently matches nothing and read the empty result as fact.
 */
export const STATUS_OPTIONS: readonly { value: string; label: string }[] = [
  "pending",
  "approved",
  "consumed",
  "denied",
  "expired",
  "recorded",
  "healthy",
  "degraded",
  "down",
  "unknown",
].map((value) => ({ value, label: statusPresentation(value).label }))

// ── actor ──────────────────────────────────────────────────

/**
 * Never derived from the reference. An actor ref is an internal identifier and
 * printing it, or guessing a name from it, would be inventing a person.
 */
export function actorLabel(actor: { label?: string | null } | null | undefined): string {
  const label = actor?.label?.trim()
  return label ? label : "Unknown"
}

export function actorKindLabel(kind: string | null | undefined): string | null {
  if (kind === "staff") return "team member"
  if (kind === "agent") return "assistant"
  if (kind === "customer") return "customer"
  if (kind === "system") return "system"
  return null
}

/**
 * The actor, as a person should see it.
 *
 * THREE CASES, AND NOTHING IS INVENTED IN ANY OF THEM.
 *
 * 1. A real label: printed as it arrived, with the kind in brackets.
 * 2. NO label: "Unknown", plus the kind if the API told us one. The internal
 *    ref is NOT substituted -- "staff:99" is not the name of a person and
 *    showing it in the name's place is a small lie with an official look.
 * 3. A label that is itself an identifier: this is the one that was broken.
 *    The API sometimes sends the ref as the label, so rows read
 *    "agent:cmrewcr5e0001s617dpr2qm3e" (defect-activity-raw-cuid-on-screen).
 *    We show the kind we genuinely know plus a short suffix -- "Assistant
 *    · …2qm3e" -- and keep the whole identifier in the title. We do NOT look
 *    up, guess or synthesise a name we were never given.
 */
export function actorDisplay(
  actor: { label?: string | null; kind?: string | null } | null | undefined,
): DisplayValue {
  const kind = actorKindLabel(actor?.kind)
  const label = actor?.label?.trim() ?? ""

  if (!label) {
    return { text: kind ? "Unknown (" + kind + ")" : "Unknown", title: null }
  }

  if (!isOpaqueIdentifier(label)) {
    return { text: kind ? label + " (" + kind + ")" : label, title: null }
  }

  const noun = kind ? kind.charAt(0).toUpperCase() + kind.slice(1) : "Unknown"
  return { text: noun + " · " + shortReference(label), title: label }
}

/**
 * The related object, as a person should see it.
 *
 * "Conversation cmrewdo5b0005s61765xj85i4" becomes a short form with the full
 * id on hover. A related id that is NOT opaque (a ticket number, say) is
 * printed in full, because there is nothing to hide.
 */
export function relatedDisplay(
  type: string | null | undefined,
  id: string | null | undefined,
): DisplayValue | null {
  const kind = (type ?? "").trim()
  const value = (id ?? "").trim()
  if (!kind || !value) return null

  const noun = humanise(kind)
  if (!isOpaqueIdentifier(value)) return { text: noun + " " + value, title: null }
  return { text: noun + " " + shortReference(value), title: noun + " " + value }
}

/**
 * The customer, as a person should see it.
 *
 * A real label is used exactly as it arrived. Today nothing sends one:
 * `customer_tool_operation` -- the only source that ever proves a customerId --
 * deliberately never sends a label either, because its id is verified against
 * Odoo and this screen is not entitled to attach a name to it that nobody
 * confirmed. So this almost always falls through to the id itself.
 *
 * That fall-through is the point. `activity-row.tsx` used to gate the entire
 * Customer field -- link included -- on `customerLabel` being truthy. No source
 * has ever sent one, so the "Open customer" link existed in the code and had
 * never once rendered. An id with no label is not a reason to withhold the
 * link; it is the ONLY thing this source was built to prove.
 *
 * A short partner id such as "42" is not an opaque identifier and is printed in
 * full, the same as `relatedDisplay` prints a readable id in full. A longer,
 * opaque id is shortened the same way `relatedDisplay` shortens one, with the
 * whole value kept in `title`.
 */
export function customerDisplay(
  customerId: string | null | undefined,
  customerLabel: string | null | undefined,
): DisplayValue | null {
  const label = (customerLabel ?? "").trim()
  if (label) return { text: label, title: null }

  const id = (customerId ?? "").trim()
  if (!id) return null
  if (!isOpaqueIdentifier(id)) return { text: "Customer #" + id, title: null }
  return { text: "Customer · " + shortReference(id), title: id }
}

/**
 * The row's own reference.
 *
 * Fifty rows stamped to the same MINUTE were visually identical -- seven of
 * them, in one page, with nothing on the row to tell them apart
 * (defect-activity-indistinguishable-rows). The ids were always distinct; the
 * display threw the distinction away. This puts a short, stable handle back on
 * every row, with the full activityId on hover, and absoluteTime below now
 * carries seconds as well.
 */
export function recordReference(activityId: string | null | undefined): DisplayValue | null {
  const raw = (activityId ?? "").trim()
  if (!raw) return null
  return { text: shortReference(raw), title: raw }
}

// ── time ───────────────────────────────────────────────────

const MINUTE = 60
const HOUR = 3600
const DAY = 86400

/**
 * Rendered in UTC on purpose.
 *
 * A locale-formatted string differs between the server render and the browser
 * render, and between one reader and another, which makes it useless as the
 * exact value shown on hover and impossible to assert in a test. The suffix
 * says which zone it is in, so nobody has to guess.
 *
 * SECONDS ARE PART OF THE VALUE, NOT A DETAIL.
 * Truncating to the minute made rows that happened seconds apart render as the
 * same instant, and a feed whose whole ordering claim is "newest first" cannot
 * then justify its own order to the reader
 * (defect-activity-indistinguishable-rows). Automated work lands in bursts;
 * minute precision is simply not enough resolution for this data.
 */
export function absoluteTime(iso: string | null | undefined): string {
  if (!iso) return "Unknown time"
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return "Unknown time"
  const pad = (n: number) => String(n).padStart(2, "0")
  return [
    date.getUTCFullYear(),
    "-",
    pad(date.getUTCMonth() + 1),
    "-",
    pad(date.getUTCDate()),
    " ",
    pad(date.getUTCHours()),
    ":",
    pad(date.getUTCMinutes()),
    ":",
    pad(date.getUTCSeconds()),
    " UTC",
  ].join("")
}

export function relativeTime(iso: string | null | undefined, now: Date): string {
  if (!iso) return "Unknown time"
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return "Unknown time"

  const seconds = Math.floor((now.getTime() - then) / 1000)
  // A row stamped in the future is a clock disagreement, not a prediction.
  // "Just now" is the honest floor; inventing "in 3 minutes" is not.
  if (seconds < 45) return "Just now"
  if (seconds < HOUR) {
    const m = Math.max(1, Math.floor(seconds / MINUTE))
    return m === 1 ? "1 minute ago" : m + " minutes ago"
  }
  if (seconds < DAY) {
    const h = Math.max(1, Math.floor(seconds / HOUR))
    return h === 1 ? "1 hour ago" : h + " hours ago"
  }
  const d = Math.floor(seconds / DAY)
  if (d <= 30) return d === 1 ? "1 day ago" : d + " days ago"
  // Past a month, "43 days ago" helps nobody. The date is more use.
  return absoluteTime(iso)
}

export function freshnessLabel(
  freshness: { ageSeconds: number; stale: boolean } | null | undefined,
): string {
  if (!freshness) return "Freshness unknown"
  return freshness.stale ? "From an older read" : "Current"
}

// ── data state ──────────────────────────────────────────────

export interface DataStateNotice {
  tone: "neutral" | "warning"
  label: string
  explanation: string
}

export function dataStateNotice(state: DataState | null | undefined): DataStateNotice {
  switch (state) {
    case "available_with_records":
      return {
        tone: "neutral",
        label: "Complete",
        explanation: "Every system answered.",
      }
    case "available_empty":
      return {
        tone: "neutral",
        label: "Complete, nothing to show",
        explanation: "Every system answered and none of them had anything to report.",
      }
    case "partial":
      return {
        tone: "warning",
        label: "Partial",
        explanation: "Some systems did not answer, so this list is incomplete.",
      }
    case "stale":
      return {
        tone: "warning",
        label: "Older information",
        explanation: "At least one system answered with information older than the rest.",
      }
    case "forbidden":
      return {
        tone: "warning",
        label: "Not permitted",
        explanation: "None of the systems behind this list are available to this account.",
      }
    case "unavailable":
      return {
        tone: "warning",
        label: "Unavailable",
        explanation: "None of the systems behind this list could be reached.",
      }
    case "fixture":
      return {
        tone: "warning",
        label: "Sample data",
        explanation: "At least one system is returning sample data, not your real records.",
      }
    default:
      return {
        tone: "neutral",
        label: "Not loaded yet",
        explanation: "This list has not been loaded yet.",
      }
  }
}

/**
 * The freshness line when the LAST REQUEST FAILED.
 *
 * dataStateNotice describes the data the API returned. When the API returned no
 * data at all, asking it that question produced "Not loaded yet / This list has
 * not been loaded yet" sitting directly above "That filter cannot be used" --
 * two lines, one saying nothing has happened and the other saying something
 * specific went wrong (defect-activity-contradictory-dual-state). A failed
 * request is a different question and gets a different answer. Nothing here
 * reads as a loading state and nothing here reads as success.
 */
export function problemStateNotice(problem: { kind: string }): DataStateNotice {
  switch (problem.kind) {
    case "auth_expired":
      return {
        tone: "warning",
        label: "Signed out",
        explanation: "This list stopped loading because the session is no longer signed in.",
      }
    case "not_permitted":
      return {
        tone: "warning",
        label: "Not permitted",
        explanation: "These records are not available to this account.",
      }
    case "unavailable":
      return {
        tone: "warning",
        label: "Unavailable",
        explanation: "None of the systems behind this list could be reached.",
      }
    case "invalid_filter":
      return {
        tone: "warning",
        label: "Refused",
        explanation:
          "The last request was refused because a filter could not be used, so nothing was loaded for it.",
      }
    case "invalid_cursor":
      return {
        tone: "warning",
        label: "Refused",
        explanation: "The last request was refused because the page position was not valid.",
      }
    default:
      return {
        tone: "warning",
        label: "Not loaded",
        explanation: "The last request did not complete, so this list was not updated.",
      }
  }
}

export const CURSOR_RESET_TITLE = "Back to the first page"

/**
 * The freshness line after a REFUSED CURSOR was recovered from.
 *
 * This is the case the screen used to swallow whole. `?cursor=garbage` makes
 * the API answer 400 malformed_cursor; the controller correctly throws the
 * cursor away and fetches page one, and that page-one answer is a perfectly
 * good 200 -- so the banner read "Complete / Every system answered" for a
 * request the server had refused, and no notice was shown at all
 * (defect-activity-400-rendered-as-complete). The recovery was right. Claiming
 * it never happened was not. A request the server refused may not be reported
 * as a complete answer, even when the retry after it succeeded.
 */
export function cursorResetNotice(): DataStateNotice {
  return {
    tone: "warning",
    label: "Restarted at the first page",
    explanation:
      "The page position this list was given was not valid, so the server refused it and the " +
      "first page was loaded instead. Nothing was skipped.",
  }
}

// ── actions ─────────────────────────────────────────────────

const ACTION_LABELS: Readonly<Record<string, string>> = {
  "note.create": "Add a note",
  "followup.schedule": "Schedule a follow-up",
  "activity.schedule": "Schedule an activity",
  "lead.update": "Update the lead",
  "approval.decide": "Decide the approval",
  "approval.approve": "Approve",
  "approval.reject": "Refuse",
  "task.update": "Update the task",
}

export function actionLabel(action: string): string {
  return ACTION_LABELS[action] ?? humanise(action)
}

// ── links ───────────────────────────────────────────────────

/**
 * Only an absolute http(s) link survives.
 *
 * The API supplies these from adapter configuration, but a link is the one
 * field on a row that a browser will ACT on, so it is checked here rather than
 * trusted. Anything else returns null and the link is simply not rendered,
 * which is also what happens when the API supplied no link at all.
 */
export function safeHref(href: string | null | undefined): string | null {
  const value = (href ?? "").trim()
  if (!/^https?:\/\//i.test(value)) return null
  return value
}
