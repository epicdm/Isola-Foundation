/**
 * governed-action@1 — the lifecycle every production action must walk.
 *
 *   propose → validate → authorize → approve (when required) → execute
 *           → authoritative readback → audit
 *
 * The single most important behaviour in this file is what happens when an
 * executor does not exist yet: the action returns `EXECUTOR_UNAVAILABLE`. It does
 * NOT return success. An agent that is told "done" when nothing happened will
 * tell a staff member their task was assigned, and the task will not exist.
 *
 * The second most important: success is only claimed after READBACK. Executing
 * and reading back are different facts, and only the second one is evidence.
 */

export const GOVERNED_ACTION_VERSION = 'governed-action@1' as const

export const RISK_LEVELS = ['low', 'medium', 'high'] as const
export type RiskLevel = (typeof RISK_LEVELS)[number]

/**
 * Every distinct way an action can end. Deliberately granular: collapsing "the
 * dependency was down" into "it failed" loses the one bit an operator needs in
 * order to know whether retrying is sensible.
 */
export type ActionOutcome =
  | 'EXECUTED'
  | 'VALIDATION_FAILED'
  | 'PERMISSION_DENIED'
  | 'APPROVAL_REQUIRED'
  | 'APPROVAL_REJECTED'
  | 'EXECUTOR_UNAVAILABLE'
  | 'EXECUTION_FAILED'
  | 'READBACK_FAILED'
  | 'IDEMPOTENT_REPLAY'
  | 'DEPENDENCY_UNAVAILABLE'

export interface ActionProposal {
  actionType: string
  actorPrincipalId: string
  actorRole: string
  companyId: string
  requestingAgentRef?: string | null
  objectType: string
  objectId: string
  payload: Record<string, unknown>
  idempotencyKey: string
  correlationId: string
}

export interface ActionResult {
  version: typeof GOVERNED_ACTION_VERSION
  outcome: ActionOutcome
  actionType: string
  idempotencyKey: string
  correlationId: string
  riskLevel: RiskLevel
  /** Set only when the outcome is EXECUTED — and only after readback returned. */
  readback: Record<string, unknown> | null
  auditId: string
  detail: string
  approvalId?: string
}

export interface ActionExecutor {
  actionType: string
  riskLevel: RiskLevel
  /** Roles permitted to propose this action at all. */
  allowedRoles: readonly string[]
  /** Reject a malformed payload before anything else happens. */
  validate(payload: Record<string, unknown>): { ok: true } | { ok: false; detail: string }
  /**
   * Perform the write. Present only when an executor genuinely exists — an entry
   * with `execute` undefined is a DECLARED but UNIMPLEMENTED action, and returns
   * EXECUTOR_UNAVAILABLE rather than pretending.
   */
  execute?(input: ActionProposal): Promise<{ externalId: string }>
  /** Read the record back from the system of record. The only proof of success. */
  readback?(externalId: string, input: ActionProposal): Promise<Record<string, unknown> | null>
}

/**
 * Raised by an executor when the SYSTEM OF RECORD is unreachable, as opposed to
 * the write being rejected. Retrying is sensible for one and not the other, so
 * the caller must be able to tell them apart.
 */
export class DependencyUnavailable extends Error {
  constructor(
    public readonly dependency: string,
    message: string,
  ) {
    super(message)
    this.name = 'DependencyUnavailable'
  }
}

/**
 * Raised by an executor when a WRITE MAY OR MAY NOT HAVE LANDED.
 *
 * The third case, and the one that was missing. `DependencyUnavailable` asserts
 * the system of record never received the write; an ordinary Error asserts it
 * received and refused. A request that timed out, or failed after the bytes went
 * out, asserts NEITHER — and reporting it as "not reached, nothing written,
 * trying again is reasonable" is the most dangerous of the three, because on a
 * customer-visible send it invites a SECOND message to a customer who already
 * received the first.
 *
 * Measured 2026-08-28 (def-c360-send-timeout-classified-as-non-delivery-enables-
 * duplicate-2026-08-28): a 10s abort on the Chatwoot POST carried no HTTP status,
 * was classified as a dependency outage, and told the operator nothing was
 * written — while the message sat in the customer's conversation.
 *
 * This maps to READBACK_FAILED, whose presentation already says the true thing:
 * something was written, we cannot prove what, do not treat it as done, and
 * re-sending is unsafe.
 *
 * An ambiguous negative is not a finding — it is an ambiguity, and it must be
 * reported as one.
 */
export class WriteIndeterminate extends Error {
  constructor(
    public readonly dependency: string,
    message: string,
  ) {
    super(message)
    this.name = 'WriteIndeterminate'
  }
}

export type ApprovalVerdict =
  | { state: 'pending'; approvalId: string }
  | { state: 'granted'; approvalId: string }
  | { state: 'rejected'; approvalId: string; reason: string }

export interface ActionPorts {
  executors: readonly ActionExecutor[]
  /** True when this action type at this risk level needs a human. */
  approvalRequired(actionType: string, risk: RiskLevel, role: string): boolean
  /**
   * The standing verdict for this proposal, if a human has already ruled. An
   * absent implementation means "no verdict yet" and the action holds.
   */
  approvalVerdict?(p: ActionProposal): Promise<ApprovalVerdict>
  /**
   * The company that owns the record this action targets, or null when there is
   * no such record. An absent implementation means the caller has already scoped
   * the object and no further check is made here.
   */
  objectCompanyId?(p: ActionProposal): Promise<string | null>
  /** Returns a prior result for this idempotency key, if one exists. */
  findPriorResult(idempotencyKey: string): Promise<ActionResult | null>
  recordApprovalRequest(p: ActionProposal, risk: RiskLevel): Promise<string>
  writeAudit(entry: {
    proposal: ActionProposal
    outcome: ActionOutcome
    riskLevel: RiskLevel
    detail: string
    readback: Record<string, unknown> | null
  }): Promise<string>
}

function result(
  p: ActionProposal,
  outcome: ActionOutcome,
  riskLevel: RiskLevel,
  detail: string,
  auditId: string,
  readback: Record<string, unknown> | null = null,
  approvalId?: string,
): ActionResult {
  return {
    version: GOVERNED_ACTION_VERSION,
    outcome,
    actionType: p.actionType,
    idempotencyKey: p.idempotencyKey,
    correlationId: p.correlationId,
    riskLevel,
    readback,
    auditId,
    detail,
    ...(approvalId ? { approvalId } : {}),
  }
}

export async function runGovernedAction(
  proposal: ActionProposal,
  ports: ActionPorts,
): Promise<ActionResult> {
  const executor = ports.executors.find((e) => e.actionType === proposal.actionType)
  const risk: RiskLevel = executor?.riskLevel ?? 'high'

  if (!proposal.idempotencyKey?.trim()) {
    const auditId = await ports.writeAudit({
      proposal,
      outcome: 'VALIDATION_FAILED',
      riskLevel: risk,
      detail: 'idempotencyKey is required',
      readback: null,
    })
    return result(proposal, 'VALIDATION_FAILED', risk, 'idempotencyKey is required', auditId)
  }

  // Idempotency BEFORE anything else: a retry must never execute twice, and must
  // not be re-judged against permissions that may have changed since.
  const prior = await ports.findPriorResult(proposal.idempotencyKey)
  if (prior) {
    return { ...prior, outcome: 'IDEMPOTENT_REPLAY', detail: 'replayed prior result' }
  }

  if (!executor) {
    const detail = `no executor declared for ${proposal.actionType}`
    const auditId = await ports.writeAudit({
      proposal,
      outcome: 'VALIDATION_FAILED',
      riskLevel: risk,
      detail,
      readback: null,
    })
    return result(proposal, 'VALIDATION_FAILED', risk, detail, auditId)
  }

  if (!executor.allowedRoles.includes(proposal.actorRole)) {
    const detail = `role ${proposal.actorRole} may not propose ${proposal.actionType}`
    const auditId = await ports.writeAudit({
      proposal,
      outcome: 'PERMISSION_DENIED',
      riskLevel: risk,
      detail,
      readback: null,
    })
    return result(proposal, 'PERMISSION_DENIED', risk, detail, auditId)
  }

  // ── Company scoping. Runs BEFORE validate and before any write. ─────────────
  if (ports.objectCompanyId) {
    const owner = await ports.objectCompanyId(proposal)
    if (owner !== proposal.companyId) {
      // "Does not exist" and "belongs to someone else" collapse into ONE refusal
      // with ONE wording. Distinguishing them would hand the caller an oracle for
      // enumerating another company's record ids.
      const detail = `${proposal.objectType} ${proposal.objectId} is not available to this company`
      const auditId = await ports.writeAudit({
        proposal,
        outcome: 'PERMISSION_DENIED',
        riskLevel: risk,
        detail,
        readback: null,
      })
      return result(proposal, 'PERMISSION_DENIED', risk, detail, auditId)
    }
  }

  const valid = executor.validate(proposal.payload)
  if (!valid.ok) {
    const auditId = await ports.writeAudit({
      proposal,
      outcome: 'VALIDATION_FAILED',
      riskLevel: risk,
      detail: valid.detail,
      readback: null,
    })
    return result(proposal, 'VALIDATION_FAILED', risk, valid.detail, auditId)
  }

  if (ports.approvalRequired(proposal.actionType, risk, proposal.actorRole)) {
    const verdict = await ports.approvalVerdict?.(proposal)

    if (verdict?.state === 'rejected') {
      const detail = `approval ${verdict.approvalId} rejected: ${verdict.reason}`
      const auditId = await ports.writeAudit({
        proposal,
        outcome: 'APPROVAL_REJECTED',
        riskLevel: risk,
        detail,
        readback: null,
      })
      return result(proposal, 'APPROVAL_REJECTED', risk, detail, auditId, null, verdict.approvalId)
    }

    if (verdict?.state !== 'granted') {
      const approvalId = verdict?.approvalId || (await ports.recordApprovalRequest(proposal, risk))
      const detail = `approval ${approvalId} required`
      const auditId = await ports.writeAudit({
        proposal,
        outcome: 'APPROVAL_REQUIRED',
        riskLevel: risk,
        detail,
        readback: null,
      })
      return result(proposal, 'APPROVAL_REQUIRED', risk, detail, auditId, null, approvalId)
    }
    // granted — fall through and execute
  }

  // ── The honest branch. A declared action with no implementation says so. ────
  if (!executor.execute || !executor.readback) {
    const detail = `${proposal.actionType} is declared but has no executor; nothing was performed`
    const auditId = await ports.writeAudit({
      proposal,
      outcome: 'EXECUTOR_UNAVAILABLE',
      riskLevel: risk,
      detail,
      readback: null,
    })
    return result(proposal, 'EXECUTOR_UNAVAILABLE', risk, detail, auditId)
  }

  let externalId: string
  try {
    ;({ externalId } = await executor.execute(proposal))
  } catch (err) {
    // THREE cases, not two. A dependency being DOWN is not the same as a write
    // being REFUSED, and neither is the same as a write whose fate is UNKNOWN.
    // Collapsing the third into the first is what turns a delivered message into
    // a second delivered message.
    const indeterminate = err instanceof WriteIndeterminate
    const down = !indeterminate && err instanceof DependencyUnavailable
    const outcome: ActionOutcome = indeterminate
      ? 'READBACK_FAILED'
      : down
        ? 'DEPENDENCY_UNAVAILABLE'
        : 'EXECUTION_FAILED'
    const detail = indeterminate
      ? `write to ${(err as WriteIndeterminate).dependency} did not confirm: ${err.message}`
      : down
        ? `dependency ${(err as DependencyUnavailable).dependency} unavailable: ${err.message}`
        : `execution failed: ${err instanceof Error ? err.message : String(err)}`
    const auditId = await ports.writeAudit({
      proposal,
      outcome,
      riskLevel: risk,
      detail,
      readback: null,
    })
    return result(proposal, outcome, risk, detail, auditId)
  }

  let readback: Record<string, unknown> | null
  try {
    readback = await executor.readback(externalId, proposal)
  } catch (err) {
    // We wrote something and cannot prove what. That is NOT success, and it is
    // not a clean failure either — say so, and name the id so a human can look.
    const detail = `wrote ${externalId} but readback threw: ${err instanceof Error ? err.message : String(err)}`
    const auditId = await ports.writeAudit({
      proposal,
      outcome: 'READBACK_FAILED',
      riskLevel: risk,
      detail,
      readback: null,
    })
    return result(proposal, 'READBACK_FAILED', risk, detail, auditId)
  }

  if (!readback) {
    const detail = `executed ${externalId} but readback returned nothing or did not match; success is NOT claimed`
    const auditId = await ports.writeAudit({
      proposal,
      outcome: 'READBACK_FAILED',
      riskLevel: risk,
      detail,
      readback: null,
    })
    return result(proposal, 'READBACK_FAILED', risk, detail, auditId)
  }

  const auditId = await ports.writeAudit({
    proposal,
    outcome: 'EXECUTED',
    riskLevel: risk,
    detail: `executed and read back ${externalId}`,
    readback,
  })
  return result(
    proposal,
    'EXECUTED',
    risk,
    `executed and read back ${externalId}`,
    auditId,
    readback,
  )
}
