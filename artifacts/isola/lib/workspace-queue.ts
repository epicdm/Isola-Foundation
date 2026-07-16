/**
 * lib/workspace-queue.ts — aggregates the signed-in person's WORK-QUEUE
 * across live connectors for the (owner) shell's Workspace home page:
 * Odoo tasks assigned to them, open tenant conversations (Chatwoot mirror),
 * undelivered voicemail catches, and pending approval-gate requests.
 *
 * ROLE SCOPING (Membership.role — see lib/permissions.ts):
 *   - owner/admin rank (global User.role owner/admin, or a tenant
 *     Membership.role of 'owner'/'admin'): full tenant scope for
 *     conversations, voicemail catches, and pending approvals. "Manager's
 *     team" has no sub-team model in the current schema (Membership only
 *     tracks identity + tenant + role, no team_id/manager_id), so admin and
 *     owner both see the whole tenant queue — every staff member reports
 *     into the same tenant-wide pool.
 *   - staff rank: pending approvals scoped to their own requests
 *     (AuditLog.actor_id === session.user.id). Conversations and voicemail
 *     catches have no per-agent assignee field yet, so staff shares the
 *     same tenant-wide queue for those two sources as everyone else — a
 *     known v1 limitation; true per-agent routing needs a
 *     Conversation.assigned_identity_id column added in a later phase.
 *   - Odoo tasks are ALWAYS scoped to the viewer's own assignee email, for
 *     every rank. The Odoo connector in this codebase is a single
 *     EPIC-wide instance (lib/connector.ts resolveConfig — odoo reads
 *     global env config, not a per-tenant binding), so there is no
 *     tenant-safe way to show "all tasks": widening scope by role would
 *     risk leaking another tenant's Odoo data. Self-scoping is the only
 *     safe default until a tenant→Odoo-project mapping exists.
 */

import { prisma } from './prisma';
import { callEngine } from './connector';
import { getMembershipRole, type Role } from './permissions';
import type { SessionCtx } from './session';

export type WorkQueueItemType = 'odoo_task' | 'conversation' | 'voicemail' | 'approval';

export interface WorkQueueItem {
  type: WorkQueueItemType;
  id: string;
  title: string;
  subtitle: string;
  status: string;
  urgent: boolean;
  timestamp: number;
  time: string;
  href: string;
}

export interface WorkQueue {
  /** Effective rank used for scoping — 'owner' also covers global admin/owner. */
  rank: Role;
  scope: 'all' | 'own';
  items: WorkQueueItem[];
  counts: Record<WorkQueueItemType, number>;
}

export function relativeTime(date: Date | null): string {
  if (!date) return '—';
  const diff = Date.now() - new Date(date).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return new Date(date).toLocaleDateString();
}

/** Global User.role owner/admin always ranks as tenant 'owner' — same
 *  precedence rule as lib/permissions.ts can(). Otherwise falls back to the
 *  per-tenant Membership.role, defaulting to the least-privileged 'staff'
 *  when no Membership row resolves (never widen scope on a miss). */
async function resolveViewerRank(session: SessionCtx): Promise<Role> {
  if (session.isAdmin || session.isOwner) return 'owner';
  const role = await getMembershipRole(session.identityId, session.effectiveTenantId);
  return role ?? 'staff';
}

async function getOpenConversations(tenantId: string): Promise<WorkQueueItem[]> {
  const conversations = await prisma.conversation.findMany({
    where: { tenant_id: tenantId, status: 'open' },
    include: { messages: { orderBy: { created_at: 'desc' }, take: 1 } },
    orderBy: { last_message_at: 'desc' },
    take: 25,
  });
  return conversations.map((c) => {
    const lastMsg = c.messages[0];
    const ts = c.last_message_at ? new Date(c.last_message_at).getTime() : 0;
    return {
      type: 'conversation' as const,
      id: c.id,
      title: c.customer_name ?? c.customer_phone,
      subtitle: lastMsg?.content ?? 'No messages yet',
      status: c.agent_took_over ? 'human' : 'open',
      urgent: false,
      timestamp: ts,
      time: relativeTime(c.last_message_at),
      href: `/inbox/${c.id}`,
    };
  });
}

async function getVoicemailCatches(tenantId: string): Promise<WorkQueueItem[]> {
  const catches = await prisma.tenantVoicemailCatch.findMany({
    where: { tenant_id: tenantId, delivered: false },
    orderBy: { created_at: 'desc' },
    take: 25,
  });
  return catches.map((v) => ({
    type: 'voicemail' as const,
    id: v.id,
    title: `Missed call: ${v.callerId}`,
    subtitle: v.summary,
    status: v.urgency,
    urgent: v.urgency === 'urgent' || v.urgency === 'high',
    timestamp: v.created_at.getTime(),
    time: relativeTime(v.created_at),
    href: `/workspace/voicemail/${v.id}`,
  }));
}

async function getPendingApprovals(tenantId: string, ownRequestsOnlyActorId?: string): Promise<WorkQueueItem[]> {
  const pendingRows = await prisma.auditLog.findMany({
    where: {
      tenant_id: tenantId,
      action: { endsWith: '.pending_approval' },
      ...(ownRequestsOnlyActorId ? { actor_id: ownRequestsOnlyActorId } : {}),
    },
    orderBy: { created_at: 'desc' },
    take: 50,
  });

  const open: WorkQueueItem[] = [];
  for (const row of pendingRows) {
    if (!row.request_id) continue;
    const baseAction = row.action.replace(/\.pending_approval$/, '');
    const resolved = await prisma.auditLog.findFirst({
      where: { tenant_id: tenantId, action: `${baseAction}.approved`, request_id: row.request_id },
    });
    if (resolved) continue;
    open.push({
      type: 'approval',
      id: row.id,
      title: `Approval needed: ${baseAction}`,
      subtitle: row.entity ? `${row.entity}${row.entity_id ? ` #${row.entity_id}` : ''}` : 'Pending human approval',
      status: 'pending',
      urgent: true,
      timestamp: row.created_at.getTime(),
      time: relativeTime(row.created_at),
      href: `/workspace/approval/${row.id}`,
    });
  }
  return open;
}

async function getAssignedOdooTasks(session: SessionCtx): Promise<WorkQueueItem[]> {
  const email = session.user.email;
  if (!email) return [];
  try {
    const tasks = await callEngine('odoo', 'findOpenTasksByAssignee', [email, 25], {
      tenant: { tenantId: session.effectiveTenantId },
      actorId: session.user.id,
      entity: 'project.task',
    });
    return tasks.map((t) => ({
      type: 'odoo_task' as const,
      id: String(t.id),
      title: t.name,
      subtitle: [t.projectName, t.stageName].filter(Boolean).join(' · ') || 'Odoo task',
      status: t.stageName ?? 'open',
      urgent: t.priority === '1' || t.priority === '2',
      timestamp: t.dateDeadline ? new Date(t.dateDeadline).getTime() : 0,
      time: t.dateDeadline ? new Date(t.dateDeadline).toLocaleDateString() : 'No deadline',
      href: `/workspace/odoo_task/${t.id}`,
    }));
  } catch (err) {
    console.error('[workspace-queue] Odoo task fetch failed', err);
    return [];
  }
}

export async function getWorkQueue(session: SessionCtx): Promise<WorkQueue> {
  const tenantId = session.effectiveTenantId;
  const rank = await resolveViewerRank(session);
  const fullTenantScope = rank !== 'staff';

  const [conversations, voicemails, approvals, odooTasks] = await Promise.all([
    getOpenConversations(tenantId),
    getVoicemailCatches(tenantId),
    getPendingApprovals(tenantId, fullTenantScope ? undefined : session.user.id),
    getAssignedOdooTasks(session),
  ]);

  const items = [...odooTasks, ...conversations, ...voicemails, ...approvals].sort(
    (a, b) => b.timestamp - a.timestamp,
  );

  const counts: Record<WorkQueueItemType, number> = {
    odoo_task: odooTasks.length,
    conversation: conversations.length,
    voicemail: voicemails.length,
    approval: approvals.length,
  };

  return { rank, scope: fullTenantScope ? 'all' : 'own', items, counts };
}
