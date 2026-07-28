/**
 * status-ingest.ts — apply Meta wa-status callbacks to the notification that
 * caused them.
 *
 * The ports (`findByProviderMessageId`, `applyDecision`, `onUnmatched`) are
 * INJECTED so the wiring itself is testable with no database. That distinction
 * matters here more than usual: on the legacy platform the decision core was
 * correct the whole time and nothing happened, because it had no caller. A
 * tested core with untested wiring is a tested core that never runs.
 */

import {
  decideDeliveryStatus,
  extractDeliveryStatusEvents,
  type DeliveryStatusDecision,
  type DeliveryStatusEvent,
  type DispatchRowSnapshot,
} from './delivery-status'

export interface StatusIngestPorts {
  /** Join on the Meta wamid. Returns null when nothing matches. */
  findByProviderMessageId: (wamid: string) => Promise<DispatchRowSnapshot | null>
  /** Persist an `apply` decision. */
  applyDecision: (decision: Extract<DeliveryStatusDecision, { kind: 'apply' }>, event: DeliveryStatusEvent) => Promise<void>
  /**
   * A terminal callback that matched no dispatch. MUST be reported at error
   * level — silence on this path is exactly how a 131047 stayed invisible for
   * three weeks.
   */
  onUnmatched: (event: DeliveryStatusEvent) => Promise<void> | void
}

export interface StatusIngestResult {
  events: number
  applied: number
  ignored: number
  unmatched: number
  errors: string[]
}

/**
 * Ingest every status event in a Meta webhook body.
 *
 * A throwing port is caught PER EVENT so one bad row cannot abort ingestion of
 * the rest — a batched webhook routinely carries statuses for several
 * unrelated sends.
 */
export async function ingestDeliveryStatuses(
  body: unknown,
  ports: StatusIngestPorts,
): Promise<StatusIngestResult> {
  const result: StatusIngestResult = { events: 0, applied: 0, ignored: 0, unmatched: 0, errors: [] }
  const events = extractDeliveryStatusEvents(body)
  result.events = events.length

  for (const event of events) {
    try {
      const row = await ports.findByProviderMessageId(event.providerMessageId)
      const decision = decideDeliveryStatus(event, row)

      switch (decision.kind) {
        case 'apply':
          await ports.applyDecision(decision, event)
          result.applied++
          break
        case 'ignore':
          result.ignored++
          break
        case 'unmatched':
          await ports.onUnmatched(event)
          result.unmatched++
          break
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown error'
      result.errors.push(`${event.providerMessageId}: ${message}`)
      console.error(
        `[staff-ops][wa-status] ingestion failed for wamid=${event.providerMessageId} status=${event.status}: ${message}`,
      )
    }
  }

  return result
}
