/**
 * odoo-staff.ts — hr.employee roster reader (S8 onboarding).
 *
 * Thin, read-only helper built on the portable JSON-2 transport in odoo.ts.
 * Used by the internal/operator onboarding flow to read a tenant's real staff
 * roster from its OWN Odoo (resolved via the governed OdooBinding — see
 * lib/engine-bindings.ts resolveOdooConfigForTenant / S2), never a hardcoded
 * or shared credential.
 *
 * Verified live 2026-07-17 against epic-communications-inc.odoo.com:
 *   POST {url}/json/2/hr.employee/search_read → 200, 8 employees.
 */

import { json2Call, type OdooConfig } from './odoo'

export interface OdooStaff {
  id: number
  name: string
  jobTitle: string | null
  workEmail: string | null
  workPhone: string | null
  department: string | null
}

interface OdooStaffRow {
  id: number
  name: string
  job_title: unknown
  work_email: unknown
  work_phone: unknown
  department_id: unknown
}

/** Odoo many2one comes back as [id, name] (classic) or {id, display_name}
 *  (JSON-2) depending on server version — normalize both shapes. */
function displayNameOf(value: unknown): string | null {
  if (!value) return null
  if (Array.isArray(value)) return typeof value[1] === 'string' ? value[1] : null
  if (typeof value === 'object' && 'display_name' in (value as Record<string, unknown>)) {
    const v = (value as { display_name?: unknown }).display_name
    return typeof v === 'string' ? v : null
  }
  return null
}

function strOrNull(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v : null
}

/**
 * listStaff — hr.employee search_read via json2Call. Default (empty) domain
 * returns active employees only (Odoo active_test). Returns [] on any failure
 * — callers treat Odoo as best-effort and must not 500 because Odoo is
 * unreachable. Capped at 200 rows (defense-in-depth; a roster is small).
 */
export async function listStaff(config: OdooConfig, limit = 100): Promise<OdooStaff[]> {
  const rows = (await json2Call(config, 'hr.employee', 'search_read', {
    domain: [],
    fields: ['id', 'name', 'job_title', 'work_email', 'work_phone', 'department_id'],
    order: 'name asc',
    limit: Math.min(limit, 200),
  }, 15000).catch(() => [])) as OdooStaffRow[]

  return (rows ?? []).map((r) => ({
    id: r.id,
    name: r.name,
    jobTitle: strOrNull(r.job_title),
    workEmail: strOrNull(r.work_email),
    workPhone: strOrNull(r.work_phone),
    department: displayNameOf(r.department_id),
  }))
}
