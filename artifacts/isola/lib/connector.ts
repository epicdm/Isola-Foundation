/**
 * connector.ts — governed single entry point for the /engines/ clients.
 *
 * WHAT THIS DOES
 *   `callEngine(engine, op, args, { tenant })` wraps every call to the six
 *   engine clients (magnus, fiserv, whatsapp, odoo, chatwoot, bff) with three
 *   guarantees the raw clients don't have on their own:
 *     1. ALLOW-LISTED — only the operations named in ALLOW_LIST below can be
 *        invoked. Anything else (including the raw `magnusRequest`/
 *        `json2Call` primitives, and `openCallStateStream`'s streaming
 *        passthrough) is NOT in the allow-list and throws
 *        EngineOpNotAllowedError. This is deliberate, not an oversight — see
 *        "NOT WRAPPED" below.
 *     2. TENANT-SCOPED — every call must carry exactly one of
 *        `tenant.tenantId` / `tenant.consumerAccountId` (mirrors the
 *        existing dual-FK on AuditLog itself, see lib/audit.ts). A call with
 *        neither, or both, throws EngineTenantScopeError before the engine
 *        client is ever invoked.
 *     3. AUDITED — every call, success or failure, writes exactly one
 *        AuditLog row (via the existing `audit()` helper) with
 *        `action = "<engine>.<op>"`, the resolved actor/tenant scope, and an
 *        `ok`/`error` flag in `meta`. Raw call `args` and engine `result`
 *        are NEVER auto-logged into `meta` — several ops carry PAN/CVV/SIP
 *        passwords/tokens (see fiserv.ts, bff.ts) and auto-serializing them
 *        would defeat the redaction discipline those modules already
 *        enforce. Callers may pass their own pre-redacted `opts.meta`.
 *
 * CONFIG RESOLUTION
 *   Callers never build/pass a `config` object — `resolveConfig()` below
 *   wires each engine's config the same way `lib/engines.ts` already does:
 *   magnus/fiserv/odoo/whatsapp/bff read process.env (via the existing
 *   getXConfig() factories); chatwoot is per-tenant, so it requires
 *   `tenant.tenantId` and looks up that tenant's ChatwootBinding row.
 *
 * NOT WRAPPED (flagged, not silently dropped — see engines/README.md for the
 * same discipline applied to the extraction itself)
 *   - Raw `magnusRequest` (lib/magnus-voice.ts, lib/magnus-rateplan.ts) and
 *     raw `json2Call` (lib/agent-tools.ts) — these are generic
 *     module/action or model/method primitives, not a fixed op surface; an
 *     allow-list entry per Magnus module/Odoo model would need to be as
 *     wide as those primitives themselves, which defeats the point of an
 *     allow-list. Bringing them under governance is future work, not this
 *     floor's scope.
 *   - `openCallStateStream` (bff.ts) — returns a raw, unbuffered
 *     `Response` for SSE passthrough; the request/response-shaped
 *     allow-list + single AuditLog-per-call model doesn't fit a long-lived
 *     stream. Left on the direct import.
 *   - `findOrCreateUtmRecord` (odoo.ts), `searchContactByPhone` /
 *     `createContact` (chatwoot.ts) — internal helpers only ever called by
 *     other engine-module functions (`createCrmLead`, `upsertContact`), not
 *     by any app call site directly; nothing to migrate.
 *
 * MIGRATION STATUS (2026-07-16)
 *   Call sites migrate to callEngine() incrementally, one PR-reviewable
 *   change at a time, with no behavior change beyond the added AuditLog
 *   row. Migrated so far: app/api/wallet/balance/route.ts,
 *   app/api/wallet/topup/route.ts, app/api/consumer/wallet/balance/route.ts.
 *   Everything else importing directly from `@/engines/*` still works
 *   unchanged — this module is additive, not a breaking rename.
 */

import { prisma } from './prisma';
import { audit } from './audit';
import {
  getMagnusConfig,
  getFiservConfig,
  getOdooConfig,
  getWhatsAppConfig,
  getBffConfig,
  getChatwootConfig,
} from './engines';

import { getBalance, getCalls, addCredit, debitCredit } from '@/engines/magnus';
import { charge } from '@/engines/fiserv';
import { sendText, sendTemplate, sendAuthTemplate } from '@/engines/whatsapp';
import { findCustomerByPhone, createCrmLead, findOpenTasksByAssignee } from '@/engines/odoo';
import {
  upsertContact,
  getContactConversations,
  createConversation,
  addMessage,
  addPrivateNote,
} from '@/engines/chatwoot';
import { mirrorAccount, getTopupOptions, startTopup, startCallback } from '@/engines/bff';

// ── Allow-list — the ONLY operations callEngine can invoke ──────────────────
// Adding an op here is what makes it callable through callEngine at all; the
// generic types below are derived FROM this object, so there is exactly one
// place to edit to allow-list (or de-allow-list) an operation.

const ALLOW_LIST = {
  magnus: { getBalance, getCalls, addCredit, debitCredit },
  fiserv: { charge },
  whatsapp: { sendText, sendTemplate, sendAuthTemplate },
  odoo: { findCustomerByPhone, createCrmLead, findOpenTasksByAssignee },
  chatwoot: {
    upsertContact,
    getContactConversations,
    createConversation,
    addMessage,
    addPrivateNote,
  },
  bff: { mirrorAccount, getTopupOptions, startTopup, startCallback },
} as const;

export type EngineName = keyof typeof ALLOW_LIST;
export type OpName<E extends EngineName> = keyof (typeof ALLOW_LIST)[E];

type OpFn<E extends EngineName, O extends OpName<E>> = (typeof ALLOW_LIST)[E][O];
type OpArgs<E extends EngineName, O extends OpName<E>> =
  OpFn<E, O> extends (config: any, ...rest: infer R) => any ? R : never;
type OpReturn<E extends EngineName, O extends OpName<E>> =
  OpFn<E, O> extends (...a: any[]) => infer R ? Awaited<R> : never;

// ── Tenant scope — mirrors AuditLog's existing dual-FK invariant ────────────

export type TenantScope = { tenantId: string; consumerAccountId?: never } | { consumerAccountId: string; tenantId?: never };

export interface CallEngineOptions {
  tenant: TenantScope;
  /** User.id, "system", or "agent:<agent_id>" — defaults to "system". */
  actorId?: string;
  /** Idempotency key, threaded straight into the AuditLog row. */
  requestId?: string;
  entity?: string;
  entityId?: string;
  /** Pre-redacted, safe-to-log metadata merged into the AuditLog row. Never
   *  pass raw call args/results here — see module header. */
  meta?: Record<string, unknown>;
}

export class EngineOpNotAllowedError extends Error {
  constructor(engine: string, op: string) {
    super(`callEngine: "${op}" is not an allow-listed operation for engine "${engine}"`);
    this.name = 'EngineOpNotAllowedError';
  }
}

export class EngineTenantScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EngineTenantScopeError';
  }
}

function assertTenantScope(tenant: TenantScope): void {
  const hasTenantId = !!tenant.tenantId;
  const hasConsumerAccountId = !!tenant.consumerAccountId;
  if (hasTenantId === hasConsumerAccountId) {
    throw new EngineTenantScopeError(
      'callEngine requires exactly one of tenant.tenantId or tenant.consumerAccountId',
    );
  }
}

async function resolveConfig(engine: EngineName, tenant: TenantScope): Promise<unknown> {
  switch (engine) {
    case 'magnus':
      return getMagnusConfig();
    case 'fiserv':
      return getFiservConfig();
    case 'odoo':
      return getOdooConfig();
    case 'whatsapp':
      return getWhatsAppConfig();
    case 'bff':
      return getBffConfig();
    case 'chatwoot': {
      if (!tenant.tenantId) {
        throw new EngineTenantScopeError(
          'callEngine: chatwoot requires tenant.tenantId (per-tenant ChatwootBinding) — consumerAccountId scope is not supported for this engine',
        );
      }
      const binding = await prisma.chatwootBinding.findUnique({ where: { tenant_id: tenant.tenantId } });
      if (!binding) {
        throw new Error(`callEngine: no ChatwootBinding configured for tenant ${tenant.tenantId}`);
      }
      return getChatwootConfig(binding);
    }
  }
}

/**
 * The one interface every /engines/ call goes through: allow-listed,
 * tenant-scoped, audited. See module header for the full contract.
 */
export async function callEngine<E extends EngineName, O extends OpName<E>>(
  engine: E,
  op: O,
  args: OpArgs<E, O>,
  opts: CallEngineOptions,
): Promise<OpReturn<E, O>> {
  assertTenantScope(opts.tenant);

  const engineOps = ALLOW_LIST[engine];
  const fn = engineOps ? (engineOps as Record<string, unknown>)[op as string] : undefined;
  if (typeof fn !== 'function') {
    throw new EngineOpNotAllowedError(engine, String(op));
  }

  const config = await resolveConfig(engine, opts.tenant);
  const actorId = opts.actorId ?? 'system';
  const action = `${engine}.${String(op)}`;
  const auditBase = {
    ...(opts.tenant.tenantId ? { tenantId: opts.tenant.tenantId } : { consumerAccountId: opts.tenant.consumerAccountId! }),
    actorId,
    action,
    entity: opts.entity,
    entityId: opts.entityId,
    requestId: opts.requestId,
  };

  try {
    const result = await (fn as (config: unknown, ...rest: unknown[]) => Promise<unknown>)(config, ...(args as unknown[]));
    await audit({ ...auditBase, meta: { ok: true, ...(opts.meta ?? {}) } });
    return result as OpReturn<E, O>;
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown error';
    await audit({ ...auditBase, meta: { ok: false, error: message, ...(opts.meta ?? {}) } });
    throw err;
  }
}
