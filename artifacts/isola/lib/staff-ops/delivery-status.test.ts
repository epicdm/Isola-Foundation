import { describe, it, expect } from 'vitest'
import {
  decideDeliveryStatus,
  extractDeliveryStatusEvents,
  type DispatchRowSnapshot,
} from './delivery-status'

function row(over: Partial<DispatchRowSnapshot> = {}): DispatchRowSnapshot {
  return {
    id: 'nb-1',
    tenantId: 'tenant-epic',
    providerStatus: 'accepted',
    staffActionRecorded: false,
    correlationId: 'sw-epic-task-2292-aaaa',
    ...over,
  }
}

describe('decideDeliveryStatus — sent is progress, never an outcome', () => {
  it('accepts sent as progress from accepted', () => {
    const d = decideDeliveryStatus({ providerMessageId: 'wamid.A', status: 'sent' }, row())
    expect(d.kind).toBe('apply')
    if (d.kind !== 'apply') return
    expect(d.nextStatus).toBe('sent')
    expect(d.setDeliveredAt).toBe(false)
    expect(d.setFailedAt).toBe(false)
  })

  it('records delivered with a delivered timestamp', () => {
    const d = decideDeliveryStatus({ providerMessageId: 'wamid.A', status: 'delivered' }, row({ providerStatus: 'sent' }))
    expect(d.kind).toBe('apply')
    if (d.kind === 'apply') {
      expect(d.nextStatus).toBe('delivered')
      expect(d.setDeliveredAt).toBe(true)
    }
  })

  it('refuses to let a late sent walk delivered backwards', () => {
    const d = decideDeliveryStatus({ providerMessageId: 'wamid.A', status: 'sent' }, row({ providerStatus: 'delivered' }))
    expect(d).toEqual({ kind: 'ignore', rowId: 'nb-1', why: 'would_regress' })
  })

  it('refuses to let anything walk a failure back into looking like progress', () => {
    for (const status of ['sent', 'delivered', 'read']) {
      const d = decideDeliveryStatus({ providerMessageId: 'wamid.A', status }, row({ providerStatus: 'failed' }))
      expect(d.kind, `status=${status}`).toBe('ignore')
    }
  })
})

describe('decideDeliveryStatus — the 131047 that hid for three weeks', () => {
  it('applies a failed callback with the real Meta error code', () => {
    const d = decideDeliveryStatus(
      {
        providerMessageId: 'wamid.A',
        status: 'failed',
        errorCode: '131047',
        errorDetail: 'Re-engagement message',
      },
      row({ providerStatus: 'sent' }),
    )
    expect(d.kind).toBe('apply')
    if (d.kind !== 'apply') return
    expect(d.nextStatus).toBe('failed')
    expect(d.setFailedAt).toBe(true)
    expect(d.errorCode).toBe('131047')
    expect(d.errorDetail).toBe('Re-engagement message')
  })

  it('reports an unmatched terminal callback instead of silently dropping it', () => {
    // Silence on exactly this path is how the original 131047 stayed invisible.
    const d = decideDeliveryStatus({ providerMessageId: 'wamid.ORPHAN', status: 'failed' }, null)
    expect(d).toEqual({
      kind: 'unmatched',
      why: 'no_dispatch_for_wamid',
      providerMessageId: 'wamid.ORPHAN',
    })
  })

  it('a failed arriving AFTER the staff member acted is recorded but flagged as late', () => {
    // Suppressing it would be a lie in one direction; letting a reader conclude
    // "they never got it" would be a lie in the other. Record and flag.
    const d = decideDeliveryStatus(
      { providerMessageId: 'wamid.A', status: 'failed', errorCode: '131047' },
      row({ providerStatus: 'delivered', staffActionRecorded: true }),
    )
    expect(d.kind).toBe('apply')
    if (d.kind === 'apply') {
      expect(d.nextStatus).toBe('failed')
      expect(d.lateFailureAfterAction).toBe(true)
    }
  })

  it('a delivered-then-failed sequence still lands the failure', () => {
    const d = decideDeliveryStatus({ providerMessageId: 'wamid.A', status: 'failed' }, row({ providerStatus: 'delivered' }))
    expect(d.kind).toBe('apply')
  })

  it('a duplicate failed callback is ignored rather than re-stamping failedAt', () => {
    const d = decideDeliveryStatus({ providerMessageId: 'wamid.A', status: 'failed' }, row({ providerStatus: 'failed' }))
    expect(d).toEqual({ kind: 'ignore', rowId: 'nb-1', why: 'would_regress' })
  })

  it('an unrecognised status is ignored, not coerced into a known one', () => {
    const d = decideDeliveryStatus({ providerMessageId: 'wamid.A', status: 'warehoused' }, row())
    expect(d).toEqual({ kind: 'ignore', rowId: 'nb-1', why: 'not_a_known_status' })
  })
})

describe('extractDeliveryStatusEvents — parsing must not become policy', () => {
  it('pulls statuses, error code and recipient out of a real Meta shape', () => {
    const body = {
      entry: [
        {
          changes: [
            {
              field: 'messages',
              value: {
                statuses: [
                  {
                    id: 'wamid.HBgLMTc2NzI5NTgzODIVAgARGBJFOEYy',
                    status: 'failed',
                    timestamp: '1785200000',
                    recipient_id: '17672958382',
                    errors: [{ code: 131047, title: 'Re-engagement message', message: 'Message failed to send' }],
                  },
                ],
              },
            },
          ],
        },
      ],
    }
    const events = extractDeliveryStatusEvents(body)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      providerMessageId: 'wamid.HBgLMTc2NzI5NTgzODIVAgARGBJFOEYy',
      status: 'failed',
      errorCode: '131047',
      errorDetail: 'Message failed to send',
      recipientId: '17672958382',
      timestamp: 1785200000,
    })
  })

  it('passes an unknown status through to the decision layer rather than filtering it', () => {
    const events = extractDeliveryStatusEvents({
      entry: [{ changes: [{ field: 'messages', value: { statuses: [{ id: 'wamid.X', status: 'warehoused' }] } }] }],
    })
    expect(events).toEqual([
      {
        providerMessageId: 'wamid.X',
        status: 'warehoused',
        errorCode: null,
        errorDetail: null,
        recipientId: null,
        timestamp: null,
      },
    ])
  })

  it('ignores inbound message payloads and malformed bodies without throwing', () => {
    expect(extractDeliveryStatusEvents({ entry: [{ changes: [{ field: 'messages', value: { messages: [{ id: 'x' }] } }] }] })).toEqual([])
    expect(extractDeliveryStatusEvents({ entry: [{ changes: [{ field: 'account_update', value: {} }] }] })).toEqual([])
    expect(extractDeliveryStatusEvents({})).toEqual([])
    expect(extractDeliveryStatusEvents(null)).toEqual([])
    expect(extractDeliveryStatusEvents('nonsense')).toEqual([])
  })

  it('skips a status entry with no id — an unjoinable event is not an event', () => {
    const events = extractDeliveryStatusEvents({
      entry: [{ changes: [{ field: 'messages', value: { statuses: [{ status: 'delivered' }] } }] }],
    })
    expect(events).toEqual([])
  })
})
