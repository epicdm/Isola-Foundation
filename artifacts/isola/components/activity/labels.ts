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

// ── generic ───────────────────────────────────────────────────────

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

// ── sources ───────────────────────────────────────────────────────

const SOURCE_LABELS: Readonly<Record<string, string>> = {
  audit_log: "Security and audit trail",
  approval_request: "Approvals",
  staff_work_action: "Work your team recorded",
  conversation_ownership: "Conversation handovers",
  lane2: "Live channel and assistant events",
}

const SOURCE_DESCRIPTIONS: Readonly<Record<string, string>> = {
  audit_log: "Who changed what in this workspace.",
  approval_request: "Actions that waited for a person to say yes or no.",
  staff_work_action: "Notes, tasks and leads your team recorded against a customer.",
  conversation_ownership:
    "When a person took a conversation over from the assistant, and when it went back.",
  lane2: "Messages, channel health and assistant activity as they arrive.",
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

// ── event families ────────────────────────────────────────────────

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

// ── ownership ─────────────────────────────────────────────────────

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

// ── status ────────────────────────────────────────────────────────

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

// ── actor ─────────────────────────────────────────────────────────

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

// ── time ──────────────────────────────────────────────────────────

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

// ── data state ────────────────────────────────────────────────────

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

// ── actions ───────────────────────────────────────────────────────

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

// ── links ─────────────────────────────────────────────────────────

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
