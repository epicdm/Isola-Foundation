import { describe, expect, it } from 'vitest'

import {
  CHATWOOT_APP_CONTEXT_EVENT,
  CHATWOOT_FETCH_INFO_REQUEST,
  isExpectedChatwootOrigin,
  parseChatwootAppContext,
} from './chatwoot-context'

/**
 * The real payload shape, verified read-only against the SERVED bundle of the running
 * Chatwoot 4.16.1-CE image on 2026-08-06 — not from documentation.
 */
function realPayload(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    event: 'appContext',
    data: {
      conversation: {
        id: 131, // display_id, NOT the database primary key
        account_id: 5,
        inbox_id: 46,
        status: 'open',
        priority: 'high',
        labels: ['human-takeover'],
        custom_attributes: { correlation_id: 'epic-cz-revenue-loop1-2026-08-06-conv131' },
        meta: { sender: { id: 188, name: 'Eric Isola Test', phone_number: '+1767xxxxxxx' } },
        ...over,
      },
      contact: { id: 188, name: 'Eric Isola Test', email: 'someone@example.invalid' },
      currentAgent: { id: 1, name: 'Eric Giraud', email: 'eric@example.invalid' },
    },
  })
}

describe('the payload is parsed, never trusted', () => {
  it('extracts exactly the three identifiers and nothing else', () => {
    const result = parseChatwootAppContext(realPayload())
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.hint).toEqual({
      accountIdHint: 5,
      inboxIdHint: 46,
      conversationDisplayIdHint: 131,
    })

    // The single most important assertion in this file: nothing else crosses the boundary.
    // Name, phone, email, labels, custom attributes, sender and the whole currentAgent
    // object are discarded. Widening this is how the trust bug comes back.
    expect(Object.keys(result.hint).sort()).toEqual([
      'accountIdHint',
      'conversationDisplayIdHint',
      'inboxIdHint',
    ])
  })

  it('carries no tenant, role or permission — the type cannot even express them', () => {
    const result = parseChatwootAppContext(realPayload())
    if (!result.ok) throw new Error('expected ok')

    const serialized = JSON.stringify(result.hint)
    for (const forbidden of ['tenant', 'role', 'permission', 'email', 'phone', 'name']) {
      expect(serialized.toLowerCase()).not.toContain(forbidden)
    }
  })
})

describe('hostile and malformed input is rejected at the edge', () => {
  it('rejects a non-string payload', () => {
    // Chatwoot always sends a JSON string; accepting objects would widen the surface for
    // no benefit.
    expect(parseChatwootAppContext({ event: 'appContext' })).toMatchObject({
      ok: false,
      reason: 'not-a-string',
    })
  })

  it('rejects malformed JSON', () => {
    expect(parseChatwootAppContext('{not json')).toMatchObject({
      ok: false,
      reason: 'malformed-json',
    })
  })

  it('rejects a different event name', () => {
    expect(
      parseChatwootAppContext(JSON.stringify({ event: 'somethingElse', data: {} })),
    ).toMatchObject({ ok: false, reason: 'wrong-event' })
  })

  it('rejects a missing conversation', () => {
    expect(
      parseChatwootAppContext(JSON.stringify({ event: 'appContext', data: {} })),
    ).toMatchObject({ ok: false, reason: 'missing-conversation' })
  })

  it('rejects identifiers supplied as strings', () => {
    expect(parseChatwootAppContext(realPayload({ id: '131' }))).toMatchObject({
      ok: false,
      reason: 'identifier-not-a-positive-integer',
    })
  })

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN])(
    'rejects the invalid identifier %p',
    (bad) => {
      expect(parseChatwootAppContext(realPayload({ id: bad }))).toMatchObject({ ok: false })
    },
  )

  it('rejects a payload missing the inbox id', () => {
    const payload = JSON.stringify({
      event: 'appContext',
      data: { conversation: { id: 131, account_id: 5 } },
    })
    expect(parseChatwootAppContext(payload)).toMatchObject({
      ok: false,
      reason: 'missing-identifiers',
    })
  })

  it('does not throw on any input', () => {
    for (const input of [null, undefined, 0, [], '', '[]', '"str"', 'null']) {
      expect(() => parseChatwootAppContext(input)).not.toThrow()
    }
  })
})

describe('origin checking is hygiene, and is honest about being hygiene', () => {
  it('accepts the exact expected origin', () => {
    expect(isExpectedChatwootOrigin('https://inbox.epic.dm', 'https://inbox.epic.dm')).toBe(true)
    expect(
      isExpectedChatwootOrigin('https://inbox.epic.dm', 'https://inbox.epic.dm/app/accounts/5'),
    ).toBe(true)
  })

  it('rejects a lookalike host — this is why it compares origins, not string prefixes', () => {
    // `startsWith('https://inbox.epic.dm')` would happily accept this.
    expect(
      isExpectedChatwootOrigin('https://inbox.epic.dm.attacker.example', 'https://inbox.epic.dm'),
    ).toBe(false)
  })

  it('rejects a scheme downgrade', () => {
    expect(isExpectedChatwootOrigin('http://inbox.epic.dm', 'https://inbox.epic.dm')).toBe(false)
  })

  it('rejects a different port', () => {
    expect(isExpectedChatwootOrigin('https://inbox.epic.dm:8443', 'https://inbox.epic.dm')).toBe(
      false,
    )
  })

  it('rejects empty or unparseable values rather than defaulting to allow', () => {
    expect(isExpectedChatwootOrigin('', 'https://inbox.epic.dm')).toBe(false)
    expect(isExpectedChatwootOrigin('https://inbox.epic.dm', '')).toBe(false)
    expect(isExpectedChatwootOrigin('not a url', 'https://inbox.epic.dm')).toBe(false)
  })
})

describe('the handshake constants match the live substrate', () => {
  it('uses the exact strings Chatwoot 4.16.1 sends and listens for', () => {
    expect(CHATWOOT_APP_CONTEXT_EVENT).toBe('appContext')
    expect(CHATWOOT_FETCH_INFO_REQUEST).toBe('chatwoot-dashboard-app:fetch-info')
  })
})
