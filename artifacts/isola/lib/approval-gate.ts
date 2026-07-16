/**
 * Explicit-human-approval gate for the three action categories the spine
 * baseline calls out as requiring a human in the loop: money movement,
 * production route/config changes, and destructive ops.
 *
 * Built entirely on the existing AuditLog (actor_id/action/request_id —
 * same idempotency convention as /api/admin/tenants/[id]/credits and
 * /api/agent-tools/invoke): a gated call writes a `${action}.pending_approval`
 * row keyed on `requestId` and blocks; a separate approver call
 * (POST /api/admin/approvals, see that route) writes `${action}.approved`
 * keyed on the same `requestId`; the next checkGate() call with that
 * `requestId` then allows.
 *
 * Flag-gated by PERMISSION_GATES_ENABLED, default OFF — matches the
 * existing kill-switch convention in this codebase (FISERV_CHARGE_ENABLED,
 * VOICEMAIL_POLL_ENABLED, FLOWISE_AGENT_TOOLS_ENABLED). Every call site
 * that adopts checkGate() keeps its current behavior until a lane
 * explicitly flips the flag on — no behavior change for existing allowed
 * paths.
 */

import { prisma } from './prisma';

export type GateCategory = 'money_movement' | 'prod_route_change' | 'destructive_op';

export function gatesEnabled(): boolean {
  return process.env.PERMISSION_GATES_ENABLED === 'true';
}

export interface GateCheckParams {
  tenantId: string;
  actorId: string;
  /** Base action name, e.g. "admin.credits.adjust" — suffixed internally with ".pending_approval" / ".approved". */
  action: string;
  category: GateCategory;
  entity?: string;
  entityId?: string;
  /** Idempotency + approval-matching key — same request_id the caller already uses for its own idempotency check. */
  requestId: string;
  meta?: Record<string, unknown>;
}

export interface GateResult {
  allowed: boolean;
  reason?: 'gate_disabled' | 'approved' | 'awaiting_approval';
  auditId?: string;
}

/**
 * Call before executing a gated action, after the caller's own idempotency
 * check (so a retry with the same requestId never double-records a pending
 * row). If gates are disabled: always allows. If enabled: allows once a
 * matching `${action}.approved` row exists; otherwise records
 * `${action}.pending_approval` (once — repeat calls with the same
 * requestId reuse the existing pending row) and blocks.
 */
export async function checkGate(params: GateCheckParams): Promise<GateResult> {
  if (!gatesEnabled()) return { allowed: true, reason: 'gate_disabled' };

  const approved = await prisma.auditLog.findFirst({
    where: {
      tenant_id: params.tenantId,
      action: `${params.action}.approved`,
      request_id: params.requestId,
    },
    orderBy: { created_at: 'desc' },
  });
  if (approved) return { allowed: true, reason: 'approved', auditId: approved.id };

  const pending = await prisma.auditLog.findFirst({
    where: {
      tenant_id: params.tenantId,
      action: `${params.action}.pending_approval`,
      request_id: params.requestId,
    },
    orderBy: { created_at: 'desc' },
  });
  if (pending) return { allowed: false, reason: 'awaiting_approval', auditId: pending.id };

  const row = await prisma.auditLog.create({
    data: {
      tenant_id: params.tenantId,
      actor_id: params.actorId,
      action: `${params.action}.pending_approval`,
      entity: params.entity,
      entity_id: params.entityId,
      request_id: params.requestId,
      meta: { category: params.category, ...(params.meta ?? {}) },
    },
  });
  return { allowed: false, reason: 'awaiting_approval', auditId: row.id };
}
