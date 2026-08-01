/**
 * ONE HEADING AND ONE LANDMARK ID, AT EVERY STAGE OF THE STREAM.
 *
 * The served /activity document contained TWO elements with id="recent-work",
 * two with id="recent-work-title" and two h1s. That is not a rendering glitch
 * and it is not transient in the way a reader would forgive: React reveals a
 * Suspense boundary by inserting the resolved subtree into the live DOM next to
 * the fallback and only then removing the fallback, so for that window the page
 * really does have two landmarks with the same id, two skip-link targets and two
 * page headings. Anything navigating by heading or landmark -- a screen reader,
 * a skip link, `document.getElementById` -- gets an arbitrary one of the pair.
 *
 * The cause was that RecentWorkLoading (the fallback) and RecentWorkView (the
 * content) each rendered the whole page frame, heading included. The fix moved
 * the frame into RecentWorkShell, ABOVE the boundary, where it renders once.
 *
 * This file pins the invariant at all three stages a reader can observe:
 *   1. fallback only, before the boundary resolves;
 *   2. both present, which is what the streamed document and the live DOM
 *      actually hold while React swaps them;
 *   3. content only, after the swap.
 *
 * Stage 2 is asserted twice: once by composing the two subtrees, and once
 * against the real bytes react-dom/server streams for a boundary that suspended.
 */

import { Suspense, use, type ReactElement } from "react"
import { renderToPipeableStream, renderToStaticMarkup } from "react-dom/server"
import { Writable } from "node:stream"
import { describe, expect, it } from "vitest"
import fs from "node:fs"
import path from "node:path"

import {
  RecentWorkLoading,
  RecentWorkShell,
  RecentWorkView,
} from "@/components/activity/recent-work-view"
import { initialFeedState, type FeedState } from "@/components/activity/feed-controller"
import { EMPTY_FILTERS } from "@/components/activity/filters"
import {
  ACTIVITY_SOURCE_ORDER,
  type ActivityFeedItem,
  type ActivitySourceReport,
} from "@/components/activity/types"

const T0 = "2026-07-31T22:00:00.000Z"
const NOW = new Date("2026-07-31T22:05:00.000Z")
const noop = () => {}

const count = (html: string, pattern: RegExp) => (html.match(pattern) ?? []).length

function item(): ActivityFeedItem {
  return {
    activityId: "a-1",
    eventType: "staff.note",
    title: "Note added",
    summary: "Rang the customer back",
    sourceSystem: "odoo",
    provenance: {
      source: "staff_work_action",
      fetchedAt: T0,
      trust: "authoritative",
      upstreamRef: null,
    },
    actor: { ref: "staff:7", label: "Maria", kind: "staff" },
    companyId: "tenant-1",
    customerId: null,
    customerLabel: null,
    relatedObjectType: null,
    relatedObjectId: null,
    occurredAt: T0,
    receivedAt: T0,
    status: "recorded",
    ownershipState: null,
    availableActions: [],
    nativeLinks: [],
    dataMode: "production",
    freshness: { ageSeconds: 10, stale: false },
  }
}

const allOk = (): ActivitySourceReport[] =>
  ACTIVITY_SOURCE_ORDER.map((source) => ({
    source,
    state: "ok" as const,
    fetchedAt: T0,
    mode: "production" as const,
  }))

const ready = (): FeedState => ({
  ...initialFeedState(),
  phase: "ready",
  items: [item()],
  sources: allOk(),
  dataState: "available_with_records",
  generatedAt: T0,
  lastLoadedAt: T0,
})

const view = () => (
  <RecentWorkView
    state={ready()}
    filters={EMPTY_FILTERS}
    now={NOW}
    onRefresh={noop}
    onLoadMore={noop}
    onFiltersChange={noop}
    onClearFilters={noop}
  />
)

/** Collects everything react-dom/server emits, including the boundary swap. */
async function streamToString(element: ReactElement): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let html = ""
    const sink = new Writable({
      write(chunk, _encoding, callback) {
        html += String(chunk)
        callback()
      },
    })
    sink.on("finish", () => resolve(html))
    const { pipe } = renderToPipeableStream(element, {
      // The SHELL, not the finished document. Piping here is what puts the
      // fallback into the bytes, exactly as a browser receives them; the
      // content that resolves later is appended to the same stream. Waiting for
      // onAllReady would emit the resolved tree only and prove nothing about
      // the window where both are present.
      onShellReady() {
        pipe(sink)
      },
      onError(error) {
        reject(error)
      },
    })
  })
}

/** Suspends once, so the boundary really streams rather than resolving inline. */
function Deferred({ gate, children }: { gate: Promise<void>; children: React.ReactNode }) {
  use(gate)
  return <>{children}</>
}

// ── the invariant ──

describe("exactly one heading and one landmark id at every streaming stage", () => {
  const fallbackOnly = renderToStaticMarkup(
    <RecentWorkShell>
      <RecentWorkLoading />
    </RecentWorkShell>,
  )

  // What the DOM holds between "content arrived" and "fallback removed".
  const bothPresent = renderToStaticMarkup(
    <RecentWorkShell>
      <RecentWorkLoading />
      {view()}
    </RecentWorkShell>,
  )

  const contentOnly = renderToStaticMarkup(<RecentWorkShell>{view()}</RecentWorkShell>)

  const stages: Array<[string, string]> = [
    ["fallback only", fallbackOnly],
    ["fallback and content together", bothPresent],
    ["content only", contentOnly],
  ]

  for (const [name, html] of stages) {
    it(`has one id="recent-work" at the ${name} stage`, () => {
      expect(count(html, /id="recent-work"/g)).toBe(1)
    })

    it(`has one h1 at the ${name} stage`, () => {
      expect(count(html, /<h1[\s>]/g)).toBe(1)
      expect(count(html, /id="recent-work-title"/g)).toBe(1)
      expect(html).toContain("Recent Work</h1>")
    })
  }

  it("REGRESSION: the fallback carries neither the id nor a heading of its own", () => {
    const fallback = renderToStaticMarkup(<RecentWorkLoading />)
    expect(fallback).not.toContain("id=\"recent-work\"")
    expect(fallback).not.toContain("id=\"recent-work-title\"")
    expect(fallback).not.toMatch(/<h1[\s>]/)
    // ...and it is still the full-page skeleton it is supposed to be.
    expect(fallback).toContain("data-activity-feed=\"loading\"")
    expect(fallback).toContain("aria-busy=\"true\"")
    expect(fallback).toContain("Loading your recent work")
  })

  it("REGRESSION: the resolved content carries neither either", () => {
    const content = renderToStaticMarkup(view())
    expect(content).not.toContain("id=\"recent-work\"")
    expect(content).not.toContain("id=\"recent-work-title\"")
    expect(content).not.toMatch(/<h1[\s>]/)
    expect(content).toContain("data-activity-feed=\"ready\"")
  })
})

describe("the bytes react-dom actually streams", () => {
  it("carries one id and one h1 even though it carries both subtrees", async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    // Resolve on the next tick, so the shell flushes with the fallback in it
    // first and the content is streamed in behind it -- the same two-part
    // document a browser receives.
    setTimeout(() => release(), 0)

    const html = await streamToString(
      <RecentWorkShell>
        <Suspense fallback={<RecentWorkLoading />}>
          <Deferred gate={gate}>{view()}</Deferred>
        </Suspense>
      </RecentWorkShell>,
    )

    // The document really does hold both subtrees: this is the streaming the
    // defect report observed, not a race that happened to be avoided.
    expect(html).toContain("data-activity-feed=\"loading\"")
    expect(html).toContain("data-activity-feed=\"ready\"")

    // And exactly one of each of the things that must be unique.
    expect(count(html, /id="recent-work"/g)).toBe(1)
    expect(count(html, /id="recent-work-title"/g)).toBe(1)
    expect(count(html, /<h1[\s>]/g)).toBe(1)
  })
})

describe("the route renders the frame above the boundary", () => {
  const source = fs
    .readFileSync(path.resolve(__dirname, "..", "app/(owner)/activity/page.tsx"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")

  it("opens the shell before the Suspense boundary", () => {
    const shell = source.indexOf("<RecentWorkShell>")
    const boundary = source.indexOf("<Suspense")
    expect(shell).toBeGreaterThanOrEqual(0)
    expect(boundary).toBeGreaterThan(shell)
  })

  it("keeps the skeleton as the fallback", () => {
    expect(source).toContain("fallback={<RecentWorkLoading />}")
  })
})
