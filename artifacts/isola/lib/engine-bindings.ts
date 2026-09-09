/**
 * engine-bindings.ts — per-tenant binding resolution shared by:
 *   - lib/connector.ts's resolveConfig() (the governed callEngine() path)
 *   - the few call sites that talk to Odoo directly via the raw json2Call
 *     primitive (lib/agent-tools.ts, app/api/crm/customer/route.ts) — see
 *     connector.ts's module header "NOT WRAPPED" section for why those
 *     json2Call model/method calls are deliberately outside ALLOW_LIST.
 *
 * Resolution strategy for all three: if the tenant has a binding row, its
 * fields are merged over (take precedence over) the platform-default env
 * config; secrets are decrypted with TENANT_MASTER_KEY. If the tenant has no
 * binding row, the platform-default env config is used unchanged — additive,
 * non-breaking.
 *
 * A WRITE INHERITS NOTHING
 * ------------------------
 * The paragraph above is the rule for READS, and it stays the rule for reads.
 * It is NOT the rule for writes, and the difference is not a matter of degree.
 *
 * A read that falls back to the deployment default shows somebody data. A
 * write that falls back to the deployment default puts a durable,
 * customer-visible record into a business's system of record that nobody
 * chose — and it does it silently, because a fallback has no failure to
 * report. The tenant whose system of record is about to change must be named
 * by a binding row, never by the deployment's default connection.
 *
 * MEASURED 2026-09-09 on the deployed UAT Foundation: OdooBinding held ZERO
 * rows (control: Tenant held five, so the database was populated and the zero
 * was real), while ODOO_URL/ODOO_DB on that same deployment named EPIC's
 * PRODUCTION Odoo. Every write routed through the read resolver on that
 * deployment was therefore addressed at a live business's records. Nobody had
 * exercised it, which is luck, not a guard.
 *
 * So writes resolve through resolveOdooConfigForTenantWrite() below, which
 * REFUSES rather than falling back. The refusal is a named outcome
 * (OdooBindingRequiredError, code 'tenant_not_bound') so a caller can tell it
 * apart from an Odoo that could not be reached — those need opposite
 * responses from whoever reads the screen: one is retryable, this one is not
 * and needs a person to bind the tenant.
 */

import { prisma } from './prisma';
import { decryptSecret } from './tenant-secrets';
import { getOdooConfig, getFiservConfig, getBffConfig } from './engines';
import type { OdooConfig } from '@/engines/odoo';
import type { FiservConfig } from '@/engines/fiserv';
import type { BffConfig } from '@/engines/bff';

export async function resolveOdooConfigForTenant(tenantId?: string | null): Promise<OdooConfig> {
  if (tenantId) {
    const binding = await prisma.odooBinding.findUnique({ where: { tenant_id: tenantId } });
    if (binding) {
      return getOdooConfig({ url: binding.url, db: binding.db, apiKey: decryptSecret(binding.api_key_enc) });
    }
  }
  return getOdooConfig();
}

/**
 * The reason a write was refused, as a value rather than as prose.
 *
 * One constant, so the routes that report this refusal and the tests that
 * assert on it are naming the same thing rather than two strings that happen
 * to match today.
 */
export const TENANT_NOT_BOUND = 'tenant_not_bound' as const;

/**
 * A write was asked for and the destination could not be named.
 *
 * NOT an outage. Odoo was never contacted, was never at fault, and retrying
 * the identical request will be refused identically until somebody creates the
 * binding row. Callers that flatten this into "could not reach the system"
 * tell the reader to try again forever.
 */
export class OdooBindingRequiredError extends Error {
  /** Structural marker, so the refusal survives a module boundary. */
  readonly code = TENANT_NOT_BOUND;
  readonly tenantId: string | null;

  constructor(tenantId: string | null, detail: string) {
    super(detail);
    this.name = 'OdooBindingRequiredError';
    this.tenantId = tenantId;
  }
}

/**
 * Recognise the refusal.
 *
 * Structural on `code` rather than `instanceof`, deliberately: a bundler that
 * gives a route and this module two copies of the class would make
 * `instanceof` false and quietly turn an honest refusal back into a generic
 * failure — which is the exact class of silence this whole change exists to
 * remove.
 */
export function isOdooBindingRequiredError(err: unknown): err is OdooBindingRequiredError {
  return !!err && typeof err === 'object' && (err as { code?: unknown }).code === TENANT_NOT_BOUND;
}

/**
 * The Odoo connection a WRITE for this tenant is allowed to use.
 *
 * Refuses in three places, and each one is a way a write could otherwise end
 * up somewhere nobody chose:
 *
 *   1. no tenant id           — an unattributed write has no destination at
 *                               all; the deployment default is not one.
 *   2. no OdooBinding row     — the measured case. The tenant exists and has
 *                               never been bound to a system of record.
 *   3. a half-filled row      — a binding that names a url but no database
 *                               (or the reverse) would have its missing half
 *                               supplied from the environment by
 *                               getOdooConfig(), which is the same defect one
 *                               level down. Both halves, or neither.
 *
 * getOdooConfig() is only ever called here with url, db AND apiKey supplied,
 * so no field of the returned config can come from the deployment's env.
 *
 * Reads must keep using resolveOdooConfigForTenant above. This function is not
 * a stricter version of it to be adopted everywhere — it is the door for the
 * calls that change somebody's records.
 */
export async function resolveOdooConfigForTenantWrite(
  tenantId?: string | null,
): Promise<OdooConfig> {
  const id = (tenantId ?? '').trim();
  if (!id) {
    throw new OdooBindingRequiredError(
      null,
      'a write must name its tenant: no tenant id reached the Odoo resolver, and a write may not fall back to the deployment default connection',
    );
  }

  const binding = await prisma.odooBinding.findUnique({ where: { tenant_id: id } });
  if (!binding) {
    throw new OdooBindingRequiredError(
      id,
      `tenant ${id} has no OdooBinding row, so there is no system of record this write may be addressed to`,
    );
  }

  const url = (binding.url ?? '').trim();
  const db = (binding.db ?? '').trim();
  if (!url || !db) {
    throw new OdooBindingRequiredError(
      id,
      `tenant ${id}'s OdooBinding does not name both a url and a database; the missing half must not be filled in from the deployment default`,
    );
  }

  const apiKey = decryptSecret(binding.api_key_enc);
  if (!apiKey) {
    throw new OdooBindingRequiredError(
      id,
      `tenant ${id}'s OdooBinding carries no usable credential; a write must not proceed on the deployment's own key`,
    );
  }

  return getOdooConfig({ url, db, apiKey });
}

export async function resolveFiservConfigForTenant(tenantId?: string | null): Promise<FiservConfig> {
  if (tenantId) {
    const binding = await prisma.fiservBinding.findUnique({ where: { tenant_id: tenantId } });
    if (binding) {
      return getFiservConfig({
        apiKey: decryptSecret(binding.api_key_enc),
        baseUrl: binding.base_url ?? undefined,
      });
    }
  }
  return getFiservConfig();
}

export async function resolveBffConfigForTenant(tenantId?: string | null): Promise<BffConfig> {
  if (tenantId) {
    const binding = await prisma.bffBinding.findUnique({ where: { tenant_id: tenantId } });
    if (binding) {
      return getBffConfig({
        baseUrl: binding.base_url,
        internalSecret: decryptSecret(binding.internal_secret_enc),
      });
    }
  }
  return getBffConfig();
}
