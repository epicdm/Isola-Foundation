import { describe, expect, it } from 'vitest'

import {
  POSTED_BADGE,
  REPLAY_PROVEN_BADGE,
  REPLAY_UNPROVEN_BADGE,
  UNPROVEN_BADGE,
  sendBadgeText,
  type SendOutcome,
} from './send-badge'

const outcome = (over: Partial<SendOutcome> = {}): SendOutcome => ({
  success: false,
  label: 'Already recorded',
  detail: 'detail',
  operationId: 'op_abc',
  lifecycle: 'idempotent_replay',
  readbackProven: true,
  ...over,
})

describe('sendBadgeText — what a document row says after an attempt', () => {
  it('leads with the POSTED state on a proven replay', () => {
    expect(sendBadgeText(outcome())).toBe('Already posted — not posted again')
  })

  it('never says "Not sent" for a proven replay — that was the ambiguity being fixed', () => {
    expect(sendBadgeText(outcome())).not.toContain('Not sent')
  })

  it('REFUSES to claim delivery when the earlier attempt was never proven', () => {
    // The contract states a replay "may itself have been readback_failed".
    // Saying "Already sent" there would invent a delivery out of a retry.
    const text = sendBadgeText(outcome({ readbackProven: false }))
    expect(text).toBe(REPLAY_UNPROVEN_BADGE)
    expect(text).not.toContain('Already sent')
  })

  it('the two replay wordings are genuinely different — the branch is not cosmetic', () => {
    expect(REPLAY_PROVEN_BADGE).not.toBe(REPLAY_UNPROVEN_BADGE)
    expect(sendBadgeText(outcome({ readbackProven: true }))).not.toBe(
      sendBadgeText(outcome({ readbackProven: false })),
    )
  })

  it('claims POSTED, never SENT — the readback proves storage, not delivery', () => {
    const text = sendBadgeText(
      outcome({ success: true, lifecycle: 'completed_verified', label: 'Done and confirmed' }),
    )
    expect(text).toBe(POSTED_BADGE)
    // The specific overclaim this replaces. Chatwoot storing the message is not
    // WhatsApp delivering it, and outside the 24-hour window it can be stored
    // and then rejected seconds later with nobody told.
    expect(text).not.toContain('Sent —')
    expect(text.toLowerCase()).toContain('posted')
  })

  it('no badge on any path claims a message was DELIVERED', () => {
    // A sweep rather than a single assertion: nothing this function can emit may
    // assert delivery, because nothing it is given can prove delivery.
    const lifecycles = [
      { success: true, lifecycle: 'completed_verified', label: 'Done and confirmed' },
      { lifecycle: 'idempotent_replay', readbackProven: true },
      { lifecycle: 'idempotent_replay', readbackProven: false },
      { lifecycle: 'readback_failed', label: 'Written but not confirmed' },
      { lifecycle: 'execution_failed', label: 'Refused' },
      { lifecycle: 'dependency_unavailable', label: 'Could not reach the system' },
    ]
    for (const l of lifecycles) {
      const text = sendBadgeText(outcome(l)).toLowerCase()
      expect(text).not.toContain('delivered')
      expect(text).not.toContain('received')
    }
  })

  it('still says Not sent for a genuine failure — the old wording is narrowed, not deleted', () => {
    expect(
      sendBadgeText(outcome({ lifecycle: 'execution_failed', label: 'Refused', readbackProven: false })),
    ).toBe('Not sent — Refused')
  })

  it('treats an unrecognised lifecycle as not-sent rather than guessing', () => {
    expect(sendBadgeText(outcome({ lifecycle: 'unknown', label: 'Not sent' }))).toBe(
      'Not sent — Not sent',
    )
  })

  it('leads an unproven write with the UNCERTAINTY, not with "Not sent"', () => {
    // readback_failed is the state a timed-out send now lands in, and it is the
    // one state where something probably WAS written. Leading with "Not sent"
    // put the least likely reading first and invited a duplicate send.
    // The old assertion used label 'Unconfirmed' — a string the lifecycle
    // contract never produces — so it passed without ever exercising the real
    // wording. The label is now the contract's own.
    const text = sendBadgeText(
      outcome({ lifecycle: 'readback_failed', label: 'Written but not confirmed', readbackProven: true }),
    )
    expect(text).toBe(UNPROVEN_BADGE)
    expect(text.startsWith('Not sent')).toBe(false)
    expect(text.toLowerCase()).toContain('check the conversation')
  })

  it('an unproven write still does not read as success, whatever readbackProven says', () => {
    for (const proven of [true, false]) {
      const text = sendBadgeText(
        outcome({ lifecycle: 'readback_failed', label: 'Written but not confirmed', readbackProven: proven }),
      )
      expect(text).toBe(UNPROVEN_BADGE)
      expect(text).not.toBe(POSTED_BADGE)
    }
  })
})
