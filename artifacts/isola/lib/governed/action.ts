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

export type ActionOutcome =
  | 'EXECUTED'
  | 'AWAITING_APPROVAL'
  | 'REJECTED'
  | 'EXECUTOR_UNAVAILABLE'
  | 'UNAUTHORIZED'
  | 'INVALID'
  | 'READBACK_FAILED'
  | 'DUPLICATE_IGNORED'

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

export interface ActionPorts {
  executors: readonly ActionExecutor[]
  /** True when this action type at this risk level needs a human. */
  approvalRequired(actionType: string, risk: RiskLevel, role: string): boolean
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
      outcome: 'INVALID',
      riskLevel: risk,
      detail: 'idempotencyKey is required',
      readback: null,
    })
    return result(proposal, 'INVALID', risk, 'idempotencyKey is required', auditId)
  }

  // Idempotency BEFORE anything else: a retry must never execute twice.
  const prior = await ports.findPriorResult(proposal.idempotencyKey)
  if (prior) {
    return { ...prior, outcome: 'DUPLICATE_IGNORED', detail: 'replayed prior result' }
  }

  if (!executor) {
    const detail = `no executor declared for ${proposal.actionType}`
    const auditId = await ports.writeAudit({
      proposal,
      outcome: 'INVALID',
      riskLevel: risk,
      detail,
      readback: null,
    })
    return result(proposal, 'INVALID', risk, detail, auditId)
  }

  if (!executor.allowedRoles.includes(proposal.actorRole)) {
    const detail = `role ${proposal.actorRole} may not propose ${proposal.actionType}`
    const auditId = await ports.writeAudit({
      proposal,
      outcome: 'UNAUTHORIZED',
      riskLevel: risk,
      detail,
      readback: null,
    })
    return result(proposal, 'UNAUTHORIZED', risk, detail, auditId)
  }

  const valid = executor.validate(proposal.payload)
  if (!valid.ok) {
    const auditId = await ports.writeAudit({
      proposal,
      outcome: 'INVALID',
      riskLevel: risk,
      detail: valid.detail,
      readback: null,
    })
    return result(proposal, 'INVALID', risk, valid.detail, auditId)
  }

  if (ports.approvalRequired(proposal.actionType, risk, proposal.actorRole)) {
    const approvalId = await ports.recordApprovalRequest(proposal, risk)
    const auditId = await ports.writeAudit({
      proposal,
      outcome: 'AWAITING_APPROVAL',
      riskLevel: risk,
      detail: `approval ${approvalId} required`,
      readback: null,
    })
    return result(
      proposal,
      'AWAITING_APPROVAL',
      risk,
      `approval ${approvalId} required`,
      auditId,
      null,
      approvalId,
    )
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

  const { externalId } = await executor.execute(proposal)
  const readback = await executor.readback(externalId, proposal)

  if (!readback) {
    const detail = `executed ${externalId} but readback returned nothing; success is NOT claimed`
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
  return result(proposal, 'EXECUTED', risk, `executed and read back ${externalId}`, auditId, readback)
}
