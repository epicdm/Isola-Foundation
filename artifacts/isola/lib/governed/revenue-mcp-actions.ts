/**
 * revenue-mcp-actions@1 — the runtime binding for `revenue.followup.set`, the
 * write half of Lane 1's two-tool MCP milestone. Exposed to Clawith ("Atlas")
 * as `isola_revenue_followup_set` (see lib/revenue-mcp/handlers.ts).
 *
 * WHY THIS IS NOT `customer-actions.ts` WITH A DIFFERENT NAME
 * ------------------------------------------------------------
 * `runCustomerAction` (customer-actions.ts) is deliberately kept as the
 * FOUNDATION-STAFF binding: `CALLER_CLASS = 'foundation_staff'`, idempotency
 * via the shared operation ledger, and approval permanently unwired (holds
 * forever — see that file's header). Reusing it here would mislabel an
 * AI-agent-initiated CRM mutation as ordinary staff self-service in the audit
 * trail, and would give it no way to ever actually get approved. This file:
 *
 *   - CALLER_CLASS = 'clawith_agent', OBJECT_TYPE = 'crm_lead' (not the
 *     overloaded 'customer' object type customer-actions.ts uses) —
 *     objectId is the Odoo crm.lead id.
 *   - idempotency via `runGovernedAction`'s own `findPriorResult`, backed by
 *     a REAL lookup against the existing AuditLog table (see
 *     "IDEMPOTENCY — WHY AuditLog AND NOT A NEW TABLE" below) — not the
 *     shared operation ledger.
 *   - approval REAL, wired, and STRICTLY BOUND — via
 *     lib/governed/revenue-followup-approval.ts, NOT `checkGate()`. Per the
 *     ratified Port decision `dec-pr41-delivery-and-revenue-mcp-write-approval-2026-08-06`,
 *     `checkGate()`'s `(tenantId, action, requestId)` key is not sufficient
 *     for an autonomous agent write: it grants on an id matching alone, with
 *     no binding to which agent proposed it, which object, which fields, or
 *     which VALUES were actually approved, no expiry, and no revocation. See
 *     revenue-followup-approval.ts's header for the eight bound dimensions.
 *     Approval is unconditionally required for this action type (a real
 *     Odoo CRM write, performed autonomously by an AI agent) — never
 *     risk-conditional the way ACTIONS_REQUIRING_APPROVAL is for staff
 *     actions in resolve-context.ts.
 *
 * ONE ACTION, TWO ODOO EFFECTS, ONE externalId
 * ---------------------------------------------
 * `revenue.followup.set` can move an owner (`rec.updateLead`) AND schedule a
 * follow-up activity (`rec.scheduleFollowup`) in the SAME governed pass — one
 * idempotency key, one approval decision, one audit row, one result. But
 * `ActionExecutor.execute()` can only return ONE `{ externalId }`.
 *
 * DECISION: externalId = the crm.lead id (`proposal.objectId`) — the object
 * this whole action is ABOUT. The follow-up activity's own id is threaded
 * through a closure-local variable (`lastFollowupExternalId`, reset at the
 * top of every `execute()` call) rather than extending `RecordSystem`'s
 * public interface — extending the shared interface for one caller's
 * bookkeeping need would leak this file's plumbing into
 * executors/index.ts and odoo-record-system.ts, which the task explicitly
 * asks not to modify. `readback()` re-reads BOTH effects for real: the lead
 * via `rec.readLead(externalId)` (proving the owner landed) and the
 * follow-up via `rec.readFollowup(lastFollowupExternalId)` (proving the
 * next-action/due-date landed) — never trusting the create response alone.
 * This is safe ACROSS CONCURRENT CALLS because a fresh executor (and a fresh
 * closure variable) is built per call by `buildRevenueFollowupExecutor()`,
 * exactly like `buildExecutors(rec)` is called fresh per request elsewhere
 * in this codebase (see app/api/v1/customers/[customerId]/actions/route.ts).
 *
 * IDEMPOTENCY — WHY AuditLog AND NOT A NEW TABLE
 * -------------------------------------------------
 * CLAUDE.md law 4 forbids `prisma db push` and this task forbids a new
 * migration without a separate owner gate. AuditLog already carries
 * `tenant_id` + `action` + `request_id` + `meta` (Json), which is exactly the
 * shape a durable idempotency lookup needs: `findPriorRevenueActionResult`
 * looks up the most recent row with `action = 'revenue.followup.set'`,
 * `request_id = idempotencyKey`, `tenant_id = <resolved tenant>`, and an
 * `outcome: 'EXECUTED'` in `meta`, then reconstructs a real `ActionResult`
 * from it. This is real, durable, cross-process persistence proven by a test
 * that writes through `writeAudit` and reads back through
 * `findPriorRevenueActionResult` against a Prisma mock backed by an in-memory
 * row array — not an in-process-only stub. It is NOT atomic the way the
 * shared ledger's unique index is (a true race between two concurrent first
 * attempts could both pass this check) — acceptable here because approval is
 * unconditionally required first, which serializes practice traffic through
 * a human decision point before execution is ever reached.
 *
 * ONLY non-EXECUTED outcomes are never replayed. A prior APPROVAL_REQUIRED
 * row must NOT cause every later call with the same key to replay
 * APPROVAL_REQUIRED forever once a human approves — it must re-run and pick
 * up the now-granted verdict. Only `EXECUTED` is a terminal fact worth
 * protecting from a second write.
 */

import type { Prisma } from '@prisma/client'

import { prisma } from '@/lib/prisma'

import {
  GOVERNED_ACTION_VERSION,
  runGovernedAction,
  type ActionExecutor,
  type ActionPorts,
  type ActionProposal,
  type ActionResult,
  type RiskLevel,
} from './action'
import type { RecordSystem } from './executors'
import {
  computeApprovalScope,
  mintPendingApproval,
  verdictForRevenueFollowup,
  type RevenueApprovalScope,
} from './revenue-followup-approval'

export const REVENUE_MCP_ACTIONS_VERSION = 'revenue-mcp-actions@1' as const

/** The AI-agent caller class. Never conflated with Foundation staff. */
export const CALLER_CLASS = 'clawith_agent' as const

/** Not `'customer'` — customer-actions.ts's object type is deliberately not reused. */
export const ACTION_OBJECT_TYPE = 'crm_lead' as const

export const REVENUE_FOLLOWUP_SET_ACTION = 'revenue.followup.set' as const

/** The ONLY three keys this action ever reads from a payload. See file header. */
const REVENUE_FOLLOWUP_FIELDS = ['ownerRef', 'nextAction', 'dueDate'] as const

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

/**
 * The single source of truth for the write-surface allowlist. Used by
 * `validate`/`execute`/`readback` AND by the approval scope computation, so
 * "what fields can this action touch" and "what fields is an approval bound
 * to" can never drift from each other.
 */
export function pickedRevenueFields(payload: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const k of REVENUE_FOLLOWUP_FIELDS) {
    const v = str(payload[k])
    if (v) out[k] = v
  }
  return out
}

function validDate(v: unknown): boolean {
  const s = str(v)
  if (!s) return false
  return !Number.isNaN(new Date(s).getTime())
}

// ── the bespoke executor — see the file header for the externalId decision ──

/**
 * A single ActionExecutor for `revenue.followup.set`. Builds a fresh one per
 * call (see `runRevenueFollowupSet`) so the closure-local follow-up id can
 * never leak between concurrent proposals.
 */
export function buildRevenueFollowupExecutor(rec: RecordSystem): ActionExecutor {
  let lastFollowupExternalId: string | null = null

  return {
    actionType: REVENUE_FOLLOWUP_SET_ACTION,
    riskLevel: 'high',
    // Exclusively an agent-initiated action. No human role proposes this
    // directly — a human approves it, through
    // lib/governed/revenue-followup-approval.ts, not by holding a role that
    // could propose it themselves.
    allowedRoles: [CALLER_CLASS],

    validate: (payload) => {
      // Write-surface discipline: pickedRevenueFields() is the ONLY reader of
      // `payload` anywhere in this executor. Any other key is inert — it can
      // never widen the write, whether or not it happens to be present.
      const picked = pickedRevenueFields(payload)
      const ownerRef = picked.ownerRef ?? ''
      const nextAction = picked.nextAction ?? ''
      const dueDate = picked.dueDate ?? ''

      if (!ownerRef && !nextAction && !dueDate) {
        return { ok: false, detail: 'at least one of ownerRef, nextAction, dueDate is required' }
      }
      // followup.schedule's underlying Odoo effect (rec.scheduleFollowup)
      // requires BOTH a note and a due date — see executors/index.ts's
      // `followup.schedule` validate(). Accepting one without the other here
      // would silently drop it instead of scheduling anything.
      if ((nextAction && !dueDate) || (!nextAction && dueDate)) {
        return { ok: false, detail: 'nextAction and dueDate must be provided together' }
      }
      if (dueDate && !validDate(dueDate)) {
        return { ok: false, detail: 'dueDate is not a valid date' }
      }
      if (ownerRef && (!Number.isFinite(Number(ownerRef)) || Number(ownerRef) <= 0)) {
        return { ok: false, detail: 'ownerRef must be an Odoo res.users id' }
      }
      return { ok: true }
    },

    execute: async (p: ActionProposal) => {
      lastFollowupExternalId = null

      const picked = pickedRevenueFields(p.payload)
      const ownerRef = picked.ownerRef ?? ''
      const nextAction = picked.nextAction ?? ''
      const dueDate = picked.dueDate ?? ''

      // Effect 1 — owner change, via the SAME rec.updateLead() lead.update uses.
      if (ownerRef) {
        await rec.updateLead({ companyId: p.companyId, leadId: p.objectId, fields: { ownerRef } })
      }

      // Effect 2 — next-action + due date, via the SAME rec.scheduleFollowup()
      // followup.schedule uses. Creates a NEW mail.activity; does not edit an
      // existing one (matches followup.schedule's own documented semantics).
      if (nextAction && dueDate) {
        const created = await rec.scheduleFollowup({
          companyId: p.companyId,
          objectType: 'crm.lead',
          objectId: p.objectId,
          note: nextAction,
          dueDate,
          ownerRef: ownerRef || null,
        })
        lastFollowupExternalId = created.externalId
      }

      // The lead IS the object this action is about — see the file header.
      return { externalId: p.objectId }
    },

    readback: async (externalId, p) => {
      const leadRow = await rec.readLead(externalId)
      if (!leadRow) return null

      const picked = pickedRevenueFields(p.payload)
      const ownerRef = picked.ownerRef ?? ''
      if (ownerRef && str(leadRow.ownerRef) !== ownerRef) return null

      const nextAction = picked.nextAction ?? ''
      const dueDate = picked.dueDate ?? ''
      let followup: Record<string, unknown> | null = null

      if (nextAction && dueDate) {
        if (!lastFollowupExternalId) return null // scheduled but id was lost — do not claim success
        followup = await rec.readFollowup(lastFollowupExternalId)
        if (!followup) return null
        if (str(followup.note) !== nextAction) return null
      }

      return {
        leadId: externalId,
        name: leadRow.name,
        stage: leadRow.stage,
        ownerRef: leadRow.ownerRef,
        followup: followup
          ? { activityId: lastFollowupExternalId, note: followup.note, dueDate: dueDate || null }
          : null,
      }
    },
  }
}

// ── idempotency, backed by AuditLog — see the file header ──────────────────

interface StoredActionMeta {
  outcome?: string
  riskLevel?: RiskLevel
  detail?: string
  readback?: Record<string, unknown> | null
  correlationId?: string
  approvalId?: string | null
}

export async function findPriorRevenueActionResult(
  tenantId: string,
  idempotencyKey: string,
): Promise<ActionResult | null> {
  const row = await prisma.auditLog.findFirst({
    where: {
      tenant_id: tenantId,
      action: REVENUE_FOLLOWUP_SET_ACTION,
      request_id: idempotencyKey,
    },
    orderBy: { created_at: 'desc' },
  })
  if (!row) return null

  const meta = (row.meta ?? {}) as StoredActionMeta
  // Only an EXECUTED write is a fact worth protecting from a second attempt —
  // see the file header ("ONLY non-EXECUTED outcomes are never replayed").
  if (meta.outcome !== 'EXECUTED') return null

  return {
    version: GOVERNED_ACTION_VERSION,
    outcome: 'EXECUTED',
    actionType: REVENUE_FOLLOWUP_SET_ACTION,
    idempotencyKey,
    correlationId: meta.correlationId ?? '',
    riskLevel: meta.riskLevel ?? 'high',
    readback: meta.readback ?? null,
    auditId: row.id,
    detail: meta.detail ?? 'executed',
    ...(meta.approvalId ? { approvalId: meta.approvalId } : {}),
  }
}

async function writeRevenueAuditRow(
  tenantId: string,
  actorRef: string,
  entry: {
    proposal: ActionProposal
    outcome: string
    riskLevel: RiskLevel
    detail: string
    readback: Record<string, unknown> | null
  },
  approvalId: string | null,
): Promise<string> {
  const meta: StoredActionMeta & Record<string, unknown> = {
    outcome: entry.outcome,
    riskLevel: entry.riskLevel,
    detail: entry.detail,
    readback: entry.readback,
    correlationId: entry.proposal.correlationId,
    approvalId,
    payload: entry.proposal.payload,
  }
  const row = await prisma.auditLog.create({
    data: {
      tenant_id: tenantId,
      actor_id: actorRef,
      action: entry.proposal.actionType,
      entity: ACTION_OBJECT_TYPE,
      entity_id: entry.proposal.objectId,
      request_id: entry.proposal.idempotencyKey,
      meta: JSON.parse(JSON.stringify(meta)) as Prisma.InputJsonValue,
    },
  })
  return row.id
}

// ── caller identity resolution — never trust a bare tenant id ──────────────

export interface RevenueMcpPorts {
  /** Resolves the CALLER's identity to a Foundation tenant. Never the reverse. */
  resolveTenantForAgent(agentRef: string): Promise<string | null>
  /**
   * A RecordSystem already scoped to the RESOLVED tenant's own Odoo binding
   * (built by the caller of this module, e.g. via
   * `createOdooRecordSystem({ resolveConfig: () => resolveOdooConfigForTenant(tenantId) })`).
   * Reused for BOTH the write effects and the company-scoping read below —
   * see `objectCompanyId`.
   */
  rec: RecordSystem
  now(): Date
}

async function defaultResolveTenantForAgent(agentRef: string): Promise<string | null> {
  const agent = await prisma.agent.findUnique({ where: { id: agentRef } })
  return agent?.is_active ? agent.tenant_id : null
}

/**
 * Derives the approval scope from the RESOLVED tenant and the proposal's OWN
 * fields — never from anything a caller could pass as an "approval token".
 * `p.actorPrincipalId` is the Clawith agent reference (see the file header's
 * 8-dimension list) — the SAME value the caller supplied as `caller.agentRef`,
 * already resolved to `tenantId` above.
 */
function buildApprovalScope(tenantId: string, p: ActionProposal): RevenueApprovalScope {
  return computeApprovalScope({
    tenantId,
    clawithAgentId: p.actorPrincipalId,
    tool: p.actionType,
    objectId: p.objectId,
    fields: pickedRevenueFields(p.payload),
    correlationId: p.correlationId,
    idempotencyKey: p.idempotencyKey,
  })
}

export interface RevenueFollowupSetRequest {
  caller: { agentRef: string }
  /** The Odoo crm.lead id this follow-up targets. */
  leadId: string
  payload: { ownerRef?: string; nextAction?: string; dueDate?: string }
  idempotencyKey: string
  correlationId: string
}

export type RevenueFollowupSetResult =
  | { ok: true; result: ActionResult }
  | { ok: false; code: 'unauthenticated'; detail: string }

export async function runRevenueFollowupSet(
  req: RevenueFollowupSetRequest,
  ports: Omit<RevenueMcpPorts, 'resolveTenantForAgent'> &
    Partial<Pick<RevenueMcpPorts, 'resolveTenantForAgent'>>,
): Promise<RevenueFollowupSetResult> {
  const resolveTenantForAgent = ports.resolveTenantForAgent ?? defaultResolveTenantForAgent

  const agentRef = str(req.caller?.agentRef)
  if (!agentRef) return { ok: false, code: 'unauthenticated', detail: 'no caller identity was supplied' }

  const tenantId = await resolveTenantForAgent(agentRef)
  if (!tenantId) {
    return { ok: false, code: 'unauthenticated', detail: 'caller identity did not resolve to an active tenant' }
  }

  const leadId = str(req.leadId)
  const idempotencyKey = str(req.idempotencyKey)
  const correlationId = str(req.correlationId)

  const proposal: ActionProposal = {
    actionType: REVENUE_FOLLOWUP_SET_ACTION,
    actorPrincipalId: agentRef,
    actorRole: CALLER_CLASS,
    companyId: tenantId,
    objectType: ACTION_OBJECT_TYPE,
    objectId: leadId,
    payload: {
      ...(req.payload?.ownerRef !== undefined ? { ownerRef: req.payload.ownerRef } : {}),
      ...(req.payload?.nextAction !== undefined ? { nextAction: req.payload.nextAction } : {}),
      ...(req.payload?.dueDate !== undefined ? { dueDate: req.payload.dueDate } : {}),
    },
    idempotencyKey,
    correlationId,
  }

  const actorRef = `clawith_agent:${agentRef}`
  // Captured across ports so `writeAudit` can persist the approvalId even
  // though `ActionPorts.writeAudit`'s entry does not itself carry one.
  let lastApprovalId: string | null = null

  const actionPorts: ActionPorts = {
    executors: [buildRevenueFollowupExecutor(ports.rec)],

    // Always required — a real Odoo CRM write performed autonomously by an
    // AI agent, never conditional on a risk-level table the way staff
    // actions are (contrast resolve-context.ts's ACTIONS_REQUIRING_APPROVAL).
    approvalRequired: () => true,

    approvalVerdict: async (p) => {
      const scope = buildApprovalScope(tenantId, p)
      const verdict = await verdictForRevenueFollowup(scope, ports.now())
      lastApprovalId = verdict.approvalId
      return verdict
    },

    // Redundant-but-harmless: approvalVerdict above always returns an
    // approvalId (minting a pending row itself when none strictly matches),
    // so runGovernedAction's `verdict?.approvalId || recordApprovalRequest(...)`
    // never actually reaches this branch. Implemented anyway because
    // ActionPorts requires it, and it is safe if it ever does run: it mints
    // through the exact same strict-scope path.
    recordApprovalRequest: async (p) => {
      if (lastApprovalId) return lastApprovalId
      const scope = buildApprovalScope(tenantId, p)
      const minted = await mintPendingApproval(scope, ports.now())
      lastApprovalId = minted.auditId
      return minted.auditId
    },

    // Company scoping: read the lead through the CALLER's own resolved
    // tenant Odoo binding (`ports.rec`, already scoped by its constructor —
    // see RevenueMcpPorts's doc comment). If it is not visible there, it is
    // either nonexistent or belongs to a different tenant's Odoo instance;
    // both collapse into ONE refusal (see action.ts's own comment on this).
    // This is a REAL dependency call, not a tautology: a fake RecordSystem
    // scoped to a different tenant's fixture data genuinely returns null.
    objectCompanyId: async (p) => {
      const row = await ports.rec.readLead(p.objectId)
      return row ? p.companyId : null
    },

    findPriorResult: (idempotencyKeyArg) => findPriorRevenueActionResult(tenantId, idempotencyKeyArg),

    writeAudit: async (entry) =>
      writeRevenueAuditRow(tenantId, actorRef, entry, lastApprovalId),
  }

  const result = await runGovernedAction(proposal, actionPorts)
  return { ok: true, result }
}
