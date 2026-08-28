import { describe, expect, it } from 'vitest'

import { ACTION_LIFECYCLE_STATES } from '@/lib/customer-workspace/contract'

import {
  IN_FLIGHT_BADGE,
  POSTED_BADGE,
  REPLAY_PROVEN_BADGE,
  REPLAY_UNPROVEN_BADGE,
  UNKNOWN_BADGE,
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

  it('treats an unrecognised lifecycle as UNCONFIRMED, never as not-sent', () => {
    // "Not sent" is a claim about the world. For a state we do not recognise we
    // cannot make it, and making it wrongly is what causes a duplicate send.
    expect(sendBadgeText(outcome({ lifecycle: 'some_state_added_later', label: 'Whatever' }))).toBe(
      UNKNOWN_BADGE,
    )
  })

  it('says STILL SENDING while the write is in flight — not "Not sent"', () => {
    // `executing` means the write reached the system of record and the outcome
    // is not known yet. It is reachable in ordinary use: the ledger claim is
    // held for up to ~20s and Chatwoot re-mounts the panel on a conversation
    // switch, resetting the per-instance in-flight guard. It previously fell
    // through to "Not sent — Running", which invites the operator to post the
    // document by hand while the first one is still landing.
    const text = sendBadgeText(outcome({ lifecycle: 'executing', label: 'Running' }))
    expect(text).toBe(IN_FLIGHT_BADGE)
    expect(text).not.toContain('Not sent')
  })

  /**
   * The completeness test. The earlier version swept SIX hand-picked lifecycles
   * and omitted `executing` — the one that was broken. Iterating the contract
   * itself is the difference between a sweep that can miss a state and one that
   * cannot: a lifecycle added to ACTION_LIFECYCLE_STATES later is covered the
   * day it is added.
   */
  it('no lifecycle claims "Not sent" unless it PROVES nothing was written', () => {
    const mayClaimNotSent = new Set([
      'draft',
      'validation_failed',
      'permission_denied',
      'approval_required',
      'approval_pending',
      'approval_rejected',
      'dependency_unavailable',
      'execution_failed',
      'executor_unavailable',
      'argument_conflict',
    ])

    for (const lifecycle of ACTION_LIFECYCLE_STATES) {
      for (const proven of [true, false]) {
        const text = sendBadgeText(
          outcome({ lifecycle, label: 'Label', readbackProven: proven, success: false }),
        )
        if (!mayClaimNotSent.has(lifecycle)) {
          expect(
            text.includes('Not sent'),
            `${lifecycle} must not claim "Not sent" — it does not prove nothing was written`,
          ).toBe(false)
        }
      }
    }
  })

  it('CONTROL: the states that DO prove nothing was written still say so', () => {
    // Without this the sweep above would pass against a function that had been
    // broken to never say "Not sent" at all.
    expect(sendBadgeText(outcome({ lifecycle: 'execution_failed', label: 'Refused' }))).toBe(
      'Not sent — Refused',
    )
    expect(
      sendBadgeText(outcome({ lifecycle: 'permission_denied', label: 'Not permitted' })),
    ).toBe('Not sent — Not permitted')
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
