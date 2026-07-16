/**
 * lib/workspace-item-detail.ts — per-item detail fetch + authorization for
 * the Workspace queue's [type]/[id] drill-in page. Conversation items route
 * straight to the existing /inbox/[id] page (already has its own tenant
 * scope check) and never reach this module.
 *
 * Every lookup here re-derives its own authorization from the underlying
 * row rather than trusting the list page's scope — a staff user can always
 * type an arbitrary id into the URL, so the same scoping rules from
 * lib/workspace-queue.ts are re-applied per item. Returns null for
 * "not found OR not authorized" — the caller renders notFound() either
 * way, so this never leaks whether an id exists outside the viewer's scope.
 */

import { prisma } from './prisma';
import { callEngine } from './connector';
import { getMembershipRole, type Role } from './permissions';
import type { SessionCtx } from './session';
import { relativeTime } from './workspace-queue';

export type WorkQueueItemDetailType = 'odoo_task' | 'voicemail' | 'approval';

export interface WorkQueueItemDetail {
  type: WorkQueueItemDetailType;
  id: string;
  title: string;
  fields: { label: string; value: string }[];
  /** Fed into the assist endpoint's system prompt — see app/api/workspace/assist/route.ts. */
  assistContext: string;
  /** Only set for 'approval' — the underlying checkGate() action name and request_id, needed to approve. */
  approval?: { action: string; requestId: string };
}

async function resolveViewerRank(session: SessionCtx): Promise<Role> {
  if (session.isAdmin || session.isOwner) return 'owner';
  const role = await getMembershipRole(session.identityId, session.effectiveTenantId);
  return role ?? 'staff';
}

async function getOdooTaskDetail(session: SessionCtx, id: string): Promise<WorkQueueItemDetail | null> {
  const email = session.user.email;
  const taskId = Number(id);
  if (!email || !Number.isFinite(taskId)) return null;

  // Re-derive from Odoo directly, always filtered to the viewer's own
  // assignee email — see module header on why this can't widen by role.
  const tasks = await callEngine('odoo', 'findOpenTasksByAssignee', [email, 200], {
    tenant: { tenantId: session.effectiveTenantId },
    actorId: session.user.id,
    entity: 'project.task',
  }).catch(() => []);
  const task = tasks.find((t) => t.id === taskId);
  if (!task) return null;

  return {
    type: 'odoo_task',
    id,
    title: task.name,
    fields: [
      { label: 'Project', value: task.projectName ?? '—' },
      { label: 'Stage', value: task.stageName ?? '—' },
      { label: 'Priority', value: task.priority ?? '—' },
      { label: 'Deadline', value: task.dateDeadline ?? 'No deadline' },
    ],
    assistContext: `Odoo task "${task.name}" (project: ${task.projectName ?? 'none'}, stage: ${task.stageName ?? 'none'}, deadline: ${task.dateDeadline ?? 'none'}).`,
  };
}

async function getVoicemailDetail(session: SessionCtx, id: string): Promise<WorkQueueItemDetail | null> {
  const row = await prisma.tenantVoicemailCatch.findFirst({
    where: { id, tenant_id: session.effectiveTenantId },
  });
  if (!row) return null;

  return {
    type: 'voicemail',
    id,
    title: `Missed call from ${row.callerId}`,
    fields: [
      { label: 'Called', value: row.calledExten },
      { label: 'Duration', value: `${row.durationSec}s` },
      { label: 'Urgency', value: row.urgency },
      { label: 'Callback number', value: row.callbackNumber ?? row.callerId },
      { label: 'Received', value: relativeTime(row.created_at) },
      { label: 'Transcript', value: row.transcript },
    ],
    assistContext: `Voicemail from ${row.callerId}, urgency ${row.urgency}. Summary: ${row.summary}. Transcript: ${row.transcript}`,
  };
}

async function getApprovalDetail(session: SessionCtx, id: string): Promise<WorkQueueItemDetail | null> {
  const rank = await resolveViewerRank(session);
  const row = await prisma.auditLog.findFirst({
    where: {
      id,
      tenant_id: session.effectiveTenantId,
      action: { endsWith: '.pending_approval' },
      ...(rank === 'staff' ? { actor_id: session.user.id } : {}),
    },
  });
  if (!row || !row.request_id) return null;

  const baseAction = row.action.replace(/\.pending_approval$/, '');
  const meta = (row.meta ?? {}) as Record<string, unknown>;
  const category = typeof meta.category === 'string' ? meta.category : '—';

  return {
    type: 'approval',
    id,
    title: `Approval needed: ${baseAction}`,
    fields: [
      { label: 'Category', value: category },
      { label: 'Entity', value: row.entity ? `${row.entity}${row.entity_id ? ` #${row.entity_id}` : ''}` : '—' },
      { label: 'Requested by', value: row.actor_id },
      { label: 'Requested', value: relativeTime(row.created_at) },
      { label: 'Request ID', value: row.request_id },
    ],
    assistContext: `Pending approval for action "${baseAction}" (category: ${category}), requested by ${row.actor_id}.`,
    approval: { action: baseAction, requestId: row.request_id },
  };
}

export async function getWorkQueueItemDetail(
  session: SessionCtx,
  type: string,
  id: string,
): Promise<WorkQueueItemDetail | null> {
  switch (type as WorkQueueItemDetailType) {
    case 'odoo_task':
      return getOdooTaskDetail(session, id);
    case 'voicemail':
      return getVoicemailDetail(session, id);
    case 'approval':
      return getApprovalDetail(session, id);
    default:
      return null;
  }
}
