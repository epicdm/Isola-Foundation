import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  ODOO_READ_CONCURRENCY_LIMIT,
  limitOdooReads,
  limiterSnapshot,
  normaliseInstanceKey,
  resetOdooReadLimiter,
  trackedInstanceCount,
} from './odoo-read-limiter'

/**
 * A promise the test resolves by hand. Concurrency is then a FACT the test
 * controls rather than a race it hopes to win — no sleeps, no fake clocks for
 * the ordinary paths.
 */
function deferred<T = void>() {
  let resolve!: (value: T) => void
  let reject!: (err: Error) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const A = normaliseInstanceKey('https://a.odoo.com')
const B = normaliseInstanceKey('https://b.odoo.com')

afterEach(() => {
  resetOdooReadLimiter()
  vi.useRealTimers()
})

/* ── the limit ─────────────────────────────────────────────────────────────*/

describe('at most two reads are in flight per instance', () => {
  it('never exceeds the limit, however many are asked for', async () => {
    let active = 0
    let peak = 0
    const gates = [deferred(), deferred(), deferred(), deferred()]

    const runs = gates.map((gate) =>
      limitOdooReads(A, async () => {
        active += 1
        peak = Math.max(peak, active)
        await gate.promise
        active -= 1
        return 'ok'
      }),
    )

    // Nothing has been released, so exactly the limit is running.
    await Promise.resolve()
    expect(peak).toBe(ODOO_READ_CONCURRENCY_LIMIT)
    expect(peak).toBe(2)
    expect(limiterSnapshot(A).active).toBe(2)
    expect(limiterSnapshot(A).waiting).toBe(2)

    gates.forEach((g) => g.resolve())
    await Promise.all(runs)
    expect(peak).toBe(2)
  })

  it('starts a queued read as soon as a slot is released', async () => {
    const started: string[] = []
    const gates: Record<string, ReturnType<typeof deferred>> = {
      one: deferred(),
      two: deferred(),
      three: deferred(),
    }

    const run = (name: string) =>
      limitOdooReads(A, async () => {
        started.push(name)
        await gates[name].promise
        return name
      })

    const p1 = run('one')
    const p2 = run('two')
    const p3 = run('three')

    await Promise.resolve()
    expect(started).toEqual(['one', 'two'])

    gates.one.resolve()
    await p1
    await Promise.resolve()
    expect(started).toEqual(['one', 'two', 'three'])

    gates.two.resolve()
    gates.three.resolve()
    await Promise.all([p2, p3])
  })

  it('serves the queue in order', async () => {
    const started: number[] = []
    const gate = deferred()
    const running = [0, 1, 2, 3, 4].map((n) =>
      limitOdooReads(A, async () => {
        started.push(n)
        await gate.promise
        return n
      }),
    )

    await Promise.resolve()
    gate.resolve()
    await Promise.all(running)

    expect(started).toEqual([0, 1, 2, 3, 4])
  })
})

/* ── instances are independent ─────────────────────────────────────────────*/

describe('different Odoo instances do not wait on each other', () => {
  it('lets each instance reach its own limit at the same time', async () => {
    const gate = deferred()
    const start = (key: string) => limitOdooReads(key, async () => { await gate.promise; return key })

    const runs = [start(A), start(A), start(B), start(B)]
    await Promise.resolve()

    expect(limiterSnapshot(A).active).toBe(2)
    expect(limiterSnapshot(B).active).toBe(2)
    expect(limiterSnapshot(A).waiting).toBe(0)
    expect(limiterSnapshot(B).waiting).toBe(0)

    gate.resolve()
    await Promise.all(runs)
  })

  it('does not let a saturated instance delay another one', async () => {
    const blocked = deferred()
    const saturating = [
      limitOdooReads(A, () => blocked.promise),
      limitOdooReads(A, () => blocked.promise),
      limitOdooReads(A, () => blocked.promise),
    ]
    await Promise.resolve()
    expect(limiterSnapshot(A).waiting).toBe(1)

    // B is free and answers immediately even though A is queueing.
    await expect(limitOdooReads(B, async () => 'b-answered')).resolves.toBe('b-answered')

    blocked.resolve()
    await Promise.all(saturating)
  })

  it('treats trailing slashes and case as the same instance', () => {
    expect(normaliseInstanceKey('https://a.odoo.com/')).toBe(A)
    expect(normaliseInstanceKey('https://A.Odoo.com')).toBe(A)
    expect(normaliseInstanceKey('  https://a.odoo.com//  ')).toBe(A)
  })

  it('keys an unconfigured instance separately rather than lumping it in', () => {
    expect(normaliseInstanceKey(null)).toBe('odoo:unconfigured')
    expect(normaliseInstanceKey('')).not.toBe(A)
  })
})

/* ── the cases where a slot could leak ─────────────────────────────────────*/

describe('a slot is released whatever happens to the read', () => {
  it('releases when the read throws', async () => {
    await expect(
      limitOdooReads(A, async () => {
        throw new Error('the source refused the read')
      }),
    ).rejects.toThrow('refused')

    expect(limiterSnapshot(A).active).toBe(0)
    // And the next read runs immediately rather than inheriting a lost slot.
    await expect(limitOdooReads(A, async () => 'ok')).resolves.toBe('ok')
  })

  it('does not strand the queue when an active read fails', async () => {
    const failing = deferred()
    const started: string[] = []

    const p1 = limitOdooReads(A, async () => {
      started.push('one')
      await failing.promise
    }).catch(() => 'failed')
    const p2 = limitOdooReads(A, async () => {
      started.push('two')
      return 'two'
    })
    const p3 = limitOdooReads(A, async () => {
      started.push('three')
      return 'three'
    })

    await Promise.resolve()
    failing.reject(new Error('boom'))

    await expect(p1).resolves.toBe('failed')
    await expect(p2).resolves.toBe('two')
    await expect(p3).resolves.toBe('three')
    expect(started).toContain('three')
  })

  it('forgets an instance once nothing is using it', async () => {
    await limitOdooReads(A, async () => 'ok')
    expect(trackedInstanceCount()).toBe(0)

    await Promise.all([limitOdooReads(A, async () => 1), limitOdooReads(B, async () => 2)])
    expect(trackedInstanceCount()).toBe(0)
  })
})

/* ── nobody waits forever ──────────────────────────────────────────────────*/

describe('a queued read gives up rather than hanging the page', () => {
  it('times out with wording the classifier renders as unavailable', async () => {
    vi.useFakeTimers()
    const blocked = deferred()

    const holding = [
      limitOdooReads(A, () => blocked.promise),
      limitOdooReads(A, () => blocked.promise),
    ]
    const queued = limitOdooReads(A, async () => 'never runs', { queueWaitMs: 5_000 })
    const assertion = expect(queued).rejects.toThrow(/timed out/)

    await vi.advanceTimersByTimeAsync(5_001)
    await assertion

    blocked.resolve()
    await Promise.all(holding)
  })

  it('leaves no waiter behind after giving up', async () => {
    vi.useFakeTimers()
    const blocked = deferred()
    const holding = [
      limitOdooReads(A, () => blocked.promise),
      limitOdooReads(A, () => blocked.promise),
    ]
    const queued = limitOdooReads(A, async () => 'x', { queueWaitMs: 1_000 }).catch(() => 'gave-up')

    await vi.advanceTimersByTimeAsync(1_001)
    expect(await queued).toBe('gave-up')
    expect(limiterSnapshot(A).waiting).toBe(0)

    blocked.resolve()
    await Promise.all(holding)
  })
})

/* ── what the limiter must not touch ───────────────────────────────────────*/

describe('writes do not pass through the read limiter', () => {
  const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8')

  it('the governed write path does not import it', () => {
    const writePath = read('lib/governed/executors/odoo-record-system.ts')

    expect(writePath).not.toContain('odoo-read-limiter')
    expect(writePath).not.toContain('limitOdooReads')
    // It still builds its own caller straight onto the transport.
    expect(writePath).toContain('json2Call')
  })

  it('introduces no retry anywhere in the limiter', () => {
    const limiter = read('lib/context/odoo-read-limiter.ts')

    expect(limiter).not.toMatch(/\bretry\b\s*\(/i)
    expect(limiter).not.toContain('Retry-After')
    // The only place a call is made is once, inside the try.
    expect(limiter.match(/await fn\(\)/g) ?? []).toHaveLength(1)
  })

  it('holds no credential or customer data in its state', () => {
    const limiter = read('lib/context/odoo-read-limiter.ts')
    const snapshot = limiterSnapshot(A)

    expect(Object.keys(snapshot).sort()).toEqual(['active', 'key', 'limit', 'waiting'])
    expect(limiter).not.toMatch(/apiKey|password|Authorization|cookie/i)
  })
})
