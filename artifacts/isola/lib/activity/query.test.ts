import { describe, expect, it } from 'vitest'

import { MAX_PAGE_SIZE, encodeCursor } from './feed'
import {
  SUPPORTED_PARAMS,
  decodeActivityCursor,
  encodeActivityCursor,
  filterFingerprint,
  parseActivityQuery,
  type ParseResult,
} from './query'

const SCOPE = { companyId: 'tenant-1', knownSources: ['audit_log', 'lane2'] }

const parse = (qs: string): ParseResult => parseActivityQuery(new URLSearchParams(qs), SCOPE)

const feedCursor = encodeCursor({ occurredAt: '2026-07-31T17:00:00Z', activityId: 'a1' })

describe('what the parser accepts', () => {
  it('defaults to the session company and the default page size', () => {
    const r = parse('')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.query.companyId).toBe('tenant-1')
    expect(r.query.pageSize).toBe(25)
    expect(r.query.cursor).toBeNull()
  })

  it('accepts every parameter it claims to support', () => {
    const qs = new URLSearchParams()
    for (const p of SUPPORTED_PARAMS) {
      if (p === 'cursor') continue
      if (p === 'pageSize') qs.set(p, '10')
      else if (p === 'occurredFrom') qs.set(p, '2026-07-01T00:00:00Z')
      else if (p === 'occurredTo') qs.set(p, '2026-07-31T00:00:00Z')
      else if (p === 'source') qs.set(p, 'audit_log')
      else if (p === 'eventFamily') qs.set(p, 'staff.note')
      else if (p === 'ownershipState') qs.set(p, 'human')
      else qs.set(p, 'value-1')
    }
    const r = parseActivityQuery(qs, SCOPE)
    expect(r.ok, r.ok ? '' : `${r.parameter}: ${r.detail}`).toBe(true)
  })

  it('collects repeated list filters', () => {
    const r = parse('source=audit_log&source=lane2&eventFamily=staff.note&status=open')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.query.sourceSystems).toEqual(['audit_log', 'lane2'])
    expect(r.query.statuses).toEqual(['open'])
  })
})

describe('what the parser refuses, rather than ignoring', () => {
  it.each([
    ['nonsense=1', 'unknown_parameter'],
    ['customer=a&customer=b', 'duplicate_parameter'],
    ['customer=', 'blank_value'],
    ['customer=has%20a%20space', 'malformed_identifier'],
    ['occurredFrom=last%20tuesday', 'invalid_date'],
    ['occurredFrom=2026-07-31T00:00:00Z&occurredTo=2026-07-01T00:00:00Z', 'reversed_date_range'],
    ['source=made_up', 'invalid_source'],
    ['eventFamily=message.send', 'invalid_event_family'],
    ['ownershipState=maybe', 'invalid_ownership_state'],
    ['pageSize=0', 'invalid_page_size'],
    ['pageSize=-1', 'invalid_page_size'],
    ['pageSize=abc', 'invalid_page_size'],
    ['pageSize=1.5', 'invalid_page_size'],
    [`pageSize=${MAX_PAGE_SIZE + 1}`, 'invalid_page_size'],
    ['cursor=not-a-cursor', 'malformed_cursor'],
  ])('%s is rejected as %s', (qs, rejection) => {
    const r = parse(qs)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.rejection).toBe(rejection)
    expect(r.detail.length).toBeGreaterThan(0)
  })

  it('tells the caller they cannot have 5000 rows instead of quietly giving 100', () => {
    const r = parse('pageSize=5000')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.detail).toContain(String(MAX_PAGE_SIZE))
  })

  it('names the offending parameter', () => {
    const r = parse('whoops=1')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.parameter).toBe('whoops')
  })
})

describe('the cursor is bound to the question that produced it', () => {
  it('round-trips within the same filter set', () => {
    const first = parse('customer=cust-1')
    expect(first.ok).toBe(true)
    if (!first.ok) return

    const wrapped = encodeActivityCursor(feedCursor, first.fingerprint)
    const again = parse(`customer=cust-1&cursor=${encodeURIComponent(wrapped)}`)
    expect(again.ok).toBe(true)
    if (!again.ok) return
    expect(again.query.cursor).toBe(feedCursor)
  })

  it('refuses a cursor issued for a different company', () => {
    const a = parse('company=tenant-1')
    if (!a.ok) throw new Error('expected a parse')
    const wrapped = encodeActivityCursor(feedCursor, a.fingerprint)

    const b = parseActivityQuery(
      new URLSearchParams(`company=tenant-2&cursor=${wrapped}`),
      SCOPE,
    )
    expect(b.ok).toBe(false)
    if (b.ok) return
    expect(b.rejection).toBe('malformed_cursor')
    expect(b.detail).toContain('different set of filters')
  })

  it('refuses a cursor issued for a different filter on the same company', () => {
    const a = parse('customer=cust-1')
    if (!a.ok) throw new Error('expected a parse')
    const wrapped = encodeActivityCursor(feedCursor, a.fingerprint)
    const b = parse(`customer=cust-2&cursor=${wrapped}`)
    expect(b.ok).toBe(false)
    if (b.ok) return
    expect(b.detail).toContain('different set of filters')
  })

  it('accepts a cursor when only the page size changed', () => {
    const a = parse('customer=cust-1&pageSize=10')
    if (!a.ok) throw new Error('expected a parse')
    const wrapped = encodeActivityCursor(feedCursor, a.fingerprint)
    const b = parse(`customer=cust-1&pageSize=50&cursor=${wrapped}`)
    expect(b.ok).toBe(true)
  })

  it('refuses a cursor from an older API version', () => {
    const stale = Buffer.from(
      JSON.stringify({ v: 'activity.cursor@0', f: 'x', c: feedCursor }),
      'utf8',
    ).toString('base64url')
    expect(decodeActivityCursor(stale, 'x')).toEqual({
      ok: false,
      reason: 'unsupported_version',
    })
  })

  it('refuses a tampered inner cursor', () => {
    const bad = Buffer.from(
      JSON.stringify({ v: 'activity.cursor@1', f: 'x', c: 'garbage' }),
      'utf8',
    ).toString('base64url')
    expect(decodeActivityCursor(bad, 'x')).toEqual({ ok: false, reason: 'malformed' })
  })

  it('carries nothing but the ordering pair', () => {
    const wrapped = encodeActivityCursor(feedCursor, 'fp')
    const decoded = JSON.parse(Buffer.from(wrapped, 'base64url').toString('utf8'))
    expect(Object.keys(decoded).sort()).toEqual(['c', 'f', 'v'])
    const inner = JSON.parse(Buffer.from(decoded.c, 'base64url').toString('utf8'))
    expect(Object.keys(inner).sort()).toEqual(['activityId', 'occurredAt'])
  })
})

describe('the fingerprint', () => {
  it('ignores key order and page size', () => {
    const a = parse('customer=cust-1&service=svc-1&pageSize=10')
    const b = parse('service=svc-1&customer=cust-1&pageSize=99')
    expect(a.ok && b.ok && a.fingerprint === b.fingerprint).toBe(true)
  })

  it('changes when a filter changes', () => {
    const a = parse('customer=cust-1')
    const b = parse('customer=cust-2')
    expect(a.ok && b.ok && a.fingerprint !== b.fingerprint).toBe(true)
  })

  it('is not reversible into the filter values', () => {
    const r = parse('customer=cust-secret-1')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.fingerprint).not.toContain('cust-secret-1')
    expect(filterFingerprint(r.query)).toBe(r.fingerprint)
  })
})

// The ownership filter narrows WHICH ROWS EXIST, so it belongs in the cursor's
// identity. Replaying a human-only cursor against an ai-only query would answer
// a question nobody asked, from a page boundary that means nothing there.
describe('the ownership filter is part of the question the cursor belongs to', () => {
  it('refuses a cursor issued before the ownership filter changed', () => {
    const a = parse('ownershipState=human')
    if (!a.ok) throw new Error('expected a parse')
    const wrapped = encodeActivityCursor(feedCursor, a.fingerprint)

    const b = parse(`ownershipState=ai&cursor=${wrapped}`)
    expect(b.ok).toBe(false)
    if (b.ok) return
    expect(b.rejection).toBe('malformed_cursor')
    expect(b.parameter).toBe('cursor')
    expect(b.detail).toContain('different set of filters')
  })

  it('refuses a cursor when the ownership filter is dropped entirely', () => {
    const a = parse('ownershipState=human')
    if (!a.ok) throw new Error('expected a parse')
    const wrapped = encodeActivityCursor(feedCursor, a.fingerprint)

    const b = parse(`cursor=${wrapped}`)
    expect(b.ok).toBe(false)
    if (b.ok) return
    expect(b.rejection).toBe('malformed_cursor')
    expect(b.detail).toContain('different set of filters')
  })

  it('refuses a cursor when the ownership filter is widened', () => {
    const a = parse('ownershipState=human')
    if (!a.ok) throw new Error('expected a parse')
    const wrapped = encodeActivityCursor(feedCursor, a.fingerprint)

    const b = parse(`ownershipState=human&ownershipState=ai&cursor=${wrapped}`)
    expect(b.ok).toBe(false)
    if (b.ok) return
    expect(b.detail).toContain('different set of filters')
  })

  it('keeps the cursor valid when ONLY the page size changed', () => {
    const a = parse('ownershipState=human&pageSize=10')
    if (!a.ok) throw new Error('expected a parse')
    const wrapped = encodeActivityCursor(feedCursor, a.fingerprint)

    const b = parse(`ownershipState=human&pageSize=50&cursor=${wrapped}`)
    expect(b.ok).toBe(true)
    if (!b.ok) return
    expect(b.query.cursor).toBe(feedCursor)
    expect(b.query.pageSize).toBe(50)
    expect(b.fingerprint).toBe(a.fingerprint)
  })

  it('ignores the order the ownership states were given in', () => {
    const a = parse('ownershipState=human&ownershipState=ai')
    const b = parse('ownershipState=ai&ownershipState=human')
    expect(a.ok && b.ok && a.fingerprint === b.fingerprint).toBe(true)
  })
})
