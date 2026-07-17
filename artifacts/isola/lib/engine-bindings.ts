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
