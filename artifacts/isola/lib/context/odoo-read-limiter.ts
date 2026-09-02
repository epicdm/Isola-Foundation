/**
 * odoo-read-limiter@1 — at most N reads in flight per Odoo instance.
 *
 * THE EVIDENCE
 * -----------
 * `buildContextBundle` runs its adapters through `Promise.all`, and four of the
 * Customer 360 adapters read Odoo. In production one of those four returned
 * **HTTP 429** while the other three succeeded against the same instance, at
 * the same moment. That is not a plan limitation, not a model problem and not
 * bad luck — it is four requests arriving together and one being shed.
 *
 * The classification of that failure was corrected in the previous release.
 * This module addresses the collision itself.
 *
 * WHY THE KEY IS THE INSTANCE URL
 * ------------------------------
 * The limit belongs to the thing being protected, which is one Odoo server.
 * Keying on anything narrower (a tenant, a customer) would let two tenants
 * sharing an instance collide exactly as before. Keying on anything broader (a
 * global limit across all connectors) would make an unrelated provider's slow
 * call delay a customer page for no reason.
 *
 * Two tenants on two different Odoo instances therefore never wait on each
 * other, and nothing that is not an Odoo read passes through here at all.
 *
 * WHAT THIS DELIBERATELY IS NOT
 * ----------------------------
 * It is not a retry. A retry answers "it failed, try again"; this answers
 * "don't send them all at once". Reaching for retries first would have left the
 * collision in place and added load to the thing already shedding it. The order
 * permits one bounded 429 retry and prefers shipping without it when the
 * limiter alone is enough — it is, so there is none here.
 *
 * It is not a queue that can swallow a request. A caller that waits forever is
 * worse than one that fails, because a page that never finishes cannot even
 * report that something went wrong. A read that cannot get a slot inside the
 * bounded wait gives up with a timeout, which `classifyOdooFailure` already
 * maps to `dependency_timeout` → `unavailable`. Never `empty`.
 */

export const ODOO_READ_LIMITER_VERSION = 'odoo-read-limiter@1' as const

/**
 * Two, not four, and not one.
 *
 * Four is the count that produced the 429. One would serialise the whole page
 * and roughly quadruple the time to first complete section for no evidence that
 * it is needed. Two is the smallest reduction that keeps some parallelism, and
 * the production sample decides whether it holds — if a bounded sample still
 * shows 429, this becomes 1 rather than growing a retry.
 */
export const ODOO_READ_CONCURRENCY_LIMIT = 2

/**
 * How long a read may wait for a slot before giving up.
 *
 * Comfortably longer than a healthy read and comfortably shorter than the
 * route's own patience, so the failure a reader sees is "this section could not
 * be read", not a page that hangs.
 */
export const ODOO_QUEUE_WAIT_TIMEOUT_MS = 15_000

interface InstanceState {
  active: number
  /** FIFO. Order is deterministic so a queued read cannot be starved. */
  waiting: Array<{ grant: () => void; cancel: (err: Error) => void }>
}

/**
 * Module-level, because the limit protects a server that is itself shared
 * across every request this process handles. Per-request state would limit
 * nothing.
 *
 * Holds counters and resolvers ONLY: no config, no credentials, no customer
 * data, no request or response bodies. There is nothing in here worth leaking.
 */
const instances = new Map<string, InstanceState>()

/**
 * One instance, one key. Trailing slashes and case differences in a configured
 * URL must not open a second lane to the same server.
 */
export function normaliseInstanceKey(url: string | null | undefined): string {
  const raw = (url ?? '').trim().replace(/\/+$/, '')
  if (!raw) return 'odoo:unconfigured'
  return `odoo:${raw.toLowerCase()}`
}

function stateFor(key: string): InstanceState {
  let state = instances.get(key)
  if (!state) {
    state = { active: 0, waiting: [] }
    instances.set(key, state)
  }
  return state
}

/** Drop an instance the moment nothing is using it, so the map cannot grow. */
function releaseSlot(key: string): void {
  const state = instances.get(key)
  if (!state) return

  const next = state.waiting.shift()
  if (next) {
    // Hand the slot straight over; `active` stays as it is.
    next.grant()
    return
  }

  state.active -= 1
  if (state.active <= 0 && state.waiting.length === 0) instances.delete(key)
}

export interface LimiterOptions {
  /** Overridable so tests need no real clock. */
  limit?: number
  queueWaitMs?: number
  setTimeoutFn?: typeof setTimeout
  clearTimeoutFn?: typeof clearTimeout
}

/**
 * Run `fn` once a slot is free for this instance.
 *
 * The slot is released in a `finally`, so a read that throws — refused, timed
 * out, cancelled — frees its slot exactly like one that succeeds. A limiter
 * that leaked slots on failure would degrade to a deadlock precisely when the
 * dependency is already unhealthy.
 */
export async function limitOdooReads<T>(
  key: string,
  fn: () => Promise<T>,
  options: LimiterOptions = {},
): Promise<T> {
  const limit = Math.max(1, options.limit ?? ODOO_READ_CONCURRENCY_LIMIT)
  const waitMs = options.queueWaitMs ?? ODOO_QUEUE_WAIT_TIMEOUT_MS
  const setTimer = options.setTimeoutFn ?? setTimeout
  const clearTimer = options.clearTimeoutFn ?? clearTimeout

  const state = stateFor(key)

  if (state.active < limit) {
    state.active += 1
  } else {
    await new Promise<void>((resolve, reject) => {
      const entry = {
        grant: () => {
          clearTimer(timer)
          resolve()
        },
        cancel: (err: Error) => reject(err),
      }

      const timer = setTimer(() => {
        // Remove ourselves from the queue first; a cancelled waiter must not
        // later be handed a slot nobody is holding.
        const at = state.waiting.indexOf(entry)
        if (at >= 0) state.waiting.splice(at, 1)
        if (state.active <= 0 && state.waiting.length === 0) instances.delete(key)
        // The word "timed out" is what classifyOdooFailure keys on, so this
        // surfaces as `unavailable` with the right sentence — never as `empty`.
        entry.cancel(new Error('the read timed out waiting for a free connection to the source'))
      }, waitMs)

      state.waiting.push(entry)
    })
  }

  try {
    return await fn()
  } finally {
    releaseSlot(key)
  }
}

/* ── inspection, for tests and for bounded instrumentation ─────────────────*/

export interface LimiterSnapshot {
  key: string
  active: number
  waiting: number
  limit: number
}

/**
 * Counters only. Safe to log: it names an instance key derived from a
 * configured URL and two integers, and holds nothing else by construction.
 */
export function limiterSnapshot(key: string): LimiterSnapshot {
  const state = instances.get(key)
  return {
    key,
    active: state?.active ?? 0,
    waiting: state?.waiting.length ?? 0,
    limit: ODOO_READ_CONCURRENCY_LIMIT,
  }
}

/** How many instances currently hold state. Zero when everything is idle. */
export function trackedInstanceCount(): number {
  return instances.size
}

/** Test-only. Never called by application code. */
export function resetOdooReadLimiter(): void {
  instances.clear()
}
