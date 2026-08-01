/**
 * WHEN a load happens, with no React in it.
 *
 * This is the half of use-activity-feed.ts that used to be four refs and an
 * `if`. It was moved out because it is where the worst defect on this screen
 * lived and there is no jsdom in this workspace, so anything left inside a
 * component is logic nobody can exercise. Here it is a plain object with a
 * stubbed `run`, tested in node, deterministically.
 *
 * THE DEFECT THIS FILE EXISTS TO PREVENT
 * --------------------------------------
 * The old guard was a single boolean:
 *
 *     if (inFlight.current) return
 *
 * applied to EVERY load, including the one caused by a new question. So this
 * sequence lost a request outright:
 *
 *   1. the page mounts and the first load starts;
 *   2. the filters resolve (or the reader changes one) before it comes back,
 *      which is a different question and a different key;
 *   3. the effect for the new key runs, sees the lock, and RETURNS.
 *
 * Nothing ever asked the server the second question. The screen sat on a
 * skeleton, or on rows that answered a question nobody was asking any more, and
 * no amount of waiting fixed it because there was nothing in flight to wait for
 * -- the only thing that could clear the lock had already finished
 * (defect-activity-feed-request-never-issued).
 *
 * THE RULES NOW
 * -------------
 * 1. A NEW QUESTION IS NEVER DROPPED. It aborts whatever is in flight and takes
 *    its place. A lock may make a duplicate press harmless; it may not make a
 *    question disappear.
 * 2. THE SAME QUESTION IS ASKED ONCE. `start` is keyed, so an effect that
 *    replays with an unchanged key -- a remount, StrictMode's double invoke --
 *    issues no second request.
 * 3. A SUPERSEDED ANSWER NEVER LANDS. The signal it was given is already
 *    aborted, and `run` is required to check that before it writes anything.
 * 4. REFRESH AND LOAD MORE STILL COALESCE. Those are the same question asked
 *    twice, so the second press while one is running is genuinely a no-op.
 * 5. THE LOCK CANNOT OUTLIVE ITS REQUEST. Only the latest request may clear it,
 *    and any new question clears it regardless, so a reply that never comes can
 *    no longer wedge the screen for ever.
 */

import type { LoadMode } from "./feed-controller"

export interface FeedSchedulerDeps {
  /**
   * Performs one load. Given the signal for THIS request: when it is aborted the
   * request has been superseded and nothing it produces may be applied.
   */
  run(mode: LoadMode, signal: AbortSignal): Promise<void>
}

export interface FeedScheduler {
  /**
   * The load caused by arriving at a question. Keyed: the same key twice is one
   * request, a different key always issues one, whatever is in flight.
   */
  start(key: string): void
  refresh(): void
  loadMore(): void
  /** True while a request is outstanding. Drives the busy state in tests. */
  isBusy(): boolean
}

export function createFeedScheduler(deps: FeedSchedulerDeps): FeedScheduler {
  let current: AbortController | null = null
  let busy = false
  let startedKey: string | null = null

  function begin(mode: LoadMode): void {
    // Whatever was running is answering an older question. Abort it first so
    // `run` can tell that its own result is no longer wanted.
    current?.abort()
    const own = new AbortController()
    current = own
    busy = true

    void (async () => {
      try {
        await deps.run(mode, own.signal)
      } catch {
        // `run` owns its own error reporting -- runLoad turns every failure into
        // a FeedState -- so nothing should arrive here. If something does it
        // must not become an unhandled rejection, and above all it must not skip
        // the release below: a lock nobody can clear is a screen that never
        // loads again.
      } finally {
        // Only the request that is still the current one may clear the lock. A
        // late reply from a superseded request must not report the live one as
        // finished.
        if (current === own) {
          current = null
          busy = false
        }
      }
    })()
  }

  return {
    start(key: string): void {
      if (startedKey === key) return
      startedKey = key
      begin("initial")
    },
    refresh(): void {
      if (busy) return
      begin("refresh")
    },
    loadMore(): void {
      if (busy) return
      begin("more")
    },
    isBusy: () => busy,
  }
}
