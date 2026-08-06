/**
 * revenue-mcp-handlers@1 — thin, typed wrappers around the two revenue-MCP
 * business-logic functions, named exactly as the future MCP tool names Lane
 * 1's separate transport lane will register:
 *
 *   isola_revenue_customer_context_get  -> runRevenueCustomerContextGet
 *   isola_revenue_followup_set          -> runRevenueFollowupSet
 *
 * THIS FILE IS NOT THE MCP SERVER. It is the seam a transport (stdio, HTTP,
 * whatever Lane 1's MCP lane builds) calls into with real, production-wired
 * ports — matching the composition the existing route
 * (app/api/v1/customers/[customerId]/actions/route.ts) does inline: resolve
 * the caller's tenant, resolve that tenant's Odoo binding, build a
 * `RecordSystem` scoped to it, then call the governed function. No lifecycle
 * logic lives here — that is entirely in context-read.ts and
 * lib/governed/revenue-mcp-actions.ts, which are unit-tested without a
 * transport, a server, or a network call.
 */

import { createOdooRecordSystem } from '@/lib/governed/executors/odoo-record-system'
import {
  runRevenueFollowupSet,
  type RevenueFollowupSetRequest,
  type RevenueFollowupSetResult,
} from '@/lib/governed/revenue-mcp-actions'
import { resolveOdooConfigForTenant } from '@/lib/engine-bindings'
import { prisma } from '@/lib/prisma'

import {
  DEFAULT_REVENUE_CONTEXT_PORTS,
  runRevenueCustomerContextGet,
  type RevenueContextRequest,
  type RevenueContextResult,
} from './context-read'

export const ISOLA_REVENUE_CUSTOMER_CONTEXT_GET = 'isola_revenue_customer_context_get' as const
export const ISOLA_REVENUE_FOLLOWUP_SET = 'isola_revenue_followup_set' as const

/**
 * `hints`/`payload` here are the raw arguments an MCP tool call would carry —
 * untrusted shape, validated by the functions underneath. `agentRef` is
 * whatever the transport's own authentication resolved as the calling
 * Clawith agent/session identity; this wrapper does not invent a new auth
 * mechanism, it forwards that resolved reference.
 */
export interface RevenueMcpToolArgs {
  agentRef: string
  accountId: string
  inboxId: string
  conversationId: string
  messageLimit?: number
}

export async function isolaRevenueCustomerContextGet(
  args: RevenueMcpToolArgs,
): Promise<RevenueContextResult> {
  const req: RevenueContextRequest = {
    caller: { agentRef: args.agentRef },
    hints: { accountId: args.accountId, inboxId: args.inboxId, conversationId: args.conversationId },
    messageLimit: args.messageLimit,
  }
  return runRevenueCustomerContextGet(req, DEFAULT_REVENUE_CONTEXT_PORTS)
}

export interface RevenueFollowupSetToolArgs {
  agentRef: string
  leadId: string
  ownerRef?: string
  nextAction?: string
  dueDate?: string
  idempotencyKey: string
  correlationId: string
}

async function defaultResolveTenantForAgent(agentRef: string): Promise<string | null> {
  const agent = await prisma.agent.findUnique({ where: { id: agentRef } })
  return agent?.is_active ? agent.tenant_id : null
}

export async function isolaRevenueFollowupSet(
  args: RevenueFollowupSetToolArgs,
): Promise<RevenueFollowupSetResult> {
  const req: RevenueFollowupSetRequest = {
    caller: { agentRef: args.agentRef },
    leadId: args.leadId,
    payload: {
      ...(args.ownerRef !== undefined ? { ownerRef: args.ownerRef } : {}),
      ...(args.nextAction !== undefined ? { nextAction: args.nextAction } : {}),
      ...(args.dueDate !== undefined ? { dueDate: args.dueDate } : {}),
    },
    idempotencyKey: args.idempotencyKey,
    correlationId: args.correlationId,
  }

  // Resolve the tenant ONCE, here, so the SAME resolved tenant drives both
  // the Odoo config lookup and the governed action's own (independent)
  // caller-identity resolution — matching app/api/agent-tools/invoke/route.ts's
  // "resolve the agent -> its REAL tenant" step, done once, before any write.
  const tenantId = await defaultResolveTenantForAgent(args.agentRef)
  if (!tenantId) {
    return { ok: false, code: 'unauthenticated', detail: 'caller identity did not resolve to an active tenant' }
  }

  const config = await resolveOdooConfigForTenant(tenantId)
  const rec = createOdooRecordSystem({ resolveConfig: async () => config })

  return runRevenueFollowupSet(req, {
    rec,
    now: () => new Date(),
    resolveTenantForAgent: defaultResolveTenantForAgent,
  })
}
