/**
 * The scheduler, which is where "the client never issued its request" lived.
 *
 * The reported symptom was a page that showed its skeleton for a minute and a
 * half with no request to /api/v1/activity in the network panel at all, while a
 * hand-typed fetch from the same page answered in 442ms. Nothing was wrong with
 * the server, the session or the data: the browser had simply never asked,
 * because the in-flight lock the buttons used was also applied to the effect
 * that asks a NEW question, and the request holding that lock had already
 * finished.
 *
 * These tests pin the four rules the fix rests on: one request per question, a
 * new question is never dropped, a superseded answer never lands, and a reply
 * that never arrives cannot wedge the screen.
 */

import { describe, expect, it } from "vitest"

import type { LoadMode } from "./feed-controller"
import { createFeedScheduler } from "./feed-scheduler"

/** Lets the microtask queue drain, so a resolved `run` can reach its finally. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

interface Recorder {
  modes: LoadMode[]
  signals: AbortSignal[]
  /** Resolves the Nth (0-based) outstanding run. */
  settle(index: number): void
}

/** A `run` that records every call and hangs until the test releases it. */
function recorder(): { deps: { run(mode: LoadMode, signal: AbortSignal): Promise<void> } } & Recorder {
  const modes: LoadMode[] = []
  const signals: AbortSignal[] = []
  const settlers: Array<() => void> = []

  return {
    modes,
    signals,
    settle: (index: number) => settlers[index]?.(),
    deps: {
      run(mode: LoadMode, signal: AbortSignal): Promise<void> {
        modes.push(mode)
        signals.push(signal)
        return new Promise<void>((resolve) => settlers.push(resolve))
      },
    },
  }
}

describe("one request per question", () => {
  it("issues exactly one request on mount", () => {
    const r = recorder()
    const scheduler = createFeedScheduler(r.deps)

    scheduler.start("source=|25")

    expect(r.modes).toEqual(["initial"])
  })

  it("does not issue a second when the effect replays with the same key", () => {
    // A remount, or React StrictMode's double invoke in development. The same
    // question asked twice is one request, not two.
    const r = recorder()
    const scheduler = createFeedScheduler(r.deps)

    scheduler.start("source=|25")
    scheduler.start("source=|25")
    scheduler.start("source=|25")

    expect(r.modes).toEqual(["initial"])
  })

  it("still issues one after the first has come back", async () => {
    const r = recorder()
    const scheduler = createFeedScheduler(r.deps)

    scheduler.start("k1")
    r.settle(0)
    await flush()

    scheduler.start("k1")
    expect(r.modes).toEqual(["initial"])
  })
})

describe("a new question is never dropped", () => {
  it("REGRESSION: a changed key issues its request while the first is still in flight", () => {
    // This is the defect. The old guard returned here and nothing ever asked
    // the server the second question, so the screen sat on a skeleton for as
    // long as the reader was willing to wait.
    const r = recorder()
    const scheduler = createFeedScheduler(r.deps)

    scheduler.start("k1")
    scheduler.start("k2")

    expect(r.modes).toEqual(["initial", "initial"])
  })

  it("aborts the superseded request and leaves the live one alone", () => {
    const r = recorder()
    const scheduler = createFeedScheduler(r.deps)

    scheduler.start("k1")
    scheduler.start("k2")

    expect(r.signals[0].aborted).toBe(true)
    expect(r.signals[1].aborted).toBe(false)
  })

  it("is not blocked by a lock a request that never answers is holding", () => {
    // The first request hangs for ever. Three further questions still go out.
    const r = recorder()
    const scheduler = createFeedScheduler(r.deps)

    scheduler.start("k1")
    scheduler.start("k2")
    scheduler.start("k3")
    scheduler.start("k4")

    expect(r.modes).toHaveLength(4)
    expect(r.signals.filter((s) => s.aborted)).toHaveLength(3)
  })
})

describe("a superseded answer never lands", () => {
  it("a late reply from an aborted request does not release the live lock", async () => {
    const r = recorder()
    const scheduler = createFeedScheduler(r.deps)

    scheduler.start("k1")
    scheduler.start("k2")

    // k1 finally answers, long after it stopped being what anyone wanted.
    r.settle(0)
    await flush()

    // k2 is still running, and the screen must still say so.
    expect(scheduler.isBusy()).toBe(true)
  })

  it("clears the lock when the LIVE request answers", async () => {
    const r = recorder()
    const scheduler = createFeedScheduler(r.deps)

    scheduler.start("k1")
    scheduler.start("k2")
    r.settle(1)
    await flush()

    expect(scheduler.isBusy()).toBe(false)
  })
})

describe("refresh and load more still coalesce", () => {
  it("a second press while one is running is a no-op", () => {
    const r = recorder()
    const scheduler = createFeedScheduler(r.deps)

    scheduler.start("k1")
    scheduler.refresh()
    scheduler.loadMore()

    expect(r.modes).toEqual(["initial"])
  })

  it("works again once the load has come back", async () => {
    const r = recorder()
    const scheduler = createFeedScheduler(r.deps)

    scheduler.start("k1")
    r.settle(0)
    await flush()

    scheduler.refresh()
    expect(r.modes).toEqual(["initial", "refresh"])

    r.settle(1)
    await flush()

    scheduler.loadMore()
    expect(r.modes).toEqual(["initial", "refresh", "more"])
  })
})

describe("a run that throws cannot wedge the screen", () => {
  it("releases the lock and stays usable", async () => {
    const modes: LoadMode[] = []
    const scheduler = createFeedScheduler({
      run: async (mode) => {
        modes.push(mode)
        throw new Error("boom")
      },
    })

    scheduler.start("k1")
    await flush()

    expect(scheduler.isBusy()).toBe(false)
    scheduler.refresh()
    expect(modes).toEqual(["initial", "refresh"])
  })
})
