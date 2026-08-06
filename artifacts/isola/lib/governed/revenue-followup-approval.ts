/**
 * revenue-followup-approval@1 — a purpose-built, STRICTLY-BOUND approval
 * mechanism for `revenue.followup.set`, per the ratified Port decision
 * `dec-pr41-delivery-and-revenue-mcp-write-approval-2026-08-06`.
 *
 * WHY THIS EXISTS AND IS NOT `checkGate()`
 * -----------------------------------------
 * `lib/approval-gate.ts`'s `checkGate()` keys approval on exactly THREE
 * things: `(tenantId, action, requestId)`. That is sufficient for the
 * call sites it already serves (a single voice-route change per request),
 * but it grants on `requestId` alone — it has no concept of WHICH agent
 * proposed the action, WHICH object it targets, WHICH fields it may touch,
 * WHAT VALUES were actually approved, an expiry, or a revocation. For an
 * autonomous AI agent proposing a real CRM mutation, "the id matched" is not
 * the same fact as "a human approved THIS write" — an agent that resubmits
 * the same idempotencyKey with a different due date must NOT silently ride
 * an old approval to execution.
 *
 * `checkGate()` itself is UNCHANGED by this file and stays exactly as every
 * existing call site (voice routing, etc.) already relies on it.
 *
 * THE EIGHT BOUND DIMENSIONS
 * ----------------------------
 * An approval strictly matches a proposal only when ALL of these are
 * identical between the approval record and the proposal being executed:
 *   1. tenantId              2. clawithAgentId (the proposing agent)
 *   3. tool (action type)    4. objectId (the crm.lead id)
 *   5. allowedFields (exact set of fields the proposal touches, no superset)
 *   6. approvedValueHash (sha256 of the canonical JSON of those field VALUES)
 *   7. correlationId         8. idempotencyKey
 * Any mismatch on any one of them is treated identically to "no approval
 * exists" — there is no partial credit.
 *
 * STORAGE — AuditLog, no migration
 * -----------------------------------
 * Three suffixed actions on the existing AuditLog table, keyed the same way
 * `checkGate()`'s own rows are (`request_id` = idempotencyKey), but with the
 * full scope object (above) plus `expiresAt` in `meta`:
 *   `${tool}.pending_approval` — minted when no matching grant exists yet.
 *   `${tool}.approved`        — written only by `approveRevenueFollowup()`,
 *                               which requires a real, unexpired pending row.
 *   `${tool}.revoked`         — written only by `revokeRevenueFollowupApproval()`,
 *                               and always wins over its target `.approved`
 *                               row, checked at verdict time, however long ago
 *                               the approval itself was granted.
 *
 * EXPIRY
 * ------
 * A PENDING request expires after `DEFAULT_PENDING_TTL_MS` (30 minutes) —
 * a request nobody acted on goes stale rather than lingering forever.
 * An APPROVED grant expires after `DEFAULT_APPROVED_TTL_MS` (24 hours) from
 * the moment it was approved — a human approving a write does not grant the
 * agent an indefinite standing licence to execute it whenever it likes.
 * Both are checked AT VERDICT TIME (`verdictForRevenueFollowup`), not only at
 * mint/approve time — an approval that was valid an hour ago and has since
 * expired reads as unapproved on the next check, no separate cleanup job
 * required.
 */

import type { Prisma } from '@prisma/client'

import { hashArguments } from '@/lib/operations/ledger'
import { prisma } from '@/lib/prisma'

export const DEFAULT_PENDING_TTL_MS = 30 * 60 * 1000
export const DEFAULT_APPROVED_TTL_MS = 24 * 60 * 60 * 1000

export const pendingAction = (tool: string) => `${tool}.pending_approval`
export const approvedAction = (tool: string) => `${tool}.approved`
export const revokedAction = (tool: string) => `${tool}.revoked`

export interface RevenueApprovalScope {
  tenantId: string
  /** The Clawith agent identity that PROPOSED the action — never omitted or hardcoded. */
  clawithAgentId: string
  tool: string
  objectId: string
  /** Exact, sorted set of fields the proposal touches. A superset never matches. */
  allowedFields: readonly string[]
  /** sha256 of the canonical JSON of the field VALUES actually proposed. */
  approvedValueHash: string
  correlationId: string
  idempotencyKey: string
}

/** Scope, derived deterministically from a proposal's own fields — never from a caller-supplied token. */
export function computeApprovalScope(input: {
  tenantId: string
  clawithAgentId: string
  tool: string
  objectId: string
  /** The picked (ownerRef/nextAction/dueDate-only) subset — see revenue-mcp-actions.ts's `pickedRevenueFields`. */
  fields: Record<string, string>
  correlationId: string
  idempotencyKey: string
}): RevenueApprovalScope {
  const allowedFields = Object.keys(input.fields)
    .filter((k) => input.fields[k] !== undefined && input.fields[k] !== '')
    .sort()
  const picked: Record<string, string> = {}
  for (const k of allowedFields) picked[k] = input.fields[k]
  return {
    tenantId: input.tenantId,
    clawithAgentId: input.clawithAgentId,
    tool: input.tool,
    objectId: input.objectId,
    allowedFields,
    approvedValueHash: hashArguments(picked),
    correlationId: input.correlationId,
    idempotencyKey: input.idempotencyKey,
  }
}

interface StoredScopeMeta {
  tenantId?: string
  clawithAgentId?: string
  tool?: string
  objectId?: string
  allowedFields?: unknown
  approvedValueHash?: string
  correlationId?: string
  idempotencyKey?: string
  expiresAt?: string
}

/** ALL eight dimensions must match. No partial credit — see the file header. */
export function scopeMatches(stored: StoredScopeMeta | null | undefined, scope: RevenueApprovalScope): boolean {
  if (!stored) return false
  if (stored.tenantId !== scope.tenantId) return false
  if (stored.clawithAgentId !== scope.clawithAgentId) return false
  if (stored.tool !== scope.tool) return false
  if (stored.objectId !== scope.objectId) return false
  if (stored.correlationId !== scope.correlationId) return false
  if (stored.idempotencyKey !== scope.idempotencyKey) return false
  if (stored.approvedValueHash !== scope.approvedValueHash) return false
  const storedFields = Array.isArray(stored.allowedFields) ? [...stored.allowedFields].map(String).sort() : []
  const scopeFields = [...scope.allowedFields].sort()
  if (storedFields.length !== scopeFields.length) return false
  return storedFields.every((f, i) => f === scopeFields[i])
}

function notExpired(meta: StoredScopeMeta | null | undefined, now: Date): boolean {
  const expiresAt = meta?.expiresAt ? new Date(meta.expiresAt).getTime() : 0
  return Number.isFinite(expiresAt) && expiresAt > now.getTime()
}

function metaOf(row: { meta: unknown } | null | undefined): StoredScopeMeta | null {
  if (!row || row.meta === null || typeof row.meta !== 'object') return null
  return row.meta as StoredScopeMeta
}

// ── mint (pending) ───────────────────────────────────────────────────────────

/**
 * Idempotent: a repeat call with the SAME scope and a still-live pending row
 * reuses it. A repeat call whose scope has changed (a new delta) or whose
 * prior pending row has expired mints a FRESH row rather than reusing a
 * stale or mismatched one — an agent that resubmits different values must
 * get a new, distinct pending request, not the old one silently relabelled.
 */
export async function mintPendingApproval(
  scope: RevenueApprovalScope,
  now: Date,
  ttlMs: number = DEFAULT_PENDING_TTL_MS,
): Promise<{ auditId: string }> {
  const existing = await prisma.auditLog.findFirst({
    where: {
      tenant_id: scope.tenantId,
      action: pendingAction(scope.tool),
      request_id: scope.idempotencyKey,
    },
    orderBy: { created_at: 'desc' },
  })
  if (existing) {
    const meta = metaOf(existing)
    if (scopeMatches(meta, scope) && notExpired(meta, now)) {
      return { auditId: existing.id }
    }
  }

  const meta: RevenueApprovalScope & { expiresAt: string } = {
    ...scope,
    expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
  }
  const row = await prisma.auditLog.create({
    data: {
      tenant_id: scope.tenantId,
      actor_id: `clawith_agent:${scope.clawithAgentId}`,
      action: pendingAction(scope.tool),
      entity: 'crm_lead',
      entity_id: scope.objectId,
      request_id: scope.idempotencyKey,
      meta: JSON.parse(JSON.stringify(meta)) as Prisma.InputJsonValue,
    },
  })
  return { auditId: row.id }
}

// ── verdict ──────────────────────────────────────────────────────────────────

export type RevenueApprovalVerdict =
  | { state: 'granted'; approvalId: string }
  | { state: 'pending'; approvalId: string }
  | { state: 'rejected'; approvalId: string; reason: string }

/**
 * The strict lookup. Never trusts anything from the proposal except what
 * `computeApprovalScope` derived from its OWN fields — there is no
 * "approvalId" or "token" read from a proposal anywhere in this module, so a
 * proposal cannot claim an approval into existence; it can only match one
 * that a real `.approved` AuditLog row, itself, actually is.
 */
export async function verdictForRevenueFollowup(
  scope: RevenueApprovalScope,
  now: Date,
): Promise<RevenueApprovalVerdict> {
  const approved = await prisma.auditLog.findFirst({
    where: {
      tenant_id: scope.tenantId,
      action: approvedAction(scope.tool),
      request_id: scope.idempotencyKey,
    },
    orderBy: { created_at: 'desc' },
  })

  if (approved) {
    const meta = metaOf(approved)
    if (scopeMatches(meta, scope) && notExpired(meta, now)) {
      // Revocation wins even over an otherwise-valid, unexpired, strictly
      // matching approval — checked EVERY time, not cached.
      const revoked = await prisma.auditLog.findFirst({
        where: {
          tenant_id: scope.tenantId,
          action: revokedAction(scope.tool),
          request_id: scope.idempotencyKey,
        },
        orderBy: { created_at: 'desc' },
      })
      const revokedMeta = metaOf(revoked) as { revokedApprovedAuditId?: string; reason?: string } | null
      if (revoked && revokedMeta?.revokedApprovedAuditId === approved.id) {
        return {
          state: 'rejected',
          approvalId: revoked.id,
          reason: revokedMeta?.reason || 'approval revoked',
        }
      }
      return { state: 'granted', approvalId: approved.id }
    }
    // Found, but it does not strictly match this exact proposal, or it has
    // expired. Neither is "approved" — fall through to a fresh pending mint.
  }

  const minted = await mintPendingApproval(scope, now)
  return { state: 'pending', approvalId: minted.auditId }
}

// ── admin surface — approve / revoke ────────────────────────────────────────

export type ApproveRevenueFollowupResult =
  | { ok: true; auditId: string }
  | { ok: false; code: 'not_found' | 'expired'; detail: string }

/**
 * Approves a SPECIFIC pending request by its AuditLog id — never by
 * recomputing a scope from caller-supplied fields, which would let an
 * approver "approve" something that was never actually requested. The
 * approved row is a straight copy of the pending row's scope, so the
 * verdict's strict match is against exactly what was requested.
 */
export async function approveRevenueFollowup(input: {
  pendingApprovalId: string
  approverActorId: string
  now: Date
  ttlMs?: number
}): Promise<ApproveRevenueFollowupResult> {
  const pending = await prisma.auditLog.findUnique({ where: { id: input.pendingApprovalId } })
  if (!pending || !pending.action.endsWith('.pending_approval') || !pending.tenant_id || !pending.request_id) {
    return { ok: false, code: 'not_found', detail: 'no matching pending approval request' }
  }
  const meta = metaOf(pending)
  if (!notExpired(meta, input.now)) {
    return { ok: false, code: 'expired', detail: 'the pending approval request has expired; ask the agent to resubmit' }
  }

  const tool = pending.action.replace(/\.pending_approval$/, '')
  const ttlMs = input.ttlMs ?? DEFAULT_APPROVED_TTL_MS
  const approvedMeta = {
    ...(meta as Record<string, unknown>),
    expiresAt: new Date(input.now.getTime() + ttlMs).toISOString(),
    approvedFromPendingId: pending.id,
    approverActorId: input.approverActorId,
  }
  const row = await prisma.auditLog.create({
    data: {
      tenant_id: pending.tenant_id,
      actor_id: input.approverActorId,
      action: approvedAction(tool),
      entity: pending.entity ?? undefined,
      entity_id: pending.entity_id ?? undefined,
      request_id: pending.request_id,
      meta: JSON.parse(JSON.stringify(approvedMeta)) as Prisma.InputJsonValue,
    },
  })
  return { ok: true, auditId: row.id }
}

export type RevokeRevenueFollowupResult = { ok: true; auditId: string } | { ok: false; detail: string }

/** Revokes a SPECIFIC approved record by its AuditLog id. */
export async function revokeRevenueFollowupApproval(input: {
  approvedAuditId: string
  revokedByActorId: string
  reason?: string
  now: Date
}): Promise<RevokeRevenueFollowupResult> {
  const approved = await prisma.auditLog.findUnique({ where: { id: input.approvedAuditId } })
  if (!approved || !approved.action.endsWith('.approved') || !approved.tenant_id || !approved.request_id) {
    return { ok: false, detail: 'no matching approved record' }
  }
  const tool = approved.action.replace(/\.approved$/, '')
  const row = await prisma.auditLog.create({
    data: {
      tenant_id: approved.tenant_id,
      actor_id: input.revokedByActorId,
      action: revokedAction(tool),
      entity: approved.entity ?? undefined,
      entity_id: approved.entity_id ?? undefined,
      request_id: approved.request_id,
      meta: {
        revokedApprovedAuditId: approved.id,
        revokedByActorId: input.revokedByActorId,
        reason: input.reason ?? null,
      },
    },
  })
  return { ok: true, auditId: row.id }
}
