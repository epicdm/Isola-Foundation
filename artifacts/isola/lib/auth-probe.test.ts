import { describe, expect, it, vi } from 'vitest'

import {
  AUTH_UNAVAILABLE_REASONS,
  isDecisive,
  probeAuthUser,
  type AuthProbe,
} from './auth-probe'
import {
  AUTH_GATE_COPY,
  DEFAULT_LANDING,
  decideAuthGate,
  loginDestination,
  safePath,
} from './auth-gate'

const USER = {
  id: 'replit-user-1',
  email: 'owner@example.test',
  firstName: 'Owner',
  lastName: null,
  profileImageUrl: null,
}

function respond(status: number, body: unknown, opts: { unparseable?: boolean } = {}) {
  return vi.fn(async () =>
    ({
      ok: status >= 200 && status < 300,
      status,
      json: opts.unparseable
        ? async () => {
            throw new SyntaxError('Unexpected token < in JSON at position 0')
          }
        : async () => body,
    }) as unknown as Response,
  )
}

function rejectWith(err: unknown) {
  return vi.fn(async () => {
    throw err
  }) as unknown as typeof fetch
}

const probe = (fetchImpl: unknown): Promise<AuthProbe> =>
  probeAuthUser({}, { fetch: fetchImpl as typeof fetch, timeoutMs: 50 })

describe('auth probe — three answers, not two', () => {
  it('1. a 200 carrying a user is authenticated', async () => {
    const result = await probe(respond(200, { user: USER }))
    expect(result).toEqual({ status: 'authenticated', user: USER })
    expect(isDecisive(result)).toBe(true)
  })

  it('2. a 200 carrying an explicit null user is anonymous', async () => {
    const result = await probe(respond(200, { user: null }))
    expect(result).toEqual({ status: 'anonymous' })
    expect(isDecisive(result)).toBe(true)
  })

  it('2b. a 401 or 403 is anonymous — the service ruling, with authority', async () => {
    expect(await probe(respond(401, {}))).toEqual({ status: 'anonymous' })
    expect(await probe(respond(403, {}))).toEqual({ status: 'anonymous' })
  })

  it('3. a refused connection is unavailable, never anonymous', async () => {
    const result = await probe(rejectWith(Object.assign(new TypeError('fetch failed'), {
      cause: { code: 'ECONNREFUSED' },
    })))
    expect(result.status).toBe('unavailable')
    expect(result).toMatchObject({ reason: 'unreachable' })
    expect(result.status).not.toBe('anonymous')
    expect(isDecisive(result)).toBe(false)
  })

  it('4. a timeout is unavailable, and is told apart from a refusal', async () => {
    const abort = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })
    const result = await probe(rejectWith(abort))
    expect(result).toMatchObject({ status: 'unavailable', reason: 'timeout' })

    const refused = await probe(rejectWith(new TypeError('fetch failed')))
    expect(refused).toMatchObject({ reason: 'unreachable' })
    // Different reasons, so a reader can be told something different.
    expect((result as { reason: string }).reason).not.toBe(
      (refused as { reason: string }).reason,
    )
  })

  it('5. a dependency 500 is unavailable — an error is not a verdict about the reader', async () => {
    const result = await probe(respond(500, {}))
    expect(result).toMatchObject({ status: 'unavailable', reason: 'dependency_error' })
  })

  it('5b. a 404 is unavailable — the endpoint moved, we learned nothing about the reader', async () => {
    const result = await probe(respond(404, {}))
    expect(result).toMatchObject({ status: 'unavailable', reason: 'dependency_error' })
  })

  it('6. a 200 we cannot read is unavailable, NOT anonymous', async () => {
    const unparseable = await probe(respond(200, null, { unparseable: true }))
    expect(unparseable).toMatchObject({ status: 'unavailable', reason: 'malformed_answer' })

    // Structurally present, semantically unreadable.
    const noId = await probe(respond(200, { user: {} }))
    expect(noId).toMatchObject({ status: 'unavailable', reason: 'malformed_answer' })

    const noUserKey = await probe(respond(200, { something: 'else' }))
    expect(noUserKey).toMatchObject({ status: 'unavailable', reason: 'malformed_answer' })

    for (const r of [unparseable, noId, noUserKey]) {
      expect(r.status).not.toBe('anonymous')
    }
  })

  it('never reports a reason that leaks a host, port or driver message', async () => {
    const result = await probe(rejectWith(new Error('connect ECONNREFUSED 127.0.0.1:8080')))
    expect(result).toMatchObject({ status: 'unavailable' })
    const detail = (result as { detail: string }).detail
    expect(detail).not.toMatch(/127\.0\.0\.1|8080|ECONNREFUSED/)
    expect(detail).toBe('the sign-in service could not be reached')
  })

  it('passes the caller’s cookies through to the service', async () => {
    const spy = respond(200, { user: USER })
    await probeAuthUser({ Cookie: 'sid=abc' }, { fetch: spy as unknown as typeof fetch })
    const [, init] = spy.mock.calls[0] as unknown as [string, RequestInit]
    expect((init.headers as Record<string, string>).Cookie).toBe('sid=abc')
    expect(init.cache).toBe('no-store')
  })
})

describe('auth gate — what a guarded page does about it', () => {
  it('7. anonymous redirects to sign-in, carrying where they were going', () => {
    const gate = decideAuthGate({ status: 'anonymous' }, '/activity')
    expect(gate.kind).toBe('sign_in')
    expect(gate).toMatchObject({ to: '/auth/login?returnTo=%2Factivity' })
  })

  it('8. unavailable renders a state — it does not resolve to a destination', () => {
    const gate = decideAuthGate(
      { status: 'unavailable', reason: 'unreachable', detail: 'x' },
      '/activity',
    )
    expect(gate.kind).toBe('unavailable')
    expect(gate).not.toHaveProperty('to')
  })

  it('9. the unavailable state offers a retry pointing back at what was asked for', () => {
    const gate = decideAuthGate(
      { status: 'unavailable', reason: 'timeout', detail: 'x' },
      '/customer/42',
    )
    expect(gate).toMatchObject({ kind: 'unavailable', retryTo: '/customer/42' })
    expect(AUTH_GATE_COPY.retryLabel).toBe('Try again')
  })

  it('10. NO unavailable reason can send a reader to login or consent', () => {
    for (const reason of AUTH_UNAVAILABLE_REASONS) {
      const gate = decideAuthGate({ status: 'unavailable', reason, detail: 'x' }, '/activity')
      const serialised = JSON.stringify(gate)
      expect(serialised).not.toMatch(/auth\/login|returnTo|consent|oidc/i)
      expect(gate.kind).not.toBe('sign_in')
    }
  })

  it('authenticated allows, and carries the user through unchanged', () => {
    expect(decideAuthGate({ status: 'authenticated', user: USER }, '/activity')).toEqual({
      kind: 'allow',
      user: USER,
    })
  })

  it('the two sentences are different, and neither can be mistaken for the other', () => {
    expect(AUTH_GATE_COPY.signedOut).toBe('You are not signed in.')
    expect(AUTH_GATE_COPY.serviceUnavailable).toBe('The sign-in service cannot be reached.')
    expect(AUTH_GATE_COPY.signedOut).not.toBe(AUTH_GATE_COPY.serviceUnavailable)
    // The unavailable copy must actively deny the thing the reader will assume.
    expect(AUTH_GATE_COPY.serviceUnavailableBody).toContain('have not been signed out')
  })

  it('a hostile requested path never survives into a destination', () => {
    expect(safePath('//evil.example')).toBe(DEFAULT_LANDING)
    expect(safePath('/\\evil.example')).toBe(DEFAULT_LANDING)
    expect(safePath('https://evil.example')).toBe(DEFAULT_LANDING)
    expect(safePath('/ok\nLocation: /evil')).toBe(DEFAULT_LANDING)
    expect(safePath(undefined)).toBe(DEFAULT_LANDING)
    expect(safePath('/activity')).toBe('/activity')

    expect(loginDestination('//evil.example')).toBe('/auth/login?returnTo=%2Fdashboard')
    expect(
      decideAuthGate({ status: 'unavailable', reason: 'unreachable', detail: 'x' }, '//evil.example'),
    ).toMatchObject({ retryTo: DEFAULT_LANDING })
  })
})
