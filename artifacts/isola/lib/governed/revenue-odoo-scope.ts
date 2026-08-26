/**
 * revenue-odoo-scope@1 — explicit tenant Odoo binding, no global fallback,
 * plus an AUTHORITATIVE company-scope proof for `revenue.followup.set`.
 *
 * Per Port decision `dec-pr80-odoo-scope-idempotency-and-read-contract-2026-08-06`
 * (correction 1): `lib/engine-bindings.ts`'s `resolveOdooConfigForTenant` is the
 * existing tenant-scoped resolver used by `lib/customer-tools/follow-up.ts` and
 * others — but it SILENTLY FALLS BACK to the platform-default env config
 * (`getOdooConfig()`) when a tenant has no `OdooBinding` row. That fallback is
 * exactly right for those callers (read-mostly tools against a shared demo/
 * platform Odoo are an acceptable default) and is UNCHANGED here — this file
 * wraps it with a STRICTER check for this one write, rather than weakening the
 * shared helper for everyone else.
 *
 * TWO THINGS THIS MODULE PROVES, NEITHER BY ASSUMPTION
 * ------------------------------------------------------
 * 1. AN EXPLICIT BINDING EXISTS. `resolveOdooScope` first reads
 *    `OdooBinding` directly — if the tenant has no row, this returns `null`
 *    and the caller must fail closed. `resolveOdooConfigForTenant` is only
 *    ever called AFTER that row is confirmed to exist, so it is guaranteed to
 *    use the binding, never the fallback, for this write.
 * 2. THE OPPORTUNITY BELONGS TO THE BOUND COMPANY. Odoo's `OdooBinding` has no
 *    `company_id` column (adding one is a migration, out of scope here). What
 *    it DOES have is `login` — the Odoo user whose API key is stored — and in
 *    Odoo every `res.users` row carries exactly one default `company_id`. So
 *    the bound company is read from Odoo itself (`res.users` for `login`), and
 *    a target `crm.lead`'s OWN `company_id` field is read directly from Odoo
 *    (never assumed, never "found means owned") and compared. Two tenants
 *    sharing one physical Odoo database (same `url`+`db`, different `login` /
 *    different bound company) are told apart by this real comparison, not by
 *    "a record with this id exists somewhere."
 *
 * FAIL CLOSED, NOT BEST-EFFORT
 * -----------------------------
 * No binding row -> null. Binding row with no `login` set -> null (there is
 * no way to prove a specific bound company without a specific bound user,
 * and guessing is exactly the "helper that just returns yes whenever a
 * record exists" this decision forbids). `res.users` lookup fails or returns
 * no company -> null. Every null propagates to a PERMISSION_DENIED / refused
 * write in lib/governed/revenue-mcp-actions.ts — never a fallback to "assume
 * it's fine."
 *
 * ONE ADAPTER FOR READ-BEFORE-WRITE, WRITE, AND READBACK
 * ---------------------------------------------------------
 * `resolveOdooScope`'s `config` is the ONE `OdooConfig` used to: read the
 * lead's `company_id` (this file), execute `updateLead`/`scheduleFollowup`,
 * and read back the result (both via the `RecordSystem` built from this same
 * `config` in revenue-mcp-actions.ts). No second, independently-resolved
 * config can ever exist for one governed call — see that file's
 * `lazyRecordSystem`.
 */

import { json2Call, type OdooConfig } from '@/engines/odoo'
import { prisma } from '@/lib/prisma'
import { decryptSecret } from '@/lib/tenant-secrets'

export interface OdooScope {
  config: OdooConfig
  /** Read from `res.users.company_id` for the binding's own `login` — never assumed. */
  boundCompanyId: number
}

/** A many2one arrives as `[id, name]` (classic) or `{id, display_name}` (JSON-2). */
function m2oId(v: unknown): number | null {
  if (Array.isArray(v) && typeof v[0] === 'number') return v[0]
  if (v && typeof v === 'object' && typeof (v as { id?: unknown }).id === 'number') {
    return (v as { id: number }).id
  }
  return null
}

function firstRow(v: unknown): Record<string, unknown> | null {
  const rows = Array.isArray(v)
    ? v
    : v && typeof v === 'object' && Array.isArray((v as { records?: unknown }).records)
      ? (v as { records: unknown[] }).records
      : []
  const row = rows[0]
  return row && typeof row === 'object' ? (row as Record<string, unknown>) : null
}

export interface OdooScopePorts {
  /** Resolves the explicit tenant binding + proven bound company id, or `null` — fail closed. */
  resolveOdooScope(tenantId: string): Promise<OdooScope | null>
  /** Reads a crm.lead's OWN `company_id` directly from Odoo. `null` = not found / unreadable. */
  readLeadCompanyId(config: OdooConfig, leadId: string): Promise<number | null>
}

async function defaultResolveOdooScope(tenantId: string): Promise<OdooScope | null> {
  const binding = await prisma.odooBinding.findUnique({ where: { tenant_id: tenantId } })
  if (!binding) return null // no explicit binding at all -> fail closed, never the platform default

  const login = (binding.login ?? '').trim()
  if (!login) return null // no specific bound user -> no provable company scope

  const config: OdooConfig = {
    url: binding.url,
    db: binding.db,
    apiKey: decryptSecret(binding.api_key_enc),
  }

  let row: Record<string, unknown> | null
  try {
    const res = await json2Call(config, 'res.users', 'search_read', {
      domain: [['login', '=', login]],
      fields: ['id', 'company_id'],
      limit: 1,
    })
    row = firstRow(res)
  } catch {
    return null // Odoo unreachable / refused -> fail closed, not "assume ok"
  }
  if (!row) return null

  const boundCompanyId = m2oId(row.company_id)
  if (boundCompanyId === null) return null

  return { config, boundCompanyId }
}

async function defaultReadLeadCompanyId(config: OdooConfig, leadId: string): Promise<number | null> {
  const id = Number(leadId)
  if (!Number.isFinite(id)) return null
  let row: Record<string, unknown> | null
  try {
    const res = await json2Call(config, 'crm.lead', 'search_read', {
      domain: [['id', '=', id]],
      fields: ['id', 'company_id'],
      limit: 1,
    })
    row = firstRow(res)
  } catch {
    return null
  }
  if (!row) return null
  return m2oId(row.company_id)
}

export const DEFAULT_ODOO_SCOPE_PORTS: OdooScopePorts = {
  resolveOdooScope: defaultResolveOdooScope,
  readLeadCompanyId: defaultReadLeadCompanyId,
}
