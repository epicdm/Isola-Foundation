/**
 * revenue-mcp-actions@2 — the runtime binding for `revenue.followup.set`, the
 * write half of Lane 1's two-tool MCP milestone. Exposed to Clawith ("Atlas")
 * as `isola_revenue_followup_set` (see lib/revenue-mcp/handlers.ts).
 *
 * REVISION NOTE (2026-08-06, third pass — Port decision
 * `dec-pr80-odoo-scope-idempotency-and-read-contract-2026-08-06`)
 * -----------------------------------------------------------------
 * An independent exact-head review of the second pass found six real
 * defects, all fixed here:
 *
 *   1. NO GLOBAL ODOO FALLBACK, PROVEN COMPANY SCOPE. The second pass trusted
 *      whatever `RecordSystem` the caller happened to construct and treated
 *      "readLead returned a row" as proof of ownership. That is exactly the
 *      "helper that returns yes whenever a record exists" the review
 *      forbids. Company scope is now proven by `revenue-odoo-scope.ts`: an
 *      explicit `OdooBinding` row is REQUIRED (no fallback to the platform
 *      default `getOdooConfig()`), and the target `crm.lead`'s OWN
 *      `company_id` is read directly from Odoo and compared against the
 *      binding's bound company (itself read from `res.users`, never
 *      assumed). The SAME resolved `OdooConfig` then builds the
 *      `RecordSystem` used for execute AND readback — see `lazyRecordSystem`.
 *   2. APPROVAL ROWS ARE ACTION-TYPED. Already true structurally
 *      (`verdictForRevenueFollowup`'s query is scoped to
 *      `${tool}.approved`/`.pending_approval` and `scopeMatches` checks
 *      `stored.tool`) — `revenue-followup-approval.ts` now also accepts
 *      `expected*` guards on `approveRevenueFollowup`/
 *      `revokeRevenueFollowupApproval` so the admin route can defend against
 *      an id belonging to an unrelated action, tenant, or opportunity.
 *   3. CHANGED REQUEST UNDER THE SAME IDEMPOTENCY KEY IS REFUSED. The
 *      canonical request fingerprint — tenant, agent, actor type, tool
 *      version, opportunity, permitted fields/values, correlation id — is
 *      now the ledger's `authorizedArguments`. `claimOperation`'s own
 *      `judge()` refuses a same-key-different-fingerprint request as
 *      `argument_conflict` BEFORE anything is proposed, executed, or
 *      claimed as a replay.
 *   4. REAL ATOMIC EXACTLY-ONCE. The prior AuditLog-`findFirst` idempotency
 *      mechanism was a sequential read-then-write and was NOT atomic under a
 *      real race. Idempotency is now `lib/operations/ledger.ts`'s
 *      `claimOperation`/`completeOperation`/`failOperation` — the SAME
 *      atomic, unique-index-backed mechanism `customer-actions.ts` and
 *      `lib/customer-tools/operation.ts` already rely on, under a NEW,
 *      deliberately vendor-neutral caller class, `'ai_agent'` (added to
 *      `CALLER_CLASSES`, purely additive — `lib/operations/ledger.ts` has
 *      its own "the ledger is neutral" test forbidding product/vendor names
 *      even as string literals, which is why this is `'ai_agent'` and not
 *      the Clawith-specific name used everywhere else in THIS file).
 *   5. ACTOR TYPE FAILS CLOSED. `SUPPORTED_ACTOR_TYPES` is an explicit
 *      allowlist; a missing, empty or unrecognised `caller.actorType` is
 *      refused before anything else runs — never defaulted to "assume it's
 *      an allowed caller."
 *   6. Admin approve/revoke route hardened and tested — see
 *      app/api/admin/approvals/revenue-followup/route.ts and its test file.
 *
 * WHY THIS IS NOT `customer-actions.ts` WITH A DIFFERENT NAME
 * ------------------------------------------------------------
 * `runCustomerAction` (customer-actions.ts) is deliberately kept as the
 * FOUNDATION-STAFF binding: `CALLER_CLASS = 'foundation_staff'`, and approval
 * permanently unwired (holds forever — see that file's header). This file
 * uses `CALLER_CLASS = 'ai_agent'` (the ledger's caller-class dimension —
 * see the note above on why it isn't the Clawith-specific name),
 * `ACTION_OBJECT_TYPE = 'crm_lead'` (not the overloaded `'customer'` object
 * type), and a REAL, STRICTLY BOUND
 * approval mechanism (`revenue-followup-approval.ts`, not `checkGate()` —
 * see that file's header for why).
 *
 * ONE ACTION, TWO ODOO EFFECTS, ONE externalId
 * ---------------------------------------------
 * `revenue.followup.set` can move an owner (`rec.updateLead`) AND schedule a
 * follow-up activity (`rec.scheduleFollowup`) in the SAME governed pass. But
 * `ActionExecutor.execute()` can only return ONE `{ externalId }`.
 * DECISION (unchanged from the second pass): externalId = the crm.lead id.
 * The follow-up activity's own id is threaded through a closure-local
 * variable (`lastFollowupExternalId`, reset at the top of every `execute()`
 * call) rather than extending `RecordSystem`'s public interface.
 * `readback()` re-reads BOTH effects for real via the SAME lazily-resolved
 * `RecordSystem` — never trusting the create response alone.
 */

import { prisma } from '@/lib/prisma'
import {
  claimOperation,
  completeOperation,
  failOperation,
  type LedgerStore,
  type OperationEnvelope,
  type OperationIdentity,
} from '@/lib/operations/ledger'

import {
  DependencyUnavailable,
  GOVERNED_ACTION_VERSION,
  runGovernedAction,
  type ActionExecutor,
  type ActionPorts,
  type ActionProposal,
  type ActionResult,
} from './action'
import type { RecordSystem } from './executors'
import {
  computeApprovalScope,
  mintPendingApproval,
  verdictForRevenueFollowup,
  type RevenueApprovalScope,
} from './revenue-followup-approval'
import { DEFAULT_ODOO_SCOPE_PORTS, type OdooScope, type OdooScopePorts } from './revenue-odoo-scope'
import type { OdooConfig } from '@/engines/odoo'

export const REVENUE_MCP_ACTIONS_VERSION = 'revenue-mcp-actions@2' as const

/**
 * The AI-agent ledger caller class. Never conflated with Foundation staff.
 * Deliberately `'ai_agent'`, not the Clawith-specific name used elsewhere in
 * this file — this value is written into `lib/operations/ledger.ts`'s
 * `OperationIdentity.callerClass`, and that shared, vendor-neutral module has
 * its own test forbidding product/vendor names, even as string literals.
 */
export const CALLER_CLASS = 'ai_agent' as const

/** Not `'customer'` — customer-actions.ts's object type is deliberately not reused. */
export const ACTION_OBJECT_TYPE = 'crm_lead' as const

export const REVENUE_FOLLOWUP_SET_ACTION = 'revenue.followup.set' as const

/** Participates in the request fingerprint — a future field/behavior change bumps this, not silently reuses old approvals. */
export const REVENUE_FOLLOWUP_SET_TOOL_VERSION = 'revenue.followup.set@1' as const

/**
 * Actor types this write path accepts. FAILS CLOSED: a missing, empty or
 * unrecognised value is refused — never defaulted to "assume it's allowed."
 * Exactly one member today; the type exists so a future actor class (e.g. a
 * Foundation service account) is an explicit addition, not a silent widening.
 */
export const SUPPORTED_ACTOR_TYPES = ['clawith_agent'] as const
export type SupportedActorType = (typeof SUPPORTED_ACTOR_TYPES)[number]

export function isSupportedActorType(v: unknown): v is SupportedActorType {
  return typeof v === 'string' && (SUPPORTED_ACTOR_TYPES as readonly string[]).includes(v)
}

/** The ONLY three keys this action ever reads from a payload. See file header. */
const REVENUE_FOLLOWUP_FIELDS = ['ownerRef', 'nextAction', 'dueDate'] as const

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

/**
 * The single source of truth for the write-surface allowlist. Used by
 * `validate`/`execute`/`readback` AND by the approval scope computation AND
 * the request fingerprint, so "what fields can this action touch", "what
 * fields is an approval bound to" and "what fields identify this request"
 * can never drift from each other.
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

/**
 * A `RecordSystem` that resolves its real backing config LAZILY, from
 * `getScope()`, and caches it — so execute() and readback() are GUARANTEED to
 * use the exact same `OdooConfig` that `objectCompanyId`'s company-scope
 * check already proved was correct, never a second, independently-resolved
 * config. If `getScope()` ever returns `null` here (should be unreachable —
 * `objectCompanyId` runs first and would already have refused), the write is
 * refused as `DependencyUnavailable` rather than silently proceeding on an
 * unproven binding.
 */
function lazyRecordSystem(
  getScope: () => Promise<OdooScope | null>,
  buildRecordSystem: (config: OdooConfig) => RecordSystem,
): RecordSystem {
  let cached: RecordSystem | null = null
  async function resolved(): Promise<RecordSystem> {
    if (cached) return cached
    const scope = await getScope()
    if (!scope) {
      throw new DependencyUnavailable(
        'odoo-binding',
        'no explicit, provable tenant Odoo company scope; refusing to write',
      )
    }
    cached = buildRecordSystem(scope.config)
    return cached
  }
  return {
    createNote: async (i) => (await resolved()).createNote(i),
    readNote: async (id) => (await resolved()).readNote(id),
    createTask: async (i) => (await resolved()).createTask(i),
    readTask: async (id) => (await resolved()).readTask(id),
    scheduleActivity: async (i) => (await resolved()).scheduleActivity(i),
    readActivity: async (id) => (await resolved()).readActivity(id),
    createLead: async (i) => (await resolved()).createLead(i),
    readLead: async (id) => (await resolved()).readLead(id),
    updateLead: async (i) => (await resolved()).updateLead(i),
    scheduleFollowup: async (i) => (await resolved()).scheduleFollowup(i),
    readFollowup: async (id) => (await resolved()).readFollowup(id),
  }
}

// ── caller identity resolution — never trust a bare tenant id ──────────────

export interface RevenueMcpPorts {
  /** Resolves the CALLER's identity to a Foundation tenant. Never the reverse. */
  resolveTenantForAgent(agentRef: string): Promise<string | null>
  /** Explicit-binding, proven-company-scope resolution. See revenue-odoo-scope.ts. */
  odooScope: OdooScopePorts
  /** Builds a RecordSystem from a resolved OdooConfig — e.g. `createOdooRecordSystem`. */
  buildRecordSystem(config: OdooConfig): RecordSystem
  /** The SAME atomic ledger customer-actions.ts and lib/customer-tools/operation.ts use. */
  ledger: LedgerStore
  now(): Date
}

async function defaultResolveTenantForAgent(agentRef: string): Promise<string | null> {
  const agent = await prisma.agent.findUnique({ where: { id: agentRef } })
  return agent?.is_active ? agent.tenant_id : null
}

/**
 * Derives the approval scope from the RESOLVED tenant and the proposal's OWN
 * fields — never from anything a caller could pass as an "approval token".
 * `p.actorPrincipalId` is the Clawith agent reference — the SAME value the
 * caller supplied as `caller.agentRef`, already resolved to `tenantId` above.
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
  caller: { agentRef: string; actorType: string }
  /** The Odoo crm.lead id this follow-up targets. */
  leadId: string
  payload: { ownerRef?: string; nextAction?: string; dueDate?: string }
  idempotencyKey: string
  correlationId: string
}

export type RevenueFollowupSetDenyCode = 'unauthenticated' | 'in_progress' | 'conflict' | 'unavailable'

export type RevenueFollowupSetResult =
  | { ok: true; result: ActionResult }
  | { ok: false; code: RevenueFollowupSetDenyCode; detail: string }

function actionResultShaped(
  outcome: ActionResult['outcome'],
  idempotencyKey: string,
  correlationId: string,
  auditId: string,
  detail: string,
  readback: Record<string, unknown> | null = null,
): ActionResult {
  return {
    version: GOVERNED_ACTION_VERSION,
    outcome,
    actionType: REVENUE_FOLLOWUP_SET_ACTION,
    idempotencyKey,
    correlationId,
    riskLevel: 'high',
    readback,
    auditId,
    detail,
  }
}

export async function runRevenueFollowupSet(
  req: RevenueFollowupSetRequest,
  ports: Omit<RevenueMcpPorts, 'resolveTenantForAgent'> &
    Partial<Pick<RevenueMcpPorts, 'resolveTenantForAgent'>>,
): Promise<RevenueFollowupSetResult> {
  // ── Actor type fails closed — BEFORE any identity resolution. ─────────────
  const actorType = req.caller?.actorType
  if (!isSupportedActorType(actorType)) {
    return { ok: false, code: 'unauthenticated', detail: 'unknown or unsupported actor type' }
  }

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
  const pickedFields = pickedRevenueFields(req.payload ?? {})

  // ── The request fingerprint — correction 3. Every dimension the review
  // named participates: tenant, agent, actor type, tool+version, opportunity,
  // permitted fields/values, correlation id. `claimOperation`'s own `judge()`
  // refuses a same-idempotency-key request whose fingerprint HASH differs —
  // see lib/operations/ledger.ts's `argument_conflict` branch.
  const fingerprint = {
    tenantId,
    agentRef,
    actorType,
    tool: REVENUE_FOLLOWUP_SET_TOOL_VERSION,
    leadId,
    fields: pickedFields,
    correlationId,
  }

  const identity: OperationIdentity = {
    callerClass: CALLER_CLASS,
    tenantId,
    companyId: tenantId,
    actionType: REVENUE_FOLLOWUP_SET_ACTION,
    objectType: ACTION_OBJECT_TYPE,
    // objectId participates in the operation id — a different leadId under
    // the SAME idempotencyKey is a DIFFERENT operation, never a replay of
    // this one. See correction 3's "changed opportunity" requirement.
    objectId: leadId,
    idempotencyKey,
  }

  let claim
  try {
    claim = await claimOperation(
      {
        identity,
        authorizedArguments: fingerprint,
        correlationId,
        actorRef: agentRef,
        contextRef: null,
        auditRef: null,
        retryFailed: true,
      },
      ports.ledger,
    )
  } catch {
    return { ok: false, code: 'unavailable', detail: 'the operation ledger could not be reached' }
  }

  switch (claim.status) {
    case 'already_completed': {
      const readback = claim.record.envelope?.readback ?? null
      return {
        ok: true,
        result: actionResultShaped(
          'IDEMPOTENT_REPLAY',
          idempotencyKey,
          correlationId,
          claim.operationId,
          'replayed prior result',
          readback,
        ),
      }
    }
    case 'in_flight':
      return { ok: false, code: 'in_progress', detail: 'another attempt at this exact operation is already running' }
    case 'argument_conflict':
      return { ok: false, code: 'conflict', detail: claim.detail }
    case 'previously_failed':
      // Unreachable in practice: retryFailed is always true above. Handled
      // explicitly rather than falling through silently.
      return { ok: false, code: 'conflict', detail: 'operation previously failed and retry was not permitted' }
    case 'claimed':
    case 'retry_after_failure':
      break // proceed to run the governed lifecycle below
  }

  const recordId = claim.recordId

  const envelope: OperationEnvelope = {
    version: 'operations.ledger@1',
    callerClass: CALLER_CLASS,
    companyId: tenantId,
    actionType: REVENUE_FOLLOWUP_SET_ACTION,
    objectType: ACTION_OBJECT_TYPE,
    objectId: leadId,
    actorRef: agentRef,
    auditRef: claim.operationId,
    readback: null,
    result: null,
  }

  const proposal: ActionProposal = {
    actionType: REVENUE_FOLLOWUP_SET_ACTION,
    actorPrincipalId: agentRef,
    actorRole: CALLER_CLASS,
    companyId: tenantId,
    objectType: ACTION_OBJECT_TYPE,
    objectId: leadId,
    payload: pickedFields,
    idempotencyKey,
    correlationId,
  }

  // ── Company scope — correction 1. Resolved ONCE, cached, and the SAME
  // resolved config backs both this check and the RecordSystem below.
  let cachedScope: OdooScope | null | undefined
  const boundTenantId: string = tenantId
  const getScope = async (): Promise<OdooScope | null> => {
    if (cachedScope === undefined) cachedScope = await ports.odooScope.resolveOdooScope(boundTenantId)
    return cachedScope
  }

  const rec = lazyRecordSystem(getScope, ports.buildRecordSystem)

  const actionPorts: ActionPorts = {
    executors: [buildRevenueFollowupExecutor(rec)],

    // Always required — a real Odoo CRM write performed autonomously by an
    // AI agent, never conditional on a risk-level table the way staff
    // actions are (contrast resolve-context.ts's ACTIONS_REQUIRING_APPROVAL).
    approvalRequired: () => true,

    approvalVerdict: async (p) => {
      const scope = buildApprovalScope(tenantId, p)
      return verdictForRevenueFollowup(scope, ports.now())
    },

    // Redundant-but-harmless fallback — see revenue-mcp-actions.test.ts.
    recordApprovalRequest: async (p) => {
      const scope = buildApprovalScope(tenantId, p)
      const minted = await mintPendingApproval(scope, ports.now())
      return minted.auditId
    },

    // Company scoping — correction 1, THE authoritative check. Reads the
    // lead's OWN company_id directly from Odoo (never assumed from "a record
    // with this id exists") and compares it to the tenant's bound company
    // (itself read from res.users for the binding's own login — never
    // assumed either). No explicit binding, no provable bound company, lead
    // not found, or a company mismatch: all collapse into ONE refusal (see
    // action.ts's own comment on why "not found" and "belongs to someone
    // else" must not be distinguishable to the caller).
    objectCompanyId: async (p) => {
      const scope = await getScope()
      if (!scope) return null
      const leadCompanyId = await ports.odooScope.readLeadCompanyId(scope.config, p.objectId)
      if (leadCompanyId === null) return null
      return leadCompanyId === scope.boundCompanyId ? p.companyId : null
    },

    // The LEDGER already decided replay above, before this proposal was ever
    // built — see customer-actions.ts's identical convention and rationale.
    findPriorResult: async () => null,

    writeAudit: async (entry) => {
      if (entry.outcome === 'EXECUTED') {
        await completeOperation(
          recordId,
          { envelope, readback: entry.readback, result: null, auditRef: claim.operationId },
          ports.ledger,
        )
      } else {
        await failOperation(recordId, { failureClass: entry.outcome, detail: entry.detail }, ports.ledger)
      }
      return claim.operationId
    },
  }

  const result = await runGovernedAction(proposal, actionPorts)
  return { ok: true, result }
}
