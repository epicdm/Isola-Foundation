/**
 * delivery-status.ts — pure decision core for Meta wa-status callbacks.
 *
 * Joins on the provider message id (wamid) that the send call returned, and
 * decides what — if anything — a callback is allowed to change.
 *
 * ── The vocabulary problem this module is the fix for ───────────────────────
 *
 * `FINDINGS-wa-status-join-key-and-guard-blindspot-2026-07-27` records a family
 * of four words that each read stronger than they were: `dispatched` meant
 * handed to Meta; `configured` meant a value was written somewhere; `restarted`
 * meant a process bounced; `sent` meant the send call returned. A 131047
 * *Re-engagement message* failure sat unnoticed for three weeks because the
 * record said `dispatched` and everyone read that as "the staff member has it".
 *
 * So, explicitly, in this module:
 *   - `accepted` means Meta returned HTTP 200 and gave us a wamid. Nothing more.
 *   - `sent` is PROGRESS, never an outcome. It is the exact status that was
 *     previously mistaken for delivery.
 *   - only `delivered` and `failed` are outcomes.
 *   - a terminal callback that matches nothing is reported at error level and
 *     writes nothing. Silence on this path is precisely how the 131047 hid.
 *
 * There is no work-item state machine here to advance. WorkRef points at Odoo
 * (`dec-wave1-workref-odoo-only-2026-07-28`), so delivery status describes the
 * NOTIFICATION and never the work. That removes a whole class of bug by
 * construction: a late `failed` cannot rewrite what a staff member did, because
 * it has no handle on it.
 */

export const PROVIDER_STATUSES = ['accepted', 'sent', 'delivered', 'read', 'failed'] as const
export type ProviderStatus = (typeof PROVIDER_STATUSES)[number]

/**
 * Progress ordering. `failed` is deliberately absent — it is not further along
 * the same axis, it is a different outcome, and comparing it numerically is how
 * you end up letting a stale `sent` overwrite a `failed`.
 */
const PROGRESS_RANK: Record<Exclude<ProviderStatus, 'failed'>, number> = {
  accepted: 0,
  sent: 1,
  delivered: 2,
  read: 3,
}

export interface DeliveryStatusEvent {
  /** Meta wamid — the ONLY join key back to the send that caused this. */
  providerMessageId: string
  status: string
  /** Meta error code, e.g. "131047" (Re-engagement message). */
  errorCode?: string | null
  errorDetail?: string | null
  recipientId?: string | null
  /** Provider-reported epoch seconds, when present. */
  timestamp?: number | null
}

export interface DispatchRowSnapshot {
  id: string
  tenantId: string
  providerStatus: ProviderStatus | null
  /** True once a staff action has been recorded against this episode. */
  staffActionRecorded: boolean
  correlationId: string | null
}

export type DeliveryStatusDecision =
  | {
      kind: 'apply'
      rowId: string
      nextStatus: ProviderStatus
      setDeliveredAt: boolean
      setFailedAt: boolean
      errorCode: string | null
      errorDetail: string | null
      /**
       * A `failed` arriving after the staff member already acted. The failure is
       * still recorded — suppressing it would be the same lie in the other
       * direction — but it is flagged so no reader concludes the staff member
       * never received the message. They demonstrably did.
       */
      lateFailureAfterAction: boolean
    }
  | { kind: 'ignore'; rowId: string; why: 'not_a_known_status' | 'would_regress' }
  | { kind: 'unmatched'; why: 'no_dispatch_for_wamid'; providerMessageId: string }

function normalizeStatus(raw: string): ProviderStatus | null {
  const s = (raw ?? '').trim().toLowerCase()
  return (PROVIDER_STATUSES as readonly string[]).includes(s) ? (s as ProviderStatus) : null
}

/** True iff moving current → next would go backwards along the progress axis. */
function wouldRegress(current: ProviderStatus | null, next: ProviderStatus): boolean {
  if (next === 'failed') {
    // A failure is allowed to land on anything except an already-recorded
    // failure. `delivered` then `failed` is a real Meta sequence for a message
    // that was delivered to the device and later rejected, and it must land.
    return current === 'failed'
  }
  if (current === 'failed') {
    // Nothing walks a failure back into looking like progress.
    return true
  }
  if (current === null) return false
  return PROGRESS_RANK[next] <= PROGRESS_RANK[current]
}

/**
 * Decide what a single callback does. Pure — no I/O, no clock.
 *
 * `row` is null when no dispatch matched the wamid. That is NOT silently
 * dropped: it returns `unmatched`, which the caller must log at error level.
 */
export function decideDeliveryStatus(
  event: DeliveryStatusEvent,
  row: DispatchRowSnapshot | null,
): DeliveryStatusDecision {
  const next = normalizeStatus(event.status)

  if (!row) {
    return { kind: 'unmatched', why: 'no_dispatch_for_wamid', providerMessageId: event.providerMessageId }
  }
  if (!next) {
    return { kind: 'ignore', rowId: row.id, why: 'not_a_known_status' }
  }
  if (wouldRegress(row.providerStatus, next)) {
    return { kind: 'ignore', rowId: row.id, why: 'would_regress' }
  }

  return {
    kind: 'apply',
    rowId: row.id,
    nextStatus: next,
    setDeliveredAt: next === 'delivered',
    setFailedAt: next === 'failed',
    errorCode: next === 'failed' ? (event.errorCode ?? null) : null,
    errorDetail: next === 'failed' ? (event.errorDetail ?? null) : null,
    lateFailureAfterAction: next === 'failed' && row.staffActionRecorded,
  }
}

/**
 * Extract status events from a Meta webhook body.
 *
 * Deliberately tolerant of shape and intolerant of meaning: a malformed entry
 * is skipped, but a well-formed entry with an unrecognised status still reaches
 * `decideDeliveryStatus`, which is the one place that decides what statuses
 * mean. Parsing must not quietly become policy.
 */
export function extractDeliveryStatusEvents(body: unknown): DeliveryStatusEvent[] {
  const out: DeliveryStatusEvent[] = []
  const entries = (body as { entry?: unknown[] })?.entry
  if (!Array.isArray(entries)) return out

  for (const entry of entries) {
    const changes = (entry as { changes?: unknown[] })?.changes
    if (!Array.isArray(changes)) continue

    for (const change of changes) {
      const c = change as { field?: string; value?: { statuses?: unknown[] } }
      if (c?.field !== 'messages') continue
      const statuses = c?.value?.statuses
      if (!Array.isArray(statuses)) continue

      for (const s of statuses) {
        const st = s as {
          id?: unknown
          status?: unknown
          recipient_id?: unknown
          timestamp?: unknown
          errors?: { code?: unknown; title?: unknown; message?: unknown }[]
        }
        if (typeof st?.id !== 'string' || typeof st?.status !== 'string') continue

        const firstError = Array.isArray(st.errors) ? st.errors[0] : undefined
        out.push({
          providerMessageId: st.id,
          status: st.status,
          errorCode: firstError?.code != null ? String(firstError.code) : null,
          errorDetail:
            typeof firstError?.message === 'string'
              ? firstError.message
              : typeof firstError?.title === 'string'
                ? firstError.title
                : null,
          recipientId: typeof st.recipient_id === 'string' ? st.recipient_id : null,
          timestamp: typeof st.timestamp === 'string' ? Number(st.timestamp) : null,
        })
      }
    }
  }

  return out
}
