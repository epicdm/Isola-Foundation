/**
 * customer-actions@1 — the runtime binding for governed actions on a customer.
 *
 * THREE THINGS ARE JOINED HERE, AND THE JOIN IS THE WHOLE FILE
 * -----------------------------------------------------------
 *   the shared operation ledger  (exactly-once, across BOTH caller lanes)
 *   runGovernedAction            (validate → authorize → approve → execute → readback)
 *   the presentation contract    (what a reader is actually told)
 *
 * ONE IDEMPOTENCY MECHANISM, NOT TWO
 * ----------------------------------
 * `runGovernedAction` has its own `findPriorResult` replay check, and the ledger
 * has `claimOperation`. Wiring both would produce two answers to "has this
 * already run", and they would disagree the first time one of them was updated.
 *
 * The ledger wins, because it is the one with the unique index — it is enforced
 * by the database rather than by a read. So the claim happens FIRST, and
 * `findPriorResult` is deliberately wired to return null: by the time the
 * governed runtime sees a proposal, the ledger has already ruled that this is a
 * fresh attempt. `IDEMPOTENT_REPLAY` therefore arrives from `already_completed`
 * through `fromClaimStatus`, and never from two places at once.
 *
 * WHAT A CALLER IS TOLD, AND WHAT IT IS NOT
 * ----------------------------------------
 * Internal detail — Odoo's message, the external id, the driver's complaint —
 * is written to the ledger row, where an operator can find it. What comes BACK
 * is the sentence the presentation contract holds for that lifecycle state, plus
 * (only for a validation failure) our own validator's wording, which we wrote
 * and which names a field rather than a system.
 *
 * An executor's exception text is never returned. It is the one string in this
 * path that we did not write.
 */

import { ACTIONS_BY_ROLE, ACTIONS_REQUIRING_APPROVAL, type Role } from '@/lib/context/resolve-context'
import {
  LIFECYCLE_PRESENTATION,
  fromActionOutcome,
  fromClaimStatus,
  type ActionLifecycleState,
  type LifecyclePresentation,
} from '@/lib/customer-workspace/contract'
import {
  claimOperation,
  completeOperation,
  failOperation,
  type LedgerStore,
  type OperationEnvelope,
  type OperationIdentity,
} from '@/lib/operations/ledger'

import { runGovernedAction, type ActionExecutor, type ActionPorts, type ActionProposal } from './action'
import { findGovernedAction } from './executors/catalogue'

export const CUSTOMER_ACTIONS_VERSION = 'customer-actions@1' as const

/** Foundation staff acting in the workbench. Not the conversation-bound agent. */
const CALLER_CLASS = 'foundation_staff' as const

/** Everything in this workspace acts on one kind of object. */
export const ACTION_OBJECT_TYPE = 'customer' as const

export interface CustomerActionRequest {
  /** From the SESSION. Never from the payload. */
  tenantId: string
  companyId: string
  customerId: string
  actionType: string
  payload: Record<string, unknown>
  actorPrincipalId: string
  actorRole: string
  /** The caller's own key. Unique only within the rest of the identity. */
  idempotencyKey: string
  correlationId: string
}

export interface CustomerActionOutcome {
  version: typeof CUSTOMER_ACTIONS_VERSION
  actionType: string
  correlationId: string
  /** The shared ledger's id for this operation. Null when nothing was claimed. */
  operationId: string | null
  /** The audit reference a human can follow. The ledger row, today. */
  auditRef: string | null
  lifecycle: ActionLifecycleState
  presentation: LifecyclePresentation
  /** Safe for a screen. Never an executor's exception text. */
  detail: string
  /** Whether an authoritative readback proved the write. */
  readbackProven: boolean
  approvalRef: string | null
}

export interface CustomerActionPorts {
  ledger: LedgerStore
  executors: readonly ActionExecutor[]
  now(): Date
}

function outcome(
  req: CustomerActionRequest,
  lifecycle: ActionLifecycleState,
  over: Partial<CustomerActionOutcome> = {},
): CustomerActionOutcome {
  const presentation = LIFECYCLE_PRESENTATION[lifecycle]
  return {
    version: CUSTOMER_ACTIONS_VERSION,
    actionType: req.actionType,
    correlationId: req.correlationId,
    operationId: null,
    auditRef: null,
    lifecycle,
    presentation,
    detail: presentation.sentence,
    readbackProven: false,
    approvalRef: null,
    ...over,
  }
}

/**
 * An approval reference derived from the operation, not minted by writing a row.
 *
 * Deliberately NOT a new approval record. There is an approvals substrate in
 * this application already, with its own lane and its own lifecycle, and
 * inventing a second one here — from a code path whose job is to REFUSE to act
 * without approval — would be exactly the speculative provider this mutation is
 * forbidden from creating. The reference is stable and traceable to the
 * operation; granting it is the approvals lane's business, not this file's.
 */
function approvalRefFor(operationId: string): string {
  return `appr:${operationId}`
}

export async function runCustomerAction(
  req: CustomerActionRequest,
  ports: CustomerActionPorts,
): Promise<CustomerActionOutcome> {
  // ── Refusals that must NOT leave a ledger row behind ──────────────────────
  //
  // Claiming an operation for an action that can never run would put a row in
  // the shared table that no retry could ever resolve, and it would appear in
  // the customer's action history as something that was attempted.

  if (!req.idempotencyKey?.trim()) {
    return outcome(req, 'validation_failed', { detail: 'An idempotency key is required.' })
  }

  const meta = findGovernedAction(req.actionType)
  if (!meta) {
    // This is where `note.add` and anything else unregistered is refused.
    return outcome(req, 'validation_failed', {
      detail: `There is no action called ${req.actionType}. Nothing was sent.`,
    })
  }

  const role = req.actorRole as Role
  const permitted = ACTIONS_BY_ROLE[role] ?? []
  if (!permitted.includes(req.actionType) || !meta.allowedRoles.includes(req.actorRole)) {
    return outcome(req, 'permission_denied')
  }

  // ── The ledger claim. This is the exactly-once boundary. ──────────────────

  const identity: OperationIdentity = {
    callerClass: CALLER_CLASS,
    tenantId: req.tenantId,
    companyId: req.companyId,
    actionType: req.actionType,
    objectType: ACTION_OBJECT_TYPE,
    objectId: req.customerId,
    idempotencyKey: req.idempotencyKey,
  }

  let claim
  try {
    claim = await claimOperation(
      {
        identity,
        // The arguments as AUTHORISED, which is what a conflict is judged on.
        authorizedArguments: req.payload,
        correlationId: req.correlationId,
        actorRef: req.actorPrincipalId,
        contextRef: null,
        auditRef: null,
        retryFailed: true,
      },
      ports.ledger,
    )
  } catch {
    // The ledger itself is a dependency. It being down is not a refusal by the
    // system of record, and nothing was written to Odoo.
    return outcome(req, 'dependency_unavailable')
  }

  if (claim.status !== 'claimed' && claim.status !== 'retry_after_failure') {
    const lifecycle = fromClaimStatus(claim.status)
    return outcome(req, lifecycle, {
      operationId: claim.operationId,
      auditRef: claim.operationId,
      readbackProven:
        claim.status === 'already_completed' ? !!claim.record.envelope?.readback : false,
      detail:
        claim.status === 'argument_conflict'
          ? LIFECYCLE_PRESENTATION.argument_conflict.sentence
          : LIFECYCLE_PRESENTATION[lifecycle].sentence,
    })
  }

  const recordId = claim.recordId
  const operationId = claim.operationId

  const envelope: OperationEnvelope = {
    version: 'operations.ledger@1',
    callerClass: CALLER_CLASS,
    companyId: req.companyId,
    actionType: req.actionType,
    objectType: ACTION_OBJECT_TYPE,
    objectId: req.customerId,
    actorRef: req.actorPrincipalId,
    auditRef: operationId,
    readback: null,
    result: null,
  }

  const proposal: ActionProposal = {
    actionType: req.actionType,
    actorPrincipalId: req.actorPrincipalId,
    actorRole: req.actorRole,
    companyId: req.companyId,
    objectType: ACTION_OBJECT_TYPE,
    objectId: req.customerId,
    payload: req.payload,
    idempotencyKey: req.idempotencyKey,
    correlationId: req.correlationId,
  }

  /** Set by writeAudit, so the caller can report the validator's own wording. */
  let internalDetail = ''

  const actionPorts: ActionPorts = {
    executors: ports.executors,
    approvalRequired: (actionType) => ACTIONS_REQUIRING_APPROVAL.includes(actionType),
    // No verdict source is wired. The governed runtime therefore HOLDS at
    // APPROVAL_REQUIRED rather than proceeding, which is the safe direction:
    // an absent approval authority must never read as a granted one.
    approvalVerdict: undefined,
    // The route has already proven this customer is readable in THIS tenant's
    // Odoo before proposing, so a second company check here would be a
    // tautology rather than a boundary. See the route for where it is enforced.
    objectCompanyId: undefined,
    // The ledger already ruled on replay. Two idempotency mechanisms would
    // eventually disagree; see this module's header.
    findPriorResult: async () => null,
    recordApprovalRequest: async () => approvalRefFor(operationId),
    writeAudit: async (entry) => {
      internalDetail = entry.detail
      if (entry.outcome === 'EXECUTED') {
        await completeOperation(
          recordId,
          {
            envelope,
            readback: entry.readback,
            result: null,
            auditRef: operationId,
          },
          ports.ledger,
        )
      } else {
        // Recorded with the OUTCOME as the failure class, so the history read in
        // lib/context/recent-actions.ts can map it back to the same lifecycle
        // state rather than guessing. APPROVAL_REQUIRED lands here too: it is
        // not a failure, but it does mean this attempt stopped, and leaving the
        // row claimed would make every later attempt look in-flight forever.
        await failOperation(
          recordId,
          { failureClass: entry.outcome, detail: entry.detail },
          ports.ledger,
        )
      }
      return operationId
    },
  }

  let result
  try {
    result = await runGovernedAction(proposal, actionPorts)
  } catch {
    // runGovernedAction itself only throws if a PORT throws — which here means
    // the ledger. The write to the system of record may or may not have
    // happened, and we cannot prove which. That is readback_failed by
    // definition, not a clean failure.
    return outcome(req, 'readback_failed', {
      operationId,
      auditRef: operationId,
    })
  }

  const lifecycle = fromActionOutcome(result.outcome)

  return outcome(req, lifecycle, {
    operationId,
    auditRef: result.auditId || operationId,
    readbackProven: !!result.readback,
    approvalRef: result.approvalId ?? null,
    // Only a validation failure returns anything beyond the contract sentence,
    // and only because that wording is OURS: "body is required" names a field
    // on a form, not a system, a host or a driver.
    detail:
      lifecycle === 'validation_failed' && internalDetail
        ? internalDetail
        : LIFECYCLE_PRESENTATION[lifecycle].sentence,
  })
}
