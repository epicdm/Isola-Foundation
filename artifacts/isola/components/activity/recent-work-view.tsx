/**
 * Recent Work, as markup. A PURE component: state in, screen out.
 *
 * There is not one hook in this file. That is what makes every state on this
 * screen testable in a workspace with no jsdom and no testing-library: the tests
 * build a FeedState, render this with renderToStaticMarkup, and assert the HTML
 * a reader would actually be sent.
 *
 * LANDMARKS
 * ---------
 * The root is a SECTION, not a MAIN. components/ui/sidebar.tsx already renders
 * the pages one and only main landmark through SidebarInset, and a second main
 * makes the first meaningless to anything navigating by landmark.
 *
 * WHAT IS ANNOUNCED
 * -----------------
 * Three polite live regions and no assertive ones: the data-state line, the
 * warnings, and the record count. Politeness is deliberate. A feed that
 * interrupts a screen-reader user mid-sentence every time a refresh completes is
 * worse than one that waits for a pause.
 *
 * A FAILURE NEVER TAKES THE ROWS AWAY
 * -----------------------------------
 * Notices sit ABOVE the list, never instead of it. A partial answer, a failed
 * refresh and a stale source all leave every record that did arrive on screen,
 * because those records are still true.
 */

import { AlertTriangle, FlaskConical, Info, RefreshCw } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"

import { ActivityRow } from "./activity-row"
import { FilterBar, ProblemNotice, SourcePanel } from "./activity-panels"
import { canLoadMore, isBusy, rowsPerSource, type FeedState } from "./feed-controller"
import { isFilterActive, type ActivityFilters } from "./filters"
import { absoluteTime, dataStateNotice, relativeTime, sourceLabel } from "./labels"

export interface RecentWorkViewProps {
  state: FeedState
  filters: ActivityFilters
  /** Passed in so relative times are deterministic and hydration-safe. */
  now: Date
  onRefresh(): void
  onLoadMore(): void
  onFiltersChange(next: ActivityFilters): void
  onClearFilters(): void
}

/** The Suspense fallback, and the shape of the first paint. */
export function RecentWorkLoading() {
  return (
    <div className="flex flex-col gap-6" aria-busy="true">
      <Skeleton className="h-8 w-56 motion-reduce:animate-none" />
      <Skeleton className="h-4 w-full max-w-prose motion-reduce:animate-none" />
      <Skeleton className="h-40 w-full motion-reduce:animate-none" />
    </div>
  )
}

function RowSkeletons() {
  return (
    <ul role="list" aria-busy="true" className="flex flex-col">
      {[0, 1, 2, 3, 4].map((index) => (
        <li key={index} className="flex flex-col gap-2 border-b px-4 py-4 last:border-b-0 sm:px-6">
          <Skeleton className="h-4 w-2/3 motion-reduce:animate-none" />
          <Skeleton className="h-3 w-full motion-reduce:animate-none" />
          <Skeleton className="h-3 w-1/2 motion-reduce:animate-none" />
        </li>
      ))}
    </ul>
  )
}

export function RecentWorkView(props: RecentWorkViewProps) {
  const { state, filters, now } = props
  const busy = isBusy(state)
  const notice = dataStateNotice(state.dataState)
  const counts = rowsPerSource(state.items)
  const loaded = state.sources.length > 0

  const firstLoad = state.items.length === 0 && (state.phase === "loading" || state.phase === "idle")
  // A blocking problem is one where there is nothing on screen behind it. With
  // rows present the same problem is a warning ABOVE the list, not instead of it.
  const blocking = state.problem !== null && state.items.length === 0
  const showEmpty =
    !firstLoad && !blocking && state.items.length === 0 && state.phase === "ready"

  const degraded = state.sources.filter(
    (report) => report.state === "unavailable" || report.state === "forbidden",
  )
  const stale = state.sources.filter((report) => report.state === "stale")

  return (
    <section aria-labelledby="recent-work-title" className="flex w-full min-w-0 flex-col gap-6">
      <header className="flex flex-col gap-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 id="recent-work-title" className="text-2xl font-semibold tracking-tight">
              Recent Work
            </h1>
            <p className="max-w-prose text-sm text-muted-foreground">
              One list of what your team, your assistants and your connected systems have done,
              newest first, with the system every record came from.
            </p>
          </div>
          <Button
            type="button"
            onClick={props.onRefresh}
            disabled={busy}
            className="min-h-11 motion-reduce:transition-none"
          >
            <RefreshCw
              className={busy ? "size-4 animate-spin motion-reduce:animate-none" : "size-4"}
              aria-hidden="true"
            />
            {busy ? "Refreshing" : "Refresh"}
          </Button>
        </div>

        {/* The honest header line: what state this list is in, when the API built
            it, and when WE last got a good answer. Those last two are different
            questions and a screen that shows only one of them cannot tell a
            reader whether they are looking at something old. */}
        <div
          role="status"
          aria-live="polite"
          className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground"
        >
          <span className="inline-flex items-center gap-1.5 font-medium text-foreground">
            {notice.tone === "warning" ? (
              <AlertTriangle className="size-3.5 shrink-0" aria-hidden="true" />
            ) : (
              <Info className="size-3.5 shrink-0" aria-hidden="true" />
            )}
            {notice.label}
          </span>
          <span className="break-words">{notice.explanation}</span>
          <span>
            {state.generatedAt
              ? "Prepared " + absoluteTime(state.generatedAt)
              : "Not prepared yet"}
          </span>
          <span>
            {state.lastLoadedAt
              ? "Last successful refresh " + relativeTime(state.lastLoadedAt, now)
              : "No successful refresh yet"}
          </span>
        </div>
      </header>

      <section aria-labelledby="activity-filters-title" className="flex flex-col gap-3">
        <h2 id="activity-filters-title" className="text-sm font-semibold">
          Narrow the list
        </h2>
        <FilterBar
          filters={filters}
          onChange={props.onFiltersChange}
          onClear={props.onClearFilters}
          showClear={isFilterActive(filters)}
        />
      </section>

      <section aria-labelledby="activity-sources-title" className="flex flex-col gap-3">
        <h2 id="activity-sources-title" className="text-sm font-semibold">
          Where these records come from
        </h2>
        <SourcePanel sources={state.sources} counts={counts} loaded={loaded} />
      </section>

      {/* Warnings. Polite, non-blocking, and always above a list that keeps
          whatever it already had. */}
      <div aria-live="polite" className="flex flex-col gap-3">
        {state.problem ? (
          <ProblemNotice
            problem={state.problem}
            hasRows={state.items.length > 0}
            onRetry={props.onRefresh}
            onClearFilters={props.onClearFilters}
            busy={busy}
          />
        ) : null}

        {degraded.length > 0 ? (
          <div
            role="status"
            className="flex flex-col gap-1 rounded-lg border border-amber-600/50 p-3 text-sm"
          >
            <span className="inline-flex items-center gap-1.5 font-medium">
              <AlertTriangle className="size-4 shrink-0" aria-hidden="true" />
              This list is incomplete
            </span>
            {/* Named, not counted. "1 source unavailable" tells a reader nothing
                they can act on; the name tells them what is missing. */}
            {degraded.map((report) => (
              <p key={report.source} className="break-words text-muted-foreground">
                {sourceLabel(report.source)}
                {report.state === "forbidden"
                  ? ": these records are not available to this account, so none of them are below."
                  : ": we could not reach this system, so anything it holds is missing below."}
              </p>
            ))}
          </div>
        ) : null}

        {stale.length > 0 ? (
          <div
            role="status"
            className="flex flex-col gap-1 rounded-lg border border-amber-600/50 p-3 text-sm"
          >
            <span className="font-medium">Some of this is older than the rest</span>
            {stale.map((report) => (
              <p key={report.source} className="break-words text-muted-foreground">
                {sourceLabel(report.source)} answered with information from an earlier read
                {report.fetchedAt ? ", taken " + absoluteTime(report.fetchedAt) : ""}.
              </p>
            ))}
          </div>
        ) : null}

        {state.containsFixture ? (
          <div
            role="status"
            className="flex items-center gap-2 rounded-lg border border-amber-600/50 p-3 text-sm"
          >
            <FlaskConical className="size-4 shrink-0" aria-hidden="true" />
            <span>
              Some rows below are sample data, not real records. They are marked individually.
            </span>
          </div>
        ) : null}
      </div>

      <section aria-labelledby="activity-records-title" className="flex flex-col gap-3">
        <h2 id="activity-records-title" className="text-sm font-semibold">
          Records
        </h2>

        <Card className="min-w-0 overflow-hidden">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm" aria-live="polite">
              {state.items.length === 1
                ? "1 record shown"
                : state.items.length + " records shown"}
            </CardTitle>
          </CardHeader>

          <CardContent className="p-0">
            {firstLoad ? <RowSkeletons /> : null}

            {!firstLoad && state.items.length > 0 ? (
              <ol role="list" className="flex flex-col">
                {state.items.map((item) => (
                  <ActivityRow key={item.activityId} item={item} now={now} />
                ))}
              </ol>
            ) : null}

            {showEmpty ? (
              <div className="flex flex-col items-center gap-2 px-4 py-12 text-center">
                <p className="text-sm font-medium">Nothing to show</p>
                <p className="max-w-prose text-sm text-muted-foreground">
                  {isFilterActive(filters)
                    ? "No records match these filters. Every system that answered had nothing for this question."
                    : "Every system answered and none of them had anything to report yet."}
                </p>
                {isFilterActive(filters) ? (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={props.onClearFilters}
                    className="min-h-11"
                  >
                    Clear all filters
                  </Button>
                ) : null}
              </div>
            ) : null}
          </CardContent>
        </Card>

        {/* A real button, focusable and reachable by keyboard. There is no
            infinite scroll on this screen at all, so there is nothing a reader
            can fail to trigger by not being able to scroll a container. */}
        {state.nextCursor ? (
          <div className="flex flex-col gap-1">
            <Button
              type="button"
              variant="outline"
              onClick={props.onLoadMore}
              disabled={!canLoadMore(state)}
              className="min-h-11 w-full sm:w-fit"
            >
              {state.phase === "loading_more" ? "Loading more" : "Load more"}
            </Button>
            <p className="text-xs text-muted-foreground">
              Continues from where this page ends, using the position the server gave us.
            </p>
          </div>
        ) : state.items.length > 0 ? (
          <p className="text-xs text-muted-foreground">That is the end of the list.</p>
        ) : null}
      </section>
    </section>
  )
}
