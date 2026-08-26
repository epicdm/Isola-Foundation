/**
 * `defect-pr82-workspace-action-and-copy-integrity-2026-08-06`, missing-owner subfinding.
 *
 * The rendered evidence was `"Active customer ·  looks after them"` — a dangling separator, a
 * doubled space and a sentence with no subject. Every degenerate shape an adapter can plausibly
 * produce is asserted here, because the bug was not that one of them was unhandled: it was that
 * none of them were.
 */

import { describe, expect, it } from 'vitest'

import { customerAttributionLine, hasOwnerName } from './customer-copy'

const ABSENT_OWNERS: ReadonlyArray<readonly [string, string | null | undefined]> = [
  ['null', null],
  ['undefined', undefined],
  ['empty string', ''],
  ['whitespace only', '   '],
  ['tab and newline', '\t\n'],
]

describe('an owner name that is really an absence', () => {
  it.each(ABSENT_OWNERS)('%s is not a usable owner name', (_label, value) => {
    expect(hasOwnerName(value)).toBe(false)
  })

  it.each(ABSENT_OWNERS)('%s produces truthful fallback copy', (_label, value) => {
    expect(customerAttributionLine('Active customer', value)).toBe(
      'Active customer · Nobody is assigned to them yet',
    )
  })

  it.each(ABSENT_OWNERS)('%s leaves no dangling separator or doubled space', (_label, value) => {
    const line = customerAttributionLine('Active customer', value)

    expect(line).not.toMatch(/ {2}/)
    expect(line).not.toMatch(/·\s*$/)
    expect(line).not.toContain('·  ')
    expect(line).not.toContain('looks after them')
  })

  it.each(ABSENT_OWNERS)('%s never invents a person', (_label, value) => {
    const line = customerAttributionLine('Active customer', value)
    // No stand-in that could be mistaken for a name or a team.
    for (const invented of ['Unassigned', 'the team', 'Unknown', 'N/A', 'Agent']) {
      expect(line).not.toContain(invented)
    }
  })
})

describe('an owner name that is real', () => {
  it('is used, and reads as a sentence', () => {
    expect(customerAttributionLine('Active customer', 'Eric Giraud')).toBe(
      'Active customer · Eric Giraud looks after them',
    )
  })

  it('is trimmed rather than rejected when padded', () => {
    expect(customerAttributionLine('Active customer', '  Eric Giraud  ')).toBe(
      'Active customer · Eric Giraud looks after them',
    )
  })

  it('is recognised as usable', () => {
    expect(hasOwnerName('Eric Giraud')).toBe(true)
  })
})

describe('a missing status label removes its own separator too', () => {
  it.each([null, undefined, '', '  '])('status %s leaves no leading separator', (status) => {
    expect(customerAttributionLine(status, 'Eric Giraud')).toBe('Eric Giraud looks after them')
  })

  it('both missing still yields a complete sentence', () => {
    expect(customerAttributionLine('', '')).toBe('Nobody is assigned to them yet')
  })
})
