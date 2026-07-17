/**
 * POST /api/agent-tools/invoke
 *
 * The governed tool-catalog seam every Flowise agent flow calls to touch
 * Odoo or send WhatsApp. Governance (tenant scope, Odoo write policy,
 * WhatsApp consent) is enforced HERE, at the gate — never inside the flow.
 *
 * Auth: `Authorization: Bearer <ISOLA_AGENT_TOOLS_TOKEN>` — a standalone
 * service token, NOT a session cookie and NOT an Odoo/Meta key. This route
 * is intentionally NOT session-gated (no getSessionFromCookie call) so a
 * Flowise flow can call it directly over public HTTPS.
 *
 * Flag-gated: FLOWISE_AGENT_TOOLS_ENABLED must be exactly "true", or every
 * request gets 403 { ok:false, error:"service_disabled" } regardless of
 * token. Default is OFF.
 *
 * HTTP status contract (do not "fix" this to be more RESTful — it's load-
 * bearing for the calling Flowise flow):
 *   200 — both an ALLOWED call and a GOVERNED BLOCK. The flow branches on
 *         `ok`/`blocked`, not on HTTP status.
 *   4xx — only for auth/shape problems the caller must fix before retrying
 *         (bad_auth, unknown_tool, malformed_args). Also 403 service_disabled.
 */

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { isAgentToolsEnabled, getAgentToolsToken } from '@/lib/engines';
import {
  isToolName,
  TOOL_TIER,
  MalformedArgsError,
  GateBlockedError,
  validateOdooReadArgs,
  validateOdooCreateLeadArgs,
  validateWaSendArgs,
  executeOdooRead,
  executeOdooCreateLead,
  executeWaSend,
  checkWaSendGate,
  type ToolName,
  type GateDecision,
} from '@/lib/agent-tools';

// ── Auth ──────────────────────────────────────────────────────────────────────

function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function authenticate(req: NextRequest): boolean {
  const expected = getAgentToolsToken();
  if (!expected) return false; // not configured — never authenticate against an empty token
  const header = req.headers.get('authorization') ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) return false;
  return constantTimeEquals(match[1], expected);
}

// ── Response helpers ───────────────────────────────────────────────────────────

function errorResponse(status: number, error: string) {
  return NextResponse.json({ ok: false, error }, { status });
}

async function writeAuditRow(params: {
  tenantId: string;
  agentId: string;
  requestId: string;
  tool: ToolName;
  args: unknown;
  sessionRef?: unknown;
  requestedTenantId?: string;
  meta: Record<string, unknown>;
}) {
  return prisma.auditLog.create({
    data: {
      tenant_id: params.tenantId,
      actor_id: `agent:${params.agentId}`,
      action: 'agent_tools.invoke',
      entity: 'agent_tool',
      entity_id: params.tool,
      request_id: params.requestId,
      meta: JSON.parse(
        JSON.stringify({
          request_id: params.requestId,
          session_ref: params.sessionRef ?? null,
          tool: params.tool,
          args: params.args,
          requested_tenant_id: params.requestedTenantId,
          ...params.meta,
        }),
      ),
    },
  });
}

function blockResponse(gate_decision: GateDecision, reason: string, audit_id: string) {
  return NextResponse.json({ ok: false, blocked: true, gate_decision, reason, audit_id });
}

// ── POST handler ──────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  // 1. Flag gate — service disabled entirely, regardless of credentials.
  if (!isAgentToolsEnabled()) {
    return errorResponse(403, 'service_disabled');
  }

  // 2. Auth gate.
  if (!authenticate(req)) {
    return errorResponse(401, 'bad_auth');
  }

  // 3. Parse body.
  let body: Record<string, any>;
  try {
    body = await req.json();
  } catch {
    return errorResponse(400, 'malformed_args');
  }

  const { tenant_id, agent_id, tool, args, request_id, session_ref } = body ?? {};

  // 4. Tool enum check.
  if (!isToolName(tool)) {
    return errorResponse(400, 'unknown_tool');
  }

  // 5. Top-level shape check.
  if (
    typeof tenant_id !== 'string' || !tenant_id.trim() ||
    typeof agent_id !== 'string' || !agent_id.trim() ||
    typeof request_id !== 'string' || !request_id.trim() ||
    args === undefined || args === null || typeof args !== 'object'
  ) {
    return errorResponse(400, 'malformed_args');
  }

  // 6. Per-tool args shape check.
  let validatedArgs: any;
  try {
    if (tool === 'odoo.read') validatedArgs = validateOdooReadArgs(args);
    else if (tool === 'odoo.create_lead') validatedArgs = validateOdooCreateLeadArgs(args);
    else validatedArgs = validateWaSendArgs(args); // wa.send
  } catch (e) {
    if (e instanceof MalformedArgsError) return errorResponse(400, 'malformed_args');
    throw e;
  }

  // 7. Resolve the agent → its REAL, trusted tenant. Never trust the caller-
  //    supplied tenant_id past this point.
  const agent = await prisma.agent.findUnique({ where: { id: agent_id } });
  if (!agent) {
    return errorResponse(400, 'malformed_args'); // unknown agent_id — no tenant to attach an audit row to
  }
  const trustedTenantId = agent.tenant_id;

  // 8. Idempotency — a repeated request_id must not double-execute.
  const existing = await prisma.auditLog.findFirst({
    where: { tenant_id: trustedTenantId, action: 'agent_tools.invoke', request_id },
    orderBy: { created_at: 'desc' },
  });
  if (existing) {
    const meta = existing.meta as Record<string, unknown>;
    if (meta.blocked) {
      return blockResponse(
        meta.gate_decision as GateDecision,
        meta.reason as string,
        existing.id,
      );
    }
    return NextResponse.json({
      ok: true,
      result: meta.result,
      audit_id: existing.id,
      tier: meta.tier,
    });
  }

  // 9. Tenant scope — mismatch is a hard block, never a trust of the caller.
  if (tenant_id !== trustedTenantId) {
    const row = await writeAuditRow({
      tenantId: trustedTenantId,
      agentId: agent_id,
      requestId: request_id,
      tool,
      args: validatedArgs,
      sessionRef: session_ref,
      requestedTenantId: tenant_id,
      meta: {
        ok: false,
        blocked: true,
        gate_decision: 'blocked_tenant_scope',
        reason: `agent ${agent_id} belongs to tenant ${trustedTenantId}, not the requested tenant ${tenant_id}`,
      },
    });
    return blockResponse('blocked_tenant_scope', row.meta && (row.meta as any).reason, row.id);
  }

  // 10. Tool-specific governance gate (policy hold / consent) — never
  //     executes the tool on a block.
  try {
    if (tool === 'wa.send') {
      await checkWaSendGate(trustedTenantId, validatedArgs.to);
    }
    // odoo.* policy is checked inline at execution time in lib/agent-tools,
    // BEFORE the network call — see executeOdooRead / executeOdooCreateLead.
  } catch (e) {
    if (e instanceof GateBlockedError) {
      const row = await writeAuditRow({
        tenantId: trustedTenantId,
        agentId: agent_id,
        requestId: request_id,
        tool,
        args: validatedArgs,
        sessionRef: session_ref,
        meta: { ok: false, blocked: true, gate_decision: e.gate_decision, reason: e.message },
      });
      return blockResponse(e.gate_decision, e.message, row.id);
    }
    throw e;
  }

  // 11. AUDIT-BEFORE-DISPATCH — the row exists before any side effect fires.
  const preRow = await writeAuditRow({
    tenantId: trustedTenantId,
    agentId: agent_id,
    requestId: request_id,
    tool,
    args: validatedArgs,
    sessionRef: session_ref,
    meta: { ok: null, blocked: false, dispatching: true, tier: TOOL_TIER[tool] },
  });

  // 12. Dispatch.
  try {
    let result: unknown;
    if (tool === 'odoo.read') {
      result = await executeOdooRead(trustedTenantId, validatedArgs);
    } else if (tool === 'odoo.create_lead') {
      result = await executeOdooCreateLead(trustedTenantId, validatedArgs);
    } else {
      result = await executeWaSend(trustedTenantId, validatedArgs);
    }

    await prisma.auditLog.update({
      where: { id: preRow.id },
      data: {
        meta: JSON.parse(
          JSON.stringify({
            ...(preRow.meta as Record<string, unknown>),
            ok: true,
            dispatching: false,
            result,
          }),
        ),
      },
    });

    return NextResponse.json({ ok: true, result, audit_id: preRow.id, tier: TOOL_TIER[tool] });
  } catch (e: any) {
    // A governance-blocked destructive/money op raised inside execute*
    // (defense-in-depth path — see checkOdooPolicy) is still a 200 block,
    // never an execution failure.
    if (e instanceof GateBlockedError) {
      await prisma.auditLog.update({
        where: { id: preRow.id },
        data: {
          meta: JSON.parse(
            JSON.stringify({
              ...(preRow.meta as Record<string, unknown>),
              ok: false,
              blocked: true,
              dispatching: false,
              gate_decision: e.gate_decision,
              reason: e.message,
            }),
          ),
        },
      });
      return blockResponse(e.gate_decision, e.message, preRow.id);
    }

    // Genuine execution failure (Odoo/WhatsApp/network error) — governance
    // already allowed this call; this is not a governed block, so it keeps
    // the 200 envelope with ok:false and the audit_id for correlation.
    console.error('[agent-tools/invoke] execution failed:', e?.message ?? e);
    await prisma.auditLog.update({
      where: { id: preRow.id },
      data: {
        meta: JSON.parse(
          JSON.stringify({
            ...(preRow.meta as Record<string, unknown>),
            ok: false,
            dispatching: false,
            error: e?.message ?? 'execution failed',
          }),
        ),
      },
    });
    return NextResponse.json({
      ok: false,
      error: 'execution_failed',
      detail: e?.message ?? 'execution failed',
      audit_id: preRow.id,
    });
  }
}
