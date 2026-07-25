/**
 * Tenant Zero workspace reads — Chunk 1.
 *
 * One governed, tenant-scoped assembly layer for the owner workspace. Server
 * components and the `/api/workspace/*` control-plane routes both call these
 * functions, so there is exactly one implementation of each read.
 *
 * Rules honoured here:
 *  - Every query is scoped by `ctx.effectiveTenantId`. Nothing accepts a
 *    caller-supplied tenant id.
 *  - Secrets never leave this module. `ChatwootBinding.token` and
 *    `WhatsAppNumber.access_token` are never selected into a return value.
 *  - Tenant -> ChatwootBinding is one-to-many. Never `findFirst({tenant_id})`;
 *    resolve per-agent first, then fall back through `resolveActiveBinding`.
 *  - Capabilities with no backing data model are reported `not_configured`
 *    with an explanation — never rendered as if they were real.
 */

import { prisma } from '@/lib/prisma';
import type { SessionCtx } from '@/lib/session';
import { resolveActiveBinding } from '@/lib/chatwoot-binding-resolution';
import { TOOL_NAMES, TOOL_TIER, type ToolName } from '@/lib/agent-tools';
import { isAgentToolsEnabled } from '@/lib/engines';
import { getCurrentUsage, getUsageHistory } from '@/lib/meter';
import { type Panel, live, empty, notConfigured } from './provenance';

/* ------------------------------------------------------------------ types */

export type ChannelKind = 'whatsapp' | 'voice';

export interface AgentChannel {
  kind: ChannelKind;
  /** Owner-facing number, e.g. "+1 767-818-3742". Never an internal id. */
  displayNumber: string | null;
  label: string | null;
  /** Whether this channel is currently marked active for the tenant. */
  connected: boolean;
  /**
   * True when the binding was resolved specifically for this agent rather than
   * inherited from the tenant. Drives an honest "shared / dedicated" label.
   */
  agentSpecific: boolean;
}

export interface TeamMember {
  id: string;
  name: string;
  /** 'active' | 'paused' — from Agent.is_active. */
  status: 'active' | 'paused';
  /** Owner-readable runtime label, not the raw provider key. */
  runtime: string;
  runtimeKey: string;
  greeting: string | null;
  channels: AgentChannel[];
  /** True when a customer-agent runtime binding exists for this agent. */
  runtimeBound: boolean;
  conversationCount: number;
  openConversationCount: number;
  lastActivityAt: string | null;
}

export interface AgentResponsibilities {
  /** Free-text business context the agent answers from. */
  businessInfo: string | null;
  knowledgeSummary: string | null;
  knowledgeCharacters: number;
  greeting: string | null;
  awayMessage: string | null;
  afterHours: { start: string | null; end: string | null; timezone: string } | null;
}

export interface AgentToolInfo {
  name: ToolName;
  tier: 'read' | 'write' | 'send';
  /** Owner-readable description of what the tool can do. */
  description: string;
}

export interface AgentDetail {
  id: string;
  name: string;
  status: 'active' | 'paused';
  runtime: string;
  runtimeKey: string;
  intelligenceTier: string;
  channels: AgentChannel[];
  responsibilities: AgentResponsibilities;
  conversationCount: number;
  openConversationCount: number;
  humanHandlingCount: number;
  lastActivityAt: string | null;
  /**
   * True when the counts above are workspace-wide rather than this assistant's.
   * Conversations carry no agent foreign key, so with several assistants the
   * totals cannot honestly be attributed to one of them.
   */
  countsAreWorkspaceWide: boolean;
}

export interface HandoffState {
  /** Conversations currently being handled by a human. */
  humanHandlingCount: number;
  /**
   * True when any user of THIS workspace has manual takeover switched on.
   * Scoped to the workspace being viewed, never to the viewer's own tenant.
   */
  ownerTakeoverActive: boolean;
  /** Escalations minted in the trailing window. */
  escalationsLast7Days: number;
  mostRecentEscalationAt: string | null;
}

export interface ActivityEntry {
  id: string;
  action: string;
  label: string;
  entity: string | null;
  actor: string;
  at: string;
}

export interface ActivitySummary {
  conversationsTotal: number;
  conversationsOpen: number;
  conversationsLast7Days: number;
  messagesLast7Days: number;
  usageThisMonth: { minutesUsed: number; tokensUsed: number; periodStart: string | null } | null;
  usageHistory: Array<{ periodStart: string; minutesUsed: number; tokensUsed: number }>;
  recent: ActivityEntry[];
}

/* -------------------------------------------------------------- constants */

const RUNTIME_LABELS: Record<string, string> = {
  native: 'Isola built-in',
  clawith: 'Isola assistant runtime',
  hermes: 'Internal operations agent',
  flowise: 'Legacy flow runtime',
};

const TOOL_DESCRIPTIONS: Record<ToolName, string> = {
  'odoo.read': 'Look up customer and account records in your business system',
  'odoo.create_lead': 'Create a new sales lead from a conversation',
  'wa.send': 'Send a WhatsApp message on your behalf',
};

/** Turn an audit action key into something an owner can read. */
const ACTION_LABELS: Record<string, string> = {
  'escalate_to_human.invoked': 'Assistant handed a conversation to a person',
  'takeover.enable': 'Owner took over conversations',
  'takeover.disable': 'Owner returned conversations to the assistant',
  'agent.update': 'Assistant settings updated',
  'chatwoot.addMessage': 'Reply delivered to customer',
  'chatwoot.addPrivateNote': 'Internal note added to conversation',
  'chatwoot.createConversation': 'New conversation opened',
  'whatsapp.sendText': 'WhatsApp message sent',
  'odoo.findCustomerByPhone': 'Customer record looked up',
  'odoo.createCrmLead': 'Sales lead created',
};

function labelAction(action: string): string {
  if (ACTION_LABELS[action]) return ACTION_LABELS[action];
  const [engine, op] = action.split('.');
  if (engine && op) {
    const readable = op.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
    return readable.charAt(0).toUpperCase() + readable.slice(1);
  }
  return action;
}

function labelActor(actorId: string): string {
  if (actorId === 'system') return 'Isola';
  if (actorId.startsWith('agent:')) return 'Assistant';
  if (actorId.startsWith('clawith:')) return 'Assistant';
  return 'You';
}

function runtimeLabel(key: string): string {
  return RUNTIME_LABELS[key] ?? 'Assistant runtime';
}

function daysAgo(n: number): Date {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000);
}

/**
 * Fail closed on a missing tenant scope.
 *
 * Prisma silently drops `where: { tenant_id: undefined }`, which would turn
 * every read in this module into a cross-tenant query. `effectiveTenantId` is
 * non-null today, so this guard should never fire — that is exactly why it is
 * cheap to keep.
 */
function requireTenantScope(ctx: SessionCtx): string {
  const tenantId = ctx.effectiveTenantId;
  if (!tenantId || typeof tenantId !== 'string') {
    throw new Error('workspace read attempted without a tenant scope');
  }
  return tenantId;
}

/** Format a stored E.164-ish number for display without inventing digits. */
export function formatNumber(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = raw.replace(/[^\d]/g, '');
  if (digits.length === 11 && digits.startsWith('1')) {
    return `+1 ${digits.slice(1, 4)}-${digits.slice(4, 7)}-${digits.slice(7)}`;
  }
  return raw.startsWith('+') ? raw : `+${digits}`;
}

/* ------------------------------------------------------------ team reads */

/**
 * Channels visible to the owner for a given agent.
 *
 * WhatsApp numbers are held at tenant level (`WhatsAppNumber.tenant_id`) with no
 * agent foreign key, so a number is reported as `agentSpecific` only when a
 * per-agent Chatwoot binding pins an inbox for it.
 */
async function channelsForTenant(
  tenantId: string,
  agentId: string | null,
  waNumbers: Array<{ phone_number: string; display_name: string | null }>,
  didNumber: string | null,
  bindings: Array<{ id: string; agent_id: string | null }>
): Promise<AgentChannel[]> {
  const agentSpecific = agentId ? bindings.some((b) => b.agent_id === agentId) : false;

  const channels: AgentChannel[] = waNumbers.map((n) => ({
    kind: 'whatsapp' as const,
    displayNumber: formatNumber(n.phone_number),
    label: n.display_name,
    connected: true,
    agentSpecific,
  }));

  if (didNumber) {
    channels.push({
      kind: 'voice',
      displayNumber: formatNumber(didNumber),
      label: 'Voice line',
      connected: true,
      agentSpecific: false,
    });
  }
  return channels;
}

export async function getAiTeam(ctx: SessionCtx): Promise<Panel<TeamMember[]>> {
  const tenantId = requireTenantScope(ctx);

  const [agents, waNumbers, tenant, chatwootBindings, clawithBindings] = await Promise.all([
    prisma.agent.findMany({ where: { tenant_id: tenantId }, orderBy: { created_at: 'asc' } }),
    prisma.whatsAppNumber.findMany({
      where: { tenant_id: tenantId },
      select: { phone_number: true, display_name: true },
    }),
    prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { magnus_did_number: true, business_name: true },
    }),
    prisma.chatwootBinding.findMany({
      where: { tenant_id: tenantId },
      select: { id: true, agent_id: true },
    }),
    prisma.clawithBinding.findMany({
      where: { tenant_id: tenantId },
      select: { agent_id: true, clawith_agent_id: true },
    }),
  ]);

  if (agents.length === 0) {
    return empty(
      'isola.foundation',
      [],
      'No assistants have been created for this workspace yet. An assistant is created when your service is activated.'
    );
  }

  const [convCounts, openCounts, lastMessages] = await Promise.all([
    prisma.conversation.count({ where: { tenant_id: tenantId } }),
    prisma.conversation.count({ where: { tenant_id: tenantId, status: 'open' } }),
    prisma.conversation.findFirst({
      where: { tenant_id: tenantId },
      orderBy: { last_message_at: 'desc' },
      select: { last_message_at: true },
    }),
  ]);

  // Conversations carry no agent foreign key, so per-agent volumes are only
  // attributable when the tenant has a single assistant. With several, the
  // counts are reported at workspace level rather than invented per agent.
  const single = agents.length === 1;

  const members: TeamMember[] = [];
  for (const a of agents) {
    const channels = await channelsForTenant(
      tenantId,
      a.id,
      waNumbers,
      tenant?.magnus_did_number ?? null,
      chatwootBindings
    );
    const runtimeBound = clawithBindings.some((b) => b.agent_id === a.id || b.agent_id === null);
    members.push({
      id: a.id,
      name: a.name,
      status: a.is_active ? 'active' : 'paused',
      runtime: runtimeLabel(a.brain_provider),
      runtimeKey: a.brain_provider,
      greeting: a.greeting || null,
      channels,
      runtimeBound,
      conversationCount: single ? convCounts : 0,
      openConversationCount: single ? openCounts : 0,
      lastActivityAt: single && lastMessages?.last_message_at ? lastMessages.last_message_at.toISOString() : null,
    });
  }

  return live('isola.foundation', members, lastMessages?.last_message_at ?? null);
}

export async function getAgentDetail(ctx: SessionCtx, agentId: string): Promise<Panel<AgentDetail> | null> {
  const tenantId = requireTenantScope(ctx);

  const agent = await prisma.agent.findFirst({ where: { id: agentId, tenant_id: tenantId } });
  if (!agent) return null; // 404 — never leak existence across tenants

  const agentCount = await prisma.agent.count({ where: { tenant_id: tenantId } });

  const [waNumbers, tenant, chatwootBindings, conversationsTotal, conversationsOpen, humanHandling, lastMessage] =
    await Promise.all([
      prisma.whatsAppNumber.findMany({
        where: { tenant_id: tenantId },
        select: { phone_number: true, display_name: true },
      }),
      prisma.tenant.findUnique({ where: { id: tenantId }, select: { magnus_did_number: true } }),
      prisma.chatwootBinding.findMany({ where: { tenant_id: tenantId }, select: { id: true, agent_id: true } }),
      prisma.conversation.count({ where: { tenant_id: tenantId } }),
      prisma.conversation.count({ where: { tenant_id: tenantId, status: 'open' } }),
      prisma.conversation.count({ where: { tenant_id: tenantId, human_handling: true } }),
      prisma.conversation.findFirst({
        where: { tenant_id: tenantId },
        orderBy: { last_message_at: 'desc' },
        select: { last_message_at: true },
      }),
    ]);

  const channels = await channelsForTenant(
    tenantId,
    agent.id,
    waNumbers,
    tenant?.magnus_did_number ?? null,
    chatwootBindings
  );

  const knowledge = (agent.knowledge_text || '').trim();
  const businessInfo = (agent.business_info || '').trim();

  const detail: AgentDetail = {
    id: agent.id,
    name: agent.name,
    status: agent.is_active ? 'active' : 'paused',
    runtime: runtimeLabel(agent.brain_provider),
    runtimeKey: agent.brain_provider,
    intelligenceTier: agent.intelligence_tier,
    channels,
    responsibilities: {
      businessInfo: businessInfo || null,
      knowledgeSummary: knowledge ? knowledge.slice(0, 400) : null,
      knowledgeCharacters: knowledge.length,
      greeting: agent.greeting || null,
      awayMessage: agent.away_message || null,
      afterHours:
        agent.after_hours_start || agent.after_hours_end
          ? { start: agent.after_hours_start, end: agent.after_hours_end, timezone: agent.timezone }
          : null,
    },
    conversationCount: conversationsTotal,
    openConversationCount: conversationsOpen,
    humanHandlingCount: humanHandling,
    lastActivityAt: lastMessage?.last_message_at ? lastMessage.last_message_at.toISOString() : null,
    countsAreWorkspaceWide: agentCount > 1,
  };

  return live('isola.foundation', detail, lastMessage?.last_message_at ?? null);
}

/**
 * Tools available to an assistant.
 *
 * There is deliberately no per-agent tool configuration in the data model yet —
 * the catalog is global and gated by one deployment flag. Reporting this as
 * `not_configured` is the honest state; inventing a per-agent list would be
 * presenting configuration that does not exist.
 */
export function getAgentTools(): Panel<AgentToolInfo[]> {
  const catalog: AgentToolInfo[] = TOOL_NAMES.map((name) => ({
    name,
    tier: TOOL_TIER[name],
    description: TOOL_DESCRIPTIONS[name],
  }));

  if (!isAgentToolsEnabled()) {
    return notConfigured(
      'isola.config',
      catalog,
      'Governed tools are switched off for this workspace, so your assistant answers from its knowledge only. These are the tools that can be enabled.'
    );
  }

  return notConfigured(
    'isola.config',
    catalog,
    'Tools are enabled workspace-wide. Per-assistant tool permissions are not configurable yet, so this list shows every tool the workspace allows rather than a per-assistant selection.'
  );
}

/* ---------------------------------------------------------- handoff state */

export async function getHandoffState(ctx: SessionCtx): Promise<Panel<HandoffState>> {
  const tenantId = requireTenantScope(ctx);

  const [humanHandlingCount, escalations, latest, takeoverUsers] = await Promise.all([
    prisma.conversation.count({ where: { tenant_id: tenantId, human_handling: true } }),
    prisma.escalationRef.count({ where: { tenant_id: tenantId, created_at: { gte: daysAgo(7) } } }),
    prisma.escalationRef.findFirst({
      where: { tenant_id: tenantId },
      orderBy: { created_at: 'desc' },
      select: { created_at: true },
    }),
    // Takeover is a property of the WORKSPACE being viewed, not of the viewer.
    // Reading ctx.user.agent_took_over here would report an admin's own home
    // tenant state while they act as another tenant.
    prisma.user.count({ where: { tenant_id: tenantId, agent_took_over: true } }),
  ]);

  const state: HandoffState = {
    humanHandlingCount,
    ownerTakeoverActive: takeoverUsers > 0,
    escalationsLast7Days: escalations,
    mostRecentEscalationAt: latest?.created_at ? latest.created_at.toISOString() : null,
  };

  return live('isola.foundation', state, latest?.created_at ?? null);
}

/* -------------------------------------------------------------- activity */

export async function getActivitySummary(ctx: SessionCtx): Promise<Panel<ActivitySummary>> {
  const tenantId = requireTenantScope(ctx);
  const since = daysAgo(7);

  const [
    conversationsTotal,
    conversationsOpen,
    conversationsRecent,
    messagesRecent,
    usage,
    history,
    auditRows,
  ] = await Promise.all([
    prisma.conversation.count({ where: { tenant_id: tenantId } }),
    prisma.conversation.count({ where: { tenant_id: tenantId, status: 'open' } }),
    prisma.conversation.count({ where: { tenant_id: tenantId, created_at: { gte: since } } }),
    prisma.message.count({
      where: { conversation: { tenant_id: tenantId }, created_at: { gte: since } },
    }),
    getCurrentUsage(tenantId),
    getUsageHistory(tenantId, 6),
    prisma.auditLog.findMany({
      where: { tenant_id: tenantId },
      orderBy: { created_at: 'desc' },
      take: 20,
      select: { id: true, action: true, entity: true, actor_id: true, created_at: true },
    }),
  ]);

  const summary: ActivitySummary = {
    conversationsTotal,
    conversationsOpen,
    conversationsLast7Days: conversationsRecent,
    messagesLast7Days: messagesRecent,
    usageThisMonth: usage
      ? {
          minutesUsed: usage.minutes_used,
          tokensUsed: usage.tokens_used,
          periodStart: usage.period_start.toISOString(),
        }
      : null,
    usageHistory: history.map((h) => ({
      periodStart: h.period_start.toISOString(),
      minutesUsed: h.minutes_used,
      tokensUsed: h.tokens_used,
    })),
    recent: auditRows.map((r) => ({
      id: r.id,
      action: r.action,
      label: labelAction(r.action),
      entity: r.entity,
      actor: labelActor(r.actor_id),
      at: r.created_at.toISOString(),
    })),
  };

  if (auditRows.length === 0 && conversationsTotal === 0) {
    return empty(
      'isola.foundation',
      summary,
      'No activity recorded yet. Customer conversations and assistant actions will appear here as they happen.'
    );
  }

  return live('isola.foundation', summary, auditRows[0]?.created_at ?? null);
}

/* --------------------------------------------------- conversation overview */

export interface ConversationOverviewRow {
  id: string;
  customerName: string | null;
  customerPhone: string;
  status: string;
  humanHandling: boolean;
  lastMessageAt: string | null;
  preview: string | null;
}

export async function getConversationOverview(
  ctx: SessionCtx,
  limit = 20
): Promise<Panel<ConversationOverviewRow[]>> {
  const tenantId = requireTenantScope(ctx);

  const rows = await prisma.conversation.findMany({
    where: { tenant_id: tenantId },
    include: { messages: { orderBy: { created_at: 'desc' }, take: 1 } },
    orderBy: { last_message_at: 'desc' },
    take: Math.min(Math.max(limit, 1), 100),
  });

  const mapped: ConversationOverviewRow[] = rows.map((c) => ({
    id: c.id,
    customerName: c.customer_name,
    customerPhone: c.customer_phone,
    status: c.status,
    humanHandling: c.human_handling,
    lastMessageAt: c.last_message_at ? c.last_message_at.toISOString() : null,
    preview: c.messages[0]?.content ? c.messages[0].content.slice(0, 140) : null,
  }));

  if (mapped.length === 0) {
    return empty(
      'isola.mirror',
      [],
      'No customer conversations yet. They appear here as soon as someone messages your connected number.'
    );
  }

  return live('isola.mirror', mapped, rows[0]?.last_message_at ?? null);
}

/** Bindings that exist for this tenant, for the honest "what is connected" panel. */
export async function getWorkspaceBindingSummary(ctx: SessionCtx) {
  const tenantId = requireTenantScope(ctx);
  const bindings = await prisma.chatwootBinding.findMany({
    where: { tenant_id: tenantId },
    select: { id: true, tenant_id: true, updated_at: true, agent_id: true, inbox_id: true, mode: true },
  });
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { status: true } });
  const withStatus = bindings.map((b) => ({ ...b, tenant: { status: tenant?.status ?? 'unknown' } }));
  const active = resolveActiveBinding(withStatus);
  return {
    conversationPlatformConnected: Boolean(active),
    inboxId: active?.inbox_id ?? null,
    mode: active?.mode ?? null,
  };
}
