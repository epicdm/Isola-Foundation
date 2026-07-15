/**
 * Agent-tools governance layer — the ONLY code that executes a tool call
 * accepted by POST /api/agent-tools/invoke.
 *
 * This module does NOT talk to the network directly for Odoo/WhatsApp: it
 * calls the existing engine clients (engines/odoo.ts, engines/whatsapp.ts)
 * exactly as they are used elsewhere in the app (lib/agent.ts,
 * app/api/crm/customer/route.ts). Nothing here duplicates those clients —
 * it only adds the write-policy / consent / tenant-scope decisions that sit
 * in front of them.
 */

import { prisma } from './prisma';
import { getOdooConfig, getWhatsAppConfig } from './engines';
import { json2Call, OdooApiError, OdooNoApiError } from '@/engines/odoo';
import { sendText } from '@/engines/whatsapp';

// ── Types ─────────────────────────────────────────────────────────────────────

export const TOOL_NAMES = ['odoo.read', 'odoo.create_lead', 'wa.send'] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

export function isToolName(v: unknown): v is ToolName {
  return typeof v === 'string' && (TOOL_NAMES as readonly string[]).includes(v);
}

/** Risk tier surfaced back to the caller on an allowed call. */
export const TOOL_TIER: Record<ToolName, 'read' | 'write' | 'send'> = {
  'odoo.read': 'read',
  'odoo.create_lead': 'write',
  'wa.send': 'send',
};

export type GateDecision =
  | 'blocked_tenant_scope'
  | 'held_over_policy'
  | 'blocked_missing_opt_in';

export class MalformedArgsError extends Error {}

/** A governed block — never a thrown exception path for execution errors. */
export class GateBlockedError extends Error {
  constructor(public gate_decision: GateDecision, message: string) {
    super(message);
  }
}

// ── Odoo write policy — ALWAYS HOLD money / destructive ops ──────────────────
// Applies even though the current tool set only ever issues search_read /
// crm.lead create — defense in depth so a widened `method` never slips a
// destructive or money-moving call through this gate.

const DESTRUCTIVE_METHODS = new Set(['unlink', 'reconcile', 'delete']);
const HELD_MODELS = new Set(['account.payment']);

function checkOdooPolicy(model: string, method: string): void {
  const m = method.toLowerCase().trim();
  const mdl = model.toLowerCase().trim();
  if (HELD_MODELS.has(mdl)) {
    throw new GateBlockedError(
      'held_over_policy',
      `model "${model}" is a money-moving model — always held over policy, never executed`,
    );
  }
  if (DESTRUCTIVE_METHODS.has(m)) {
    throw new GateBlockedError(
      'held_over_policy',
      `method "${method}" is destructive/money-related — always held over policy, never executed`,
    );
  }
}

// ── odoo.read ──────────────────────────────────────────────────────────────────

export interface OdooReadArgs {
  model: string;
  method: string;
  domain?: unknown[];
  fields?: string[];
  limit?: number;
}

export function validateOdooReadArgs(args: any): OdooReadArgs {
  if (!args || typeof args !== 'object') throw new MalformedArgsError('args must be an object');
  if (typeof args.model !== 'string' || !args.model.trim()) {
    throw new MalformedArgsError('args.model (string) is required');
  }
  if (typeof args.method !== 'string' || !args.method.trim()) {
    throw new MalformedArgsError('args.method (string) is required');
  }
  if (args.domain !== undefined && !Array.isArray(args.domain)) {
    throw new MalformedArgsError('args.domain must be an array when provided');
  }
  if (args.fields !== undefined && !Array.isArray(args.fields)) {
    throw new MalformedArgsError('args.fields must be an array when provided');
  }
  if (args.limit !== undefined && (typeof args.limit !== 'number' || args.limit <= 0)) {
    throw new MalformedArgsError('args.limit must be a positive number when provided');
  }
  return {
    model: args.model,
    method: args.method,
    domain: args.domain ?? [],
    fields: args.fields,
    limit: Math.min(args.limit ?? 50, 200), // hard cap regardless of caller input
  };
}

export async function executeOdooRead(args: OdooReadArgs): Promise<unknown> {
  // Policy check runs BEFORE the method-shape check so a caller trying to
  // sneak `unlink` / `account.payment` through odoo.read is held over
  // policy, not merely rejected as malformed.
  checkOdooPolicy(args.model, args.method);
  if (args.method !== 'search_read') {
    throw new MalformedArgsError('odoo.read only supports method "search_read"');
  }
  try {
    return await json2Call(getOdooConfig(), args.model, 'search_read', {
      domain: args.domain ?? [],
      fields: args.fields,
      limit: args.limit,
    });
  } catch (e) {
    if (e instanceof OdooApiError || e instanceof OdooNoApiError) throw e;
    throw e;
  }
}

// ── odoo.create_lead ───────────────────────────────────────────────────────────

export interface OdooCreateLeadArgs {
  name: string;
  contact_name?: string;
  phone?: string;
  description?: string;
}

export function validateOdooCreateLeadArgs(args: any): OdooCreateLeadArgs {
  if (!args || typeof args !== 'object') throw new MalformedArgsError('args must be an object');
  if (typeof args.name !== 'string' || !args.name.trim()) {
    throw new MalformedArgsError('args.name (string) is required');
  }
  for (const key of ['contact_name', 'phone', 'description']) {
    if (args[key] !== undefined && typeof args[key] !== 'string') {
      throw new MalformedArgsError(`args.${key} must be a string when provided`);
    }
  }
  return {
    name: args.name,
    contact_name: args.contact_name,
    phone: args.phone,
    description: args.description,
  };
}

export async function executeOdooCreateLead(args: OdooCreateLeadArgs): Promise<unknown> {
  checkOdooPolicy('crm.lead', 'create'); // always passes — kept for defense-in-depth symmetry
  return json2Call(getOdooConfig(), 'crm.lead', 'create', {
    values: {
      name: args.name,
      contact_name: args.contact_name,
      phone: args.phone,
      description: args.description,
    },
  });
}

// ── wa.send ────────────────────────────────────────────────────────────────────

export interface WaSendArgs {
  to: string;
  text: string;
  purpose?: string;
}

const WA_SEND_WINDOW_MS = 24 * 60 * 60 * 1000; // Meta's 24h customer-service window
const TOKEN_ENV_ALLOWLIST = /^(META_|WHATSAPP_)/;

/**
 * 2026-04-11 BFF policy: EPIC's FB-linked number (1568, phone_number_id
 * 294957850360835) may only ever REPLY to inbound — never originate a
 * proactive/tool-driven send. executeWaSend() is the one send path that
 * picks a tenant's WhatsAppNumber by query (not "whichever number the
 * inbound message arrived on"), so it is the one place this could
 * accidentally happen if a tenant's oldest-created number ever changed.
 * Hardcoded here (mirrors the HERMES_ALLOWED_PHONE_NUMBER_IDS allowlist
 * pattern in lib/brain-provider.ts) so this can never regress by
 * misconfiguration or reordering.
 */
const PROACTIVE_OUTBOUND_BLOCKED_PHONE_NUMBER_IDS: ReadonlySet<string> = new Set([
  '294957850360835', // EPIC FB-linked, +17672851568
]);

export function validateWaSendArgs(args: any): WaSendArgs {
  if (!args || typeof args !== 'object') throw new MalformedArgsError('args must be an object');
  if (typeof args.to !== 'string' || !args.to.trim()) {
    throw new MalformedArgsError('args.to (string) is required');
  }
  if (typeof args.text !== 'string' || !args.text.trim()) {
    throw new MalformedArgsError('args.text (string) is required');
  }
  if (args.purpose !== undefined && typeof args.purpose !== 'string') {
    throw new MalformedArgsError('args.purpose must be a string when provided');
  }
  return { to: args.to, text: args.text, purpose: args.purpose };
}

function toE164(raw: string): string {
  const digits = raw.replace(/[^\d]/g, '');
  return raw.startsWith('+') ? `+${digits}` : `+${digits}`;
}

/**
 * Consent + 24h window gate — reuses the same Consent table and
 * opted_in-only rule already enforced (fail-closed) in lib/agent.ts and the
 * A2 Chatwoot agent-bot route. Unlike those inbound gates, this is an
 * OUTBOUND-initiated send, so it never auto-upserts an opt-in row — a real
 * opted_in Consent record must already exist from a prior inbound message.
 */
export async function checkWaSendGate(tenantId: string, to: string): Promise<void> {
  const phone = toE164(to);

  const consent = await prisma.consent.findUnique({
    where: { tenant_id_phone: { tenant_id: tenantId, phone } },
  });
  if (!consent || consent.status !== 'opted_in') {
    throw new GateBlockedError('blocked_missing_opt_in', `no opted-in consent on file for ${phone}`);
  }

  const conversation = await prisma.conversation.findFirst({
    where: { tenant_id: tenantId, customer_phone: phone },
    orderBy: { last_message_at: 'desc' },
  });
  const lastMessageAt = conversation?.last_message_at ?? null;
  if (!lastMessageAt || Date.now() - lastMessageAt.getTime() > WA_SEND_WINDOW_MS) {
    throw new GateBlockedError(
      'blocked_missing_opt_in',
      `outside the 24h WhatsApp customer-service window for ${phone}`,
    );
  }
}

export async function executeWaSend(tenantId: string, args: WaSendArgs): Promise<unknown> {
  const waNumber = await prisma.whatsAppNumber.findFirst({
    where: {
      tenant_id: tenantId,
      phone_number_id: { notIn: [...PROACTIVE_OUTBOUND_BLOCKED_PHONE_NUMBER_IDS] },
    },
    orderBy: { created_at: 'asc' },
  });
  if (!waNumber) {
    throw new Error(`no WhatsAppNumber configured for tenant ${tenantId}`);
  }

  let effectiveToken: string;
  if (waNumber.token_env) {
    if (!TOKEN_ENV_ALLOWLIST.test(waNumber.token_env)) {
      throw new Error(`token_env "${waNumber.token_env}" rejected — must start with META_ or WHATSAPP_`);
    }
    const resolved = process.env[waNumber.token_env];
    if (!resolved) {
      throw new Error(`token_env "${waNumber.token_env}" is set but env var is empty or missing`);
    }
    effectiveToken = resolved;
  } else {
    effectiveToken = waNumber.access_token;
  }

  const phoneDigits = toE164(args.to).slice(1); // Meta expects digits only, no '+'
  const result = await sendText(getWhatsAppConfig(), {
    phoneId: waNumber.phone_number_id,
    token: effectiveToken,
    to: phoneDigits,
    body: args.text,
  });
  if (!result.ok) {
    throw new Error(result.error ?? 'WhatsApp send failed');
  }
  return result;
}
