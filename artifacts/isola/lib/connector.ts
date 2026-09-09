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
 *   wires each engine's config as: platform-default env config (via the
 *   existing getXConfig() factories in lib/engines.ts), merged with the
 *   tenant's binding row when one exists, decrypting secrets with
 *   TENANT_MASTER_KEY (lib/tenant-secrets.ts). A tenant with no binding row
 *   falls through to the platform default unchanged — additive, non-breaking.
 *     - magnus: no binding table — genuinely global infra; per-tenant
 *       identity flows through Tenant.magnus_* / VoiceLine as call args, not
 *       config (see engines/magnus.ts).
 *     - fiserv/odoo/bff: FiservBinding/OdooBinding/BffBinding (tenant_id-keyed,
 *       see lib/engine-bindings.ts) merged over env when tenant.tenantId is
 *       set; consumerAccountId-scoped calls always use the platform default
 *       (these bindings are tenant-keyed only).
 *     - whatsapp: requires tenant.tenantId; resolves the tenant's
 *       WhatsAppNumber row (opts.whatsappNumberId picks a specific number
 *       when a tenant has more than one, else the oldest) — this replaces the
 *       side-channel token_env/access_token resolution that used to live
 *       directly in lib/agent.ts and lib/agent-tools.ts.
 *     - chatwoot: requires tenant.tenantId; looks up that tenant's
 *       ChatwootBinding row (no env fallback — always fully tenant-sourced).
 *
 *   EXCEPT FOR THE ODOO OPS THAT WRITE (2026-09-09). The paragraph above is
 *   the rule for reads and stays the rule for reads. `odoo` is the one engine
 *   whose allow-list is MIXED: `createCrmLead` changes a business's CRM, while
 *   `findCustomerByPhone` and `findOpenTasksByAssignee` only look. Resolving
 *   one config per ENGINE meant the write inherited the read's fallback, so on
 *   a tenant with no OdooBinding row an AI-originated lead was created in
 *   whatever ODOO_URL the deployment named — measured on UAT 2026-09-09: zero
 *   binding rows, and that env naming EPIC's PRODUCTION Odoo.
 *
 *   So resolveConfig() takes the OP as well as the engine, and ODOO_WRITE_OPS
 *   below names the ones that go through the write door
 *   (resolveOdooConfigForTenantWrite), which REFUSES an unbound tenant instead
 *   of falling back. The set is declared beside ALLOW_LIST on purpose: adding a
 *   write to one and forgetting the other is the mistake worth making hard to
 *   miss.
 *
 *   A consumerAccountId-scoped odoo WRITE therefore now refuses too, where
 *   before it silently used the platform default. That default is exactly the
 *   connection a write may not inherit, and there is no such call site today.
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
 * MIGRATION STATUS (2026-07-16, S2)
 *   Call sites migrate to callEngine() incrementally, one PR-reviewable
 *   change at a time, with no behavior change beyond the added AuditLog row
 *   (and, as of S2, real per-tenant credential resolution where a binding
 *   exists). Migrated so far: app/api/wallet/balance/route.ts,
 *   app/api/wallet/topup/route.ts, app/api/consumer/wallet/balance/route.ts,
 *   lib/workspace-queue.ts, lib/workspace-item-detail.ts,
 *   app/api/crm/customer/route.ts, lib/agent.ts (WhatsApp reply send),
 *   lib/agent-tools.ts (wa.send — odoo.read/odoo.create_lead still call
 *   json2Call directly per "NOT WRAPPED" above, but now resolve tenant-aware
 *   config via lib/engine-bindings.ts). Remaining direct `@/engines/*`
 *   importers still work unchanged — this module is additive, not a
 *   breaking rename. Known remaining debt: lib/agent.ts's Chatwoot mirror
 *   calls (mirrorInbound, step 13) still call engines/chatwoot.ts directly
 *   — left alone in S2 because they're already tenant-correct (sourced from
 *   ChatwootBinding) and their non-throwing catch-and-log error handling
 *   doesn't map cleanly onto callEngine's throw-on-failure contract; folding
 *   them in is audit-log completeness work, not a multi-tenancy fix.
 */

import { prisma } from './prisma';
import { audit } from './audit';
import { getMagnusConfig, getWhatsAppConfig, getChatwootConfig } from './engines';
import {
  resolveOdooConfigForTenant,
  resolveOdooConfigForTenantWrite,
  resolveFiservConfigForTenant,
  resolveBffConfigForTenant,
} from './engine-bindings';

import { getBalance, getCalls, addCredit, debitCredit } from '@/engines/magnus';
import { charge } from '@/engines/fiserv';
import {
  sendText,
  sendTemplate,
  sendAuthTemplate,
  type WhatsAppConfig,
  type WhatsAppSendTextInput,
  type WhatsAppSendTemplateInput,
  type WhatsAppSendAuthTemplateInput,
} from '@/engines/whatsapp';
import { findCustomerByPhone, createCrmLead, findOpenTasksByAssignee } from '@/engines/odoo';
import {
  upsertContact,
  getContactConversations,
  createConversation,
  addMessage,
  addPrivateNote,
} from '@/engines/chatwoot';
import { mirrorAccount, getTopupOptions, startTopup, startCallback } from '@/engines/bff';

// ── WhatsApp adapters ─────────────────────────────────────────────────────────
// sendText/sendTemplate/sendAuthTemplate take phoneId/token as part of their
// `input` (not `config` — see engines/whatsapp.ts), because they vary per
// send. resolveConfig() below resolves the tenant's default phoneId/token
// onto the config object it returns; these adapters splice them in as
// defaults so callEngine callers can omit them, while an explicit
// phoneId/token in the call args still wins (e.g. a tenant with more than
// one WhatsAppNumber sending from a non-default number).

type ResolvedWhatsAppConfig = WhatsAppConfig & { phoneId: string; token: string };

function whatsappSendText(
  config: ResolvedWhatsAppConfig,
  input: Omit<WhatsAppSendTextInput, 'phoneId' | 'token'> & Partial<Pick<WhatsAppSendTextInput, 'phoneId' | 'token'>>,
) {
  return sendText(config, { ...input, phoneId: input.phoneId ?? config.phoneId, token: input.token ?? config.token });
}

function whatsappSendTemplate(
  config: ResolvedWhatsAppConfig,
  input: Omit<WhatsAppSendTemplateInput, 'phoneId' | 'token'> &
    Partial<Pick<WhatsAppSendTemplateInput, 'phoneId' | 'token'>>,
) {
  return sendTemplate(config, { ...input, phoneId: input.phoneId ?? config.phoneId, token: input.token ?? config.token });
}

function whatsappSendAuthTemplate(
  config: ResolvedWhatsAppConfig,
  input: Omit<WhatsAppSendAuthTemplateInput, 'phoneId' | 'token'> &
    Partial<Pick<WhatsAppSendAuthTemplateInput, 'phoneId' | 'token'>>,
) {
  return sendAuthTemplate(config, {
    ...input,
    phoneId: input.phoneId ?? config.phoneId,
    token: input.token ?? config.token,
  });
}

// ── Allow-list — the ONLY operations callEngine can invoke ──────────────────
// Adding an op here is what makes it callable through callEngine at all; the
// generic types below are derived FROM this object, so there is exactly one
// place to edit to allow-list (or de-allow-list) an operation.

const ALLOW_LIST = {
  magnus: { getBalance, getCalls, addCredit, debitCredit },
  fiserv: { charge },
  whatsapp: { sendText: whatsappSendText, sendTemplate: whatsappSendTemplate, sendAuthTemplate: whatsappSendAuthTemplate },
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

/**
 * The odoo ops that CHANGE a record, and therefore may not inherit their
 * destination from the deployment's env.
 *
 * Declared here, immediately under ALLOW_LIST, because the two must be edited
 * together: an op added above and forgotten here would silently get the read
 * resolver's fallback, which is the exact defect this set exists to close.
 *
 * A read is deliberately NOT in this set. `findCustomerByPhone` and
 * `findOpenTasksByAssignee` keep the platform-default fallback — that fallback
 * is how the current customer reads work and removing it would break them.
 */
const ODOO_WRITE_OPS: ReadonlySet<string> = new Set(['createCrmLead']);

const TOKEN_ENV_ALLOWLIST = /^(META_|WHATSAPP_)/;

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
  /** whatsapp only: pick a specific WhatsAppNumber when the tenant has more
   *  than one. Defaults to the tenant's oldest-created number. */
  whatsappNumberId?: string;
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

async function resolveConfig(
  engine: EngineName,
  op: string,
  tenant: TenantScope,
  opts: CallEngineOptions,
): Promise<unknown> {
  switch (engine) {
    case 'magnus':
      return getMagnusConfig();
    case 'fiserv':
      return resolveFiservConfigForTenant(tenant.tenantId);
    case 'odoo':
      // The one MIXED allow-list. A write names its tenant or it does not run;
      // a read keeps the fallback it has always had. See the module header.
      return ODOO_WRITE_OPS.has(op)
        ? resolveOdooConfigForTenantWrite(tenant.tenantId)
        : resolveOdooConfigForTenant(tenant.tenantId);
    case 'bff':
      return resolveBffConfigForTenant(tenant.tenantId);
    case 'whatsapp': {
      if (!tenant.tenantId) {
        throw new EngineTenantScopeError(
          'callEngine: whatsapp requires tenant.tenantId (per-tenant WhatsAppNumber) — consumerAccountId scope is not supported for this engine',
        );
      }
      const waNumber = opts.whatsappNumberId
        ? await prisma.whatsAppNumber.findUnique({ where: { id: opts.whatsappNumberId } })
        : await prisma.whatsAppNumber.findFirst({
            where: { tenant_id: tenant.tenantId },
            orderBy: { created_at: 'asc' },
          });
      if (!waNumber || waNumber.tenant_id !== tenant.tenantId) {
        throw new Error(`callEngine: no WhatsAppNumber configured for tenant ${tenant.tenantId}`);
      }
      let token: string;
      if (waNumber.token_env) {
        if (!TOKEN_ENV_ALLOWLIST.test(waNumber.token_env)) {
          throw new Error(
            `callEngine: token_env "${waNumber.token_env}" rejected — must start with META_ or WHATSAPP_`,
          );
        }
        const resolved = process.env[waNumber.token_env];
        if (!resolved) {
          throw new Error(
            `callEngine: token_env "${waNumber.token_env}" is set but env var is empty or missing`,
          );
        }
        token = resolved;
      } else {
        token = waNumber.access_token;
      }
      return { ...getWhatsAppConfig(), phoneId: waNumber.phone_number_id, token };
    }
    case 'chatwoot': {
      if (!tenant.tenantId) {
        throw new EngineTenantScopeError(
          'callEngine: chatwoot requires tenant.tenantId (per-tenant ChatwootBinding) — consumerAccountId scope is not supported for this engine',
        );
      }
      const binding = await prisma.chatwootBinding.findFirst({ where: { tenant_id: tenant.tenantId } });
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

  const config = await resolveConfig(engine, String(op), opts.tenant, opts);
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
