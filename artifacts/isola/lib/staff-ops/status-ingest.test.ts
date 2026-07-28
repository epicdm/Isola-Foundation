import { describe, it, expect, vi } from 'vitest'
import { ingestDeliveryStatuses, type StatusIngestPorts } from './status-ingest'
import type { DispatchRowSnapshot } from './delivery-status'

function bodyWith(statuses: Record<string, unknown>[]) {
  return { entry: [{ changes: [{ field: 'messages', value: { statuses } }] }] }
}

const ROW: DispatchRowSnapshot = {
  id: 'nb-1',
  tenantId: 'tenant-epic',
  providerStatus: 'accepted',
  staffActionRecorded: false,
  correlationId: 'sw-epic-task-2292-aaaa',
}

function ports(over: Partial<StatusIngestPorts> = {}): StatusIngestPorts {
  return {
    findByProviderMessageId: vi.fn(async () => ROW),
    applyDecision: vi.fn(async () => {}),
    onUnmatched: vi.fn(async () => {}),
    ...over,
  }
}

describe('ingestDeliveryStatuses — the wiring, not just the core', () => {
  it('joins on the wamid and applies a delivered callback', async () => {
    const p = ports()
    const r = await ingestDeliveryStatuses(bodyWith([{ id: 'wamid.A', status: 'delivered' }]), p)
    expect(r).toMatchObject({ events: 1, applied: 1, ignored: 0, unmatched: 0 })
    // The join must be argument-sensitive: an arg-blind mock would still return
    // a row if the code joined on the wrong field, making this check theatre.
    expect(p.findByProviderMessageId).toHaveBeenCalledWith('wamid.A')
    expect(p.applyDecision).toHaveBeenCalledTimes(1)
  })

  it('reports an unmatched terminal callback through onUnmatched and writes nothing', async () => {
    const p = ports({ findByProviderMessageId: vi.fn(async () => null) })
    const r = await ingestDeliveryStatuses(
      bodyWith([{ id: 'wamid.ORPHAN', status: 'failed', errors: [{ code: 131047 }] }]),
      p,
    )
    expect(r).toMatchObject({ events: 1, applied: 0, unmatched: 1 })
    expect(p.applyDecision).not.toHaveBeenCalled()
    expect(p.onUnmatched).toHaveBeenCalledTimes(1)
  })

  it('ignores a regressive callback without writing', async () => {
    const p = ports({ findByProviderMessageId: vi.fn(async () => ({ ...ROW, providerStatus: 'delivered' as const })) })
    const r = await ingestDeliveryStatuses(bodyWith([{ id: 'wamid.A', status: 'sent' }]), p)
    expect(r).toMatchObject({ events: 1, applied: 0, ignored: 1 })
    expect(p.applyDecision).not.toHaveBeenCalled()
  })

  it('processes every status in a batched webhook', async () => {
    const p = ports()
    const r = await ingestDeliveryStatuses(
      bodyWith([
        { id: 'wamid.A', status: 'sent' },
        { id: 'wamid.B', status: 'sent' },
        { id: 'wamid.C', status: 'sent' },
      ]),
      p,
    )
    expect(r).toMatchObject({ events: 3, applied: 3 })
  })

  it('one throwing port does not abort ingestion of the rest', async () => {
    const p = ports({
      applyDecision: vi.fn(async (d) => {
        if (d.rowId === 'nb-1' && d.nextStatus === 'sent') throw new Error('db down')
      }),
    })
    const r = await ingestDeliveryStatuses(
      bodyWith([
        { id: 'wamid.A', status: 'sent' },
        { id: 'wamid.B', status: 'delivered' },
      ]),
      p,
    )
    expect(r.events).toBe(2)
    expect(r.applied).toBe(1)
    expect(r.errors).toHaveLength(1)
    expect(r.errors[0]).toContain('wamid.A')
  })

  it('does nothing at all for an inbound-message webhook', async () => {
    const p = ports()
    const r = await ingestDeliveryStatuses(
      { entry: [{ changes: [{ field: 'messages', value: { messages: [{ id: 'x', type: 'text' }] } }] }] },
      p,
    )
    expect(r).toMatchObject({ events: 0, applied: 0, ignored: 0, unmatched: 0 })
    expect(p.findByProviderMessageId).not.toHaveBeenCalled()
  })
})
