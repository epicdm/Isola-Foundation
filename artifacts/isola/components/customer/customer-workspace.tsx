'use client'

/**
 * The controller. It fetches, it holds form state, and it does nothing else.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 * -------------------------------
 * It never derives a lifecycle state. Every state the screen shows arrived from
 * the server, already resolved against the presentation contract. A controller
 * that set its own "success" the moment a fetch resolved would report an HTTP
 * 200 as a completed write, which is precisely the failure
 * `lib/customer-workspace/contract.ts` exists to prevent — and no amount of
 * care in the view would recover it.
 *
 * THE IDEMPOTENCY KEY
 * ------------------
 * Minted fresh whenever the form's contents change, and NOT otherwise. So:
 *   pressing Send twice           → same key → the ledger replays, no second write
 *   editing a field and resending → new key  → a genuinely new attempt
 * Generating a key per click would make double-click write twice; never
 * regenerating it would refuse a corrected resend as an argument conflict.
 */

import { useCallback, useEffect, useState } from 'react'

import type { CustomerContextResponse } from '@/lib/context/customer-context'

import { CustomerWorkspaceView, type ActionOutcomeView } from './workspace-view'

type Status = 'loading' | 'ready' | 'not_found' | 'forbidden' | 'error'

function newKey(): string {
  const c = globalThis.crypto
  if (c && typeof c.randomUUID === 'function') return c.randomUUID()
  return `k-${Math.random().toString(36).slice(2)}-${Date.now()}`
}

export function CustomerWorkspace({ customerId }: { customerId: string }) {
  const [status, setStatus] = useState<Status>('loading')
  const [context, setContext] = useState<CustomerContextResponse | null>(null)
  const [errorDetail, setErrorDetail] = useState<string | null>(null)

  const [selectedAction, setSelectedAction] = useState<string | null>(null)
  const [actionValues, setActionValues] = useState<Record<string, string>>({})
  const [attemptKey, setAttemptKey] = useState<string>(newKey)
  const [actionOutcome, setActionOutcome] = useState<ActionOutcomeView | null>(null)
  const [actionPending, setActionPending] = useState(false)

  const load = useCallback(async () => {
    setStatus('loading')
    setErrorDetail(null)
    try {
      const res = await fetch(`/api/v1/customers/${encodeURIComponent(customerId)}/context`, {
        cache: 'no-store',
      })
      if (res.status === 404) return setStatus('not_found')
      if (res.status === 403) return setStatus('forbidden')
      if (res.status === 401) {
        // NOT a redirect from here. The layout owns the sign-in decision, and a
        // client-side bounce would turn a momentary dependency outage into a
        // forced consent screen — the defect the auth gate was just written for.
        setErrorDetail('Your session could not be confirmed. Reload the page to sign in again.')
        return setStatus('error')
      }
      if (!res.ok) {
        setErrorDetail('The workspace could not be read. Nothing about this customer has changed.')
        return setStatus('error')
      }
      setContext((await res.json()) as CustomerContextResponse)
      setStatus('ready')
    } catch {
      setErrorDetail('The workspace could not be reached. Nothing about this customer has changed.')
      setStatus('error')
    }
  }, [customerId])

  useEffect(() => {
    void load()
  }, [load])

  const onSelectAction = useCallback((actionType: string | null) => {
    setSelectedAction((current) => (current === actionType ? null : actionType))
    setActionValues({})
    setActionOutcome(null)
    setAttemptKey(newKey())
  }, [])

  const onChangeField = useCallback((name: string, value: string) => {
    setActionValues((current) => ({ ...current, [name]: value }))
    // The contents changed, so the next send is a different question.
    setAttemptKey(newKey())
    setActionOutcome(null)
  }, [])

  const onRun = useCallback(async () => {
    if (!selectedAction || actionPending) return
    setActionPending(true)
    try {
      const res = await fetch(`/api/v1/customers/${encodeURIComponent(customerId)}/actions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          actionType: selectedAction,
          payload: actionValues,
          idempotencyKey: attemptKey,
        }),
      })

      if (!res.ok) {
        // The REQUEST was refused. That is not an action outcome, and it must
        // not be dressed up as one.
        setActionOutcome(null)
        setErrorDetail(
          res.status === 404
            ? 'This customer is no longer available to you.'
            : 'That request was refused before it reached the system of record.',
        )
        return
      }

      setActionOutcome((await res.json()) as ActionOutcomeView)
      // The action history and several sections may have moved.
      void load()
    } catch {
      // We never got an answer. We do NOT know whether anything was written, so
      // we say exactly that rather than choosing a happier interpretation.
      setActionOutcome({
        actionType: selectedAction,
        lifecycle: 'readback_failed',
        success: false,
        label: 'Written but not confirmed',
        detail:
          'The connection was lost before an answer arrived. Something may have been written and we cannot prove what. Check the system of record before acting on it.',
        marker: '!',
        tone: 'unproven',
        terminal: true,
        retryWrite: 'unsafe',
        retryReadback: 'safe',
        escalate: true,
        showsPriorResult: false,
        operationId: null,
        auditRef: null,
        readbackProven: false,
        approvalRef: null,
      })
    } finally {
      setActionPending(false)
    }
  }, [selectedAction, actionPending, customerId, actionValues, attemptKey, load])

  return (
    <CustomerWorkspaceView
      customerId={customerId}
      status={status}
      context={context}
      errorDetail={errorDetail}
      selectedAction={selectedAction}
      actionValues={actionValues}
      actionOutcome={actionOutcome}
      actionPending={actionPending}
      onSelectAction={onSelectAction}
      onChangeField={onChangeField}
      onRun={onRun}
      onRetryContext={() => void load()}
    />
  )
}
