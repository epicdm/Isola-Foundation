/**
 * The source panel, the problem notices and the filter bar.
 *
 * All PURE components. No hooks anywhere in this file, which is what lets the
 * tests render every one of them with renderToStaticMarkup in a node process
 * and assert the markup a reader actually receives.
 *
 * WHY NATIVE select AND NOT THE RADIX ONE
 * ---------------------------------------
 * components/ui/select.tsx is a Radix listbox: it portals into document.body,
 * needs a real DOM to open, renders nothing useful on the server, and is
 * therefore invisible to every test available in this workspace. A native
 * select is keyboard-operable for free, uses the platform picker on a phone,
 * announces correctly in every screen reader, and can be asserted. The styling
 * matches the Input primitive so it does not read as a second design system.
 */

import { AlertTriangle, CheckCircle2, Clock, Info, Lock, WifiOff } from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { cn } from "@/lib/utils"

import type { FeedProblem } from "./feed-controller"
import {
  EVENT_FAMILY_OPTIONS,
  OWNERSHIP_OPTIONS,
  SOURCE_OPTIONS,
  STATUS_OPTIONS,
  CURSOR_RESET_TITLE,
  absoluteTime,
  notLoadedSourceStatus,
  parameterLabel,
  sourceDescription,
  sourceLabel,
  sourceStatus,
  type SourceTone,
} from "./labels"
import {
  withListFilter,
  withScalarFilter,
  type ActivityFilters,
  type LIST_FILTER_KEYS,
  type SCALAR_FILTER_KEYS,
} from "./filters"
import { ACTIVITY_SOURCE_ORDER, type ActivitySourceReport } from "./types"

// ── source panel ──

const TONE_ICON: Record<SourceTone, typeof Info> = {
  available: CheckCircle2,
  empty: Info,
  stale: Clock,
  // Deliberately different icons. "We could not reach it" and "you may not see
  // it" are opposite problems with opposite fixes, and a single generic warning
  // triangle for both is how a permissions issue gets escalated as an outage.
  unavailable: WifiOff,
  not_permitted: Lock,
}

const TONE_CLASS: Record<SourceTone, string> = {
  available: "border-emerald-600/40",
  empty: "border-border",
  stale: "border-amber-600/50",
  unavailable: "border-destructive/60",
  not_permitted: "border-border",
}

export interface SourcePanelProps {
  sources: readonly ActivitySourceReport[]
  counts: Map<string, number>
  loaded: boolean
}

export function SourcePanel({ sources, counts, loaded }: SourcePanelProps) {
  const byName = new Map(sources.map((report) => [report.source, report]))
  // Every known source, every time, in registry order; then anything the API
  // reported that this build does not know about, so a sixth source added
  // server-side shows up rather than silently vanishing from the panel.
  const extra = sources.map((s) => s.source).filter((name) => !ACTIVITY_SOURCE_ORDER.includes(name as never))
  const names = [...ACTIVITY_SOURCE_ORDER, ...extra]

  return (
    <ul role="list" className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
      {names.map((name) => {
        const report = byName.get(name)
        const rows = counts.get(name) ?? 0
        const presentation = report && loaded ? sourceStatus(report, rows) : notLoadedSourceStatus()
        const Icon = TONE_ICON[presentation.tone]
        const description = sourceDescription(name)

        return (
          <li
            key={name}
            className={cn("flex min-w-0 flex-col gap-1 rounded-lg border p-3", TONE_CLASS[presentation.tone])}
          >
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <Icon className="size-4 shrink-0" aria-hidden="true" />
              <span className="min-w-0 break-words text-sm font-medium">{sourceLabel(name)}</span>
              {/* The word, always. Never the border colour on its own. */}
              <span className="text-xs font-medium text-muted-foreground">{presentation.label}</span>
            </div>

            {description ? (
              <p className="break-words text-xs text-muted-foreground">{description}</p>
            ) : null}

            <p className="break-words text-xs text-muted-foreground">{presentation.explanation}</p>

            {/* A forbidden source shows NO count and NO timestamp. Either one
                would confirm that records exist and roughly how many, which is
                the same disclosure as showing the rows greyed out. */}
            {presentation.showCount ? (
              <p className="text-xs text-muted-foreground">
                {rows === 1 ? "1 record on this page" : rows + " records on this page"}
              </p>
            ) : null}

            {presentation.showFetchedAt && report?.fetchedAt ? (
              <p className="text-xs text-muted-foreground">Read {absoluteTime(report.fetchedAt)}</p>
            ) : null}
          </li>
        )
      })}
    </ul>
  )
}

// ── problem notices ──

export interface ProblemNoticeProps {
  problem: FeedProblem
  hasRows: boolean
  onRetry(): void
  onClearFilters(): void
  busy: boolean
}

/**
 * One notice, worded for the specific thing that went wrong.
 *
 * No branch here renders a status code, a hostname, an exception or a stack.
 * The only text taken from the API is the 400 "detail", which the endpoint
 * writes for a reader and sanitises at the boundary.
 */
export function ProblemNotice({
  problem,
  hasRows,
  onRetry,
  onClearFilters,
  busy,
}: ProblemNoticeProps) {
  const shell = (
    variant: "default" | "destructive",
    icon: typeof Info,
    title: string,
    children: React.ReactNode,
  ) => {
    const Icon = icon
    return (
      <Alert variant={variant} role="status" aria-live="polite">
        <Icon className="size-4" aria-hidden="true" />
        <AlertTitle>{title}</AlertTitle>
        <AlertDescription className="flex flex-col gap-2">{children}</AlertDescription>
      </Alert>
    )
  }

  const retryButton = (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={onRetry}
      disabled={busy}
      className="min-h-11 w-fit focus-visible:ring-2"
    >
      {busy ? "Trying again..." : "Try again"}
    </Button>
  )

  switch (problem.kind) {
    case "auth_expired":
      return shell(
        "destructive",
        Lock,
        "You have been signed out",
        <>
          <p>
            This list stopped loading because the session is no longer signed in. Nothing you were
            looking at was lost.
          </p>
          {/* A link, not an automatic retry. Retrying a 401 in a loop is how a
              screen hammers the login endpoint while showing a spinner. */}
          <a
            href="/auth/login?returnTo=%2Factivity"
            className="inline-flex min-h-11 w-fit items-center rounded-md border px-3 py-2 text-sm font-medium underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            Sign in again
          </a>
        </>,
      )

    case "unavailable":
      return shell(
        "destructive",
        WifiOff,
        "Recent work is unavailable right now",
        <>
          <p>
            None of the systems behind this list could be reached, so there is nothing to show. This
            is not the same as having no records: we could not find out what happened.
          </p>
          {retryButton}
        </>,
      )

    case "not_permitted":
      return shell(
        "default",
        Lock,
        "Not available to this account",
        <p>These records are not available to this account. Ask a workspace owner if you need them.</p>,
      )

    case "invalid_filter":
      return shell(
        "default",
        AlertTriangle,
        "That filter cannot be used",
        <>
          {/* Naming the parameter matters: a reader who filtered wrongly and is
              shown a bare empty list will believe the empty list. It is named in
              the words the CONTROL uses, not the API's: "pageSize" is not on
              this screen anywhere, so a reader told that "pageSize" was refused
              has nothing to go and change. */}
          <p>
            The filter <span className="font-medium">{parameterLabel(problem.parameter)}</span> was
            refused: {problem.detail}
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onClearFilters}
            className="min-h-11 w-fit focus-visible:ring-2"
          >
            Clear all filters
          </Button>
        </>,
      )

    case "invalid_cursor":
      return shell(
        "default",
        Info,
        CURSOR_RESET_TITLE,
        <p>
          The place this list had reached is no longer valid, so it has started again from the most
          recent records. Nothing was skipped.
        </p>,
      )

    case "unexpected":
    default:
      return shell(
        "destructive",
        AlertTriangle,
        hasRows ? "The list could not be updated" : "Recent work could not be loaded",
        <>
          <p>
            Something went wrong on our side.{" "}
            {hasRows ? "What is shown below is what we already had." : ""}
          </p>
          {retryButton}
        </>,
      )
  }
}

// ── the refused-cursor notice ──

/**
 * Shown when a cursor was REFUSED and page one was fetched instead.
 *
 * This is not the same as ProblemNotice's invalid_cursor branch. That branch
 * only renders while the problem is still current; the recovery SUCCEEDS, which
 * clears the problem and left the screen with nothing to show for a request the
 * server had rejected. State carries `cursorWasReset` precisely so the
 * successful recovery can still be reported, and this is what reports it.
 *
 * The wording has three jobs, in this order: say the position was not valid,
 * say we are back at the first page, and say nothing was skipped. A reader who
 * is only told the last of those cannot tell whether anything happened at all.
 */
export function CursorResetNotice() {
  return (
    <Alert role="status" aria-live="polite">
      <Info className="size-4" aria-hidden="true" />
      <AlertTitle>{CURSOR_RESET_TITLE}</AlertTitle>
      <AlertDescription className="flex flex-col gap-2">
        <p>
          The page position in the address was not valid, so the server refused it. This list has
          started again from the most recent records. Nothing was skipped.
        </p>
      </AlertDescription>
    </Alert>
  )
}

// ── the ignored-parameters notice ──

export interface IgnoredParamsNoticeProps {
  params: readonly string[]
  onClear(): void
}

/**
 * Shown when the address bar carries parameters this page does not implement.
 *
 * The page builds its API query from a fixed list of keys, so an extra one is
 * dropped on the way out and never reaches the server that would have refused
 * it. That is a quiet disagreement between a link and the list it produces, and
 * the reader is the only one who can resolve it -- so they are told which
 * parameter was ignored and offered a one-press way to drop it from the address.
 */
export function IgnoredParamsNotice({ params, onClear }: IgnoredParamsNoticeProps) {
  if (params.length === 0) return null
  return (
    <Alert role="status" aria-live="polite">
      <Info className="size-4" aria-hidden="true" />
      <AlertTitle>Part of this address was ignored</AlertTitle>
      <AlertDescription className="flex flex-col gap-2">
        <p>
          {params.length === 1
            ? "This list does not use the parameter "
            : "This list does not use the parameters "}
          <span className="break-words font-medium">{params.join(", ")}</span>
          {params.length === 1
            ? ", so it was ignored. Everything below answers the rest of the address."
            : ", so they were ignored. Everything below answers the rest of the address."}
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onClear}
          className="min-h-11 w-fit focus-visible:ring-2"
        >
          Remove it from the address
        </Button>
      </AlertDescription>
    </Alert>
  )
}

// ── filter bar ──

/**
 * focus-visible:ring-2, not ring-1.
 *
 * These controls set outline-none, so the ring IS the focus indicator, and at
 * ring-1 it rendered as a 1px box-shadow -- under the 2px minimum thickness
 * WCAG 2.4.11 asks of a focus appearance, and easy to lose against the border
 * it sits on (defect-activity-1px-focus-ring). Removing the outline is only
 * defensible when what replaces it is at least as visible.
 */
const CONTROL_CLASS =
  "min-h-11 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none"

function SelectField(props: {
  id: string
  label: string
  value: string
  placeholder: string
  options: readonly { value: string; label: string }[]
  onChange(value: string): void
}) {
  // A SELECT CANNOT DISPLAY A VALUE IT HAS NO OPTION FOR.
  //
  // The URL is the source of truth for every filter, and the API accepts values
  // this list does not offer: `?pageSize=5` returns five rows, but 5 is not one
  // of 10/25/50/100, so the control fell back to its first option and read
  // "25 (default)" beside a five-row list
  // (defect-activity-pagesize-not-reflected). The reader is then told something
  // false about the list they are looking at, and cannot see what to change.
  //
  // So the current value is added as an option when the list is missing it. The
  // fix is here rather than in the page-size field alone because every select on
  // this screen reads from the same URL and has the same hole.
  const known = props.options.some((option) => option.value === props.value)
  const options =
    props.value && !known
      ? [{ value: props.value, label: props.value + " (from the address)" }, ...props.options]
      : props.options

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <Label htmlFor={props.id} className="text-xs">
        {props.label}
      </Label>
      <select
        id={props.id}
        name={props.id}
        className={CONTROL_CLASS}
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
      >
        <option value="">{props.placeholder}</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  )
}

function TextField(props: {
  id: string
  label: string
  value: string
  type?: string
  hint?: string
  onChange(value: string): void
}) {
  const hintId = props.hint ? props.id + "-hint" : undefined
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <Label htmlFor={props.id} className="text-xs">
        {props.label}
      </Label>
      <Input
        id={props.id}
        name={props.id}
        type={props.type ?? "text"}
        // ring-2 overrides the Input primitive's ring-1 through tailwind-merge.
        // Scoped to this screen rather than changed app-wide, which is a larger
        // decision than this defect.
        className="min-h-11 focus-visible:ring-2"
        value={props.value}
        aria-describedby={hintId}
        onChange={(event) => props.onChange(event.target.value)}
      />
      {props.hint ? (
        <p id={hintId} className="text-xs text-muted-foreground">
          {props.hint}
        </p>
      ) : null}
    </div>
  )
}

export interface FilterBarProps {
  filters: ActivityFilters
  onChange(next: ActivityFilters): void
  onClear(): void
  showClear: boolean
}

export function FilterBar({ filters, onChange, onClear, showClear }: FilterBarProps) {
  const list = (key: (typeof LIST_FILTER_KEYS)[number], value: string) =>
    onChange(withListFilter(filters, key, value))
  const scalar = (key: (typeof SCALAR_FILTER_KEYS)[number], value: string) =>
    onChange(withScalarFilter(filters, key, value))

  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <SelectField
          id="activity-filter-source"
          label={parameterLabel("source")}
          placeholder="All systems"
          value={filters.source[0] ?? ""}
          options={SOURCE_OPTIONS}
          onChange={(value) => list("source", value)}
        />
        <SelectField
          id="activity-filter-family"
          label={parameterLabel("eventFamily")}
          placeholder="All kinds"
          value={filters.eventFamily[0] ?? ""}
          options={EVENT_FAMILY_OPTIONS}
          onChange={(value) => list("eventFamily", value)}
        />
        <SelectField
          id="activity-filter-ownership"
          label={parameterLabel("ownershipState")}
          placeholder="Anyone"
          value={filters.ownershipState[0] ?? ""}
          options={OWNERSHIP_OPTIONS}
          onChange={(value) => list("ownershipState", value)}
        />
        <SelectField
          id="activity-filter-status"
          label={parameterLabel("status")}
          placeholder="Any status"
          value={filters.status[0] ?? ""}
          options={STATUS_OPTIONS}
          onChange={(value) => list("status", value)}
        />
        <TextField
          id="activity-filter-from"
          label={parameterLabel("occurredFrom")}
          type="date"
          value={filters.occurredFrom}
          onChange={(value) => scalar("occurredFrom", value)}
        />
        <TextField
          id="activity-filter-to"
          label={parameterLabel("occurredTo")}
          type="date"
          value={filters.occurredTo}
          onChange={(value) => scalar("occurredTo", value)}
        />
        <TextField
          id="activity-filter-customer"
          label={parameterLabel("customer")}
          hint="The exact customer reference. This is not a name search."
          value={filters.customer}
          onChange={(value) => scalar("customer", value)}
        />
        <TextField
          id="activity-filter-actor"
          label={parameterLabel("actor")}
          hint="The exact actor reference. This is not a name search."
          value={filters.actor}
          onChange={(value) => scalar("actor", value)}
        />
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <div className="w-full sm:w-48">
          <SelectField
            id="activity-filter-page-size"
            label={parameterLabel("pageSize")}
            placeholder="25 (default)"
            value={filters.pageSize}
            options={[
              { value: "10", label: "10" },
              { value: "25", label: "25" },
              { value: "50", label: "50" },
              { value: "100", label: "100" },
            ]}
            onChange={(value) => scalar("pageSize", value)}
          />
        </div>
        {showClear ? (
          <Button
            type="button"
            variant="outline"
            onClick={onClear}
            className="min-h-11 focus-visible:ring-2"
          >
            Clear all filters
          </Button>
        ) : null}
      </div>
    </div>
  )
}
