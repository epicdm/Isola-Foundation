import { describe, expect, it } from 'vitest'

import {
  REPLAY_PROVEN_BADGE,
  REPLAY_UNPROVEN_BADGE,
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
  it('leads with the DELIVERED state on a proven replay', () => {
    expect(sendBadgeText(outcome())).toBe('Already sent — not sent again')
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

  it('says Sent only for a verified success', () => {
    expect(
      sendBadgeText(
        outcome({ success: true, lifecycle: 'completed_verified', label: 'Done and confirmed' }),
      ),
    ).toBe('Sent — Done and confirmed')
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

  it('does not let readbackProven leak optimism into a non-replay failure', () => {
    // A failure that happens to carry readbackProven must still read as not sent.
    expect(
      sendBadgeText(outcome({ lifecycle: 'readback_failed', label: 'Unconfirmed', readbackProven: true })),
    ).toBe('Not sent — Unconfirmed')
  })
})
