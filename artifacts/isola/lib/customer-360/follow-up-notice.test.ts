/**
 * The copy an operator is shown when the follow-up did not happen.
 *
 * Every arm has its twin here on purpose: an arm that returns a distinct
 * sentence for `tenant_not_bound` proves nothing unless another arm is shown
 * returning a DIFFERENT sentence for a different fact. Otherwise the arm could
 * be a constant.
 */
import { describe, expect, it } from 'vitest'

import { TENANT_NOT_BOUND } from '@/lib/engine-bindings'

import {
  FOLLOW_UP_NOT_BOUND_NOTICE,
  FOLLOW_UP_REFUSED_FALLBACK,
  FOLLOW_UP_UNREACHABLE_NOTICE,
  followUpNoticeFor,
} from './follow-up-notice'

describe('a created follow-up is the only thing that says nothing', () => {
  it('returns null for a proven create', () => {
    expect(followUpNoticeFor({ ok: true, followUp: { id: 9001 } })).toBeNull()
  })

  it('does NOT treat ok:true with no row as a success', () => {
    // An absent readback is not a proof. It gets a notice like any other
    // non-answer.
    expect(followUpNoticeFor({ ok: true })).not.toBeNull()
  })

  it('does not treat an unrecognised body as a success', () => {
    expect(followUpNoticeFor(null)).not.toBeNull()
    expect(followUpNoticeFor({})).not.toBeNull()
    expect(followUpNoticeFor('nonsense')).not.toBeNull()
  })
})

describe('an unbound business is told the truth, not asked to retry', () => {
  it('renders its own distinct sentence', () => {
    const notice = followUpNoticeFor({ ok: false, reason: TENANT_NOT_BOUND, error: 'ignored' })
    expect(notice).toBe(FOLLOW_UP_NOT_BOUND_NOTICE)
  })

  it('CONTROL: a different refusal renders a DIFFERENT sentence', () => {
    // Without this, the arm above could be a constant returned for everything.
    const other = followUpNoticeFor({ ok: false, error: 'Odoo rejected the activity type.' })
    expect(other).not.toBe(FOLLOW_UP_NOT_BOUND_NOTICE)
    expect(other).toContain('Odoo rejected the activity type.')
  })

  it('CONTROL: a transport failure renders the network sentence, which is a third thing', () => {
    expect(FOLLOW_UP_UNREACHABLE_NOTICE).not.toBe(FOLLOW_UP_NOT_BOUND_NOTICE)
    expect(FOLLOW_UP_UNREACHABLE_NOTICE).not.toBe(FOLLOW_UP_REFUSED_FALLBACK)
  })

  it('never invites a retry that cannot work, and never blames a fault', () => {
    const notice = FOLLOW_UP_NOT_BOUND_NOTICE.toLowerCase()
    expect(notice).not.toContain('try again')
    expect(notice).not.toContain('went wrong')
    expect(notice).not.toContain('could not reach')
    expect(notice).not.toContain('unavailable')
    // It says the two things a person needs: what did not happen, and what has
    // to change.
    expect(notice).toContain('was not created')
    expect(notice).toContain('connect')
  })

  it('the unreachable notice does NOT claim nothing happened', () => {
    // The request may have arrived. Asserting "nothing was written" there would
    // be the same class of lie the whole workspace is built to avoid.
    expect(FOLLOW_UP_UNREACHABLE_NOTICE.toLowerCase()).toContain('not known')
    expect(FOLLOW_UP_UNREACHABLE_NOTICE.toLowerCase()).not.toContain('nothing was written')
  })
})

describe('a refusal with nothing useful in it still says something', () => {
  it('falls back rather than rendering an empty notice', () => {
    expect(followUpNoticeFor({ ok: false })).toBe(FOLLOW_UP_REFUSED_FALLBACK)
    expect(followUpNoticeFor({ ok: false, error: '   ' })).toBe(FOLLOW_UP_REFUSED_FALLBACK)
  })
})
