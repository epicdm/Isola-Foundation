/**
 * internal-domain.ts — the no-defaults binding for EPIC's INTERNAL agent domain.
 *
 * `dec-one-clawith-runtime-two-isolated-domains-2026-07-30` makes Clawith the
 * only agent runtime and Foundation the only governance and production-action
 * layer. It also removes every convenience this codebase used to lean on:
 *
 *     No defaults. No earliest-created number. No prompt-supplied identity.
 *     No implicit tenant or agent.
 *
 * That sentence is the whole reason this module exists as a RESOLVER rather
 * than a set of constants. Every one of those four conveniences has already
 * caused a real defect here: the earliest-created number sent a staff message
 * from the CUSTOMER 6737 line, and an implicit tenant is what
 * `resolveStaffChannel` was written to stop. So each element of the binding is
 * resolved explicitly and every missing element is a NAMED REFUSAL — never a
 * fallback, never a guess.
 *
 * A refusal is returned, not thrown: there is a staff member on a handset and
 * the caller needs a reply path for every outcome, including "this tenant has
 * no internal workspace configured yet".
 */

import type { StaffBindingRow } from './inbound-routing'

/** The two isolated agent domains. There is no third and no default. */
export const AGENT_DOMAINS = ['internal', 'external'] as const
export type AgentDomain = (typeof AGENT_DOMAINS)[number]

/** Role vocabulary for the internal domain. Mirrors StaffBinding.role. */
export type InternalRole = 'staff' | 'manager' | 'owner'

/* ── Configuration keys ─────────────────────────────────────────────────────
 *
 * Named as constants rather than inlined so a test can assert the exact key an
 * operator must set, and so a typo in one of them fails a test instead of
 * silently resolving to `undefined` and taking a fallback that no longer
 * exists.
 */
export const INTERNAL_WORKSPACE_ENV = 'CLAWITH_INTERNAL_WORKSPACE_ID'
export const INTERNAL_AGENT_ENV_BY_ROLE: Readonly<Record<InternalRole, string>> = {
  owner: 'CLAWITH_INTERNAL_OWNER_AGENT_ID',
  manager: 'CLAWITH_INTERNAL_MANAGER_AGENT_ID',
  staff: 'CLAWITH_INTERNAL_STAFF_AGENT_ID',
}
/** The internal WhatsApp number. Same key the drain and the reply path pin to. */
export const INTERNAL_PHONE_NUMBER_ENV = 'STAFF_NOTIFICATION_PHONE_NUMBER_ID'

/**
 * Customer-facing numbers, hardcoded as a FLOOR.
 *
 * `278390858690809` is EPIC 295-6737 — the number customers talk to, and the
 * tenant's earliest-created `WhatsAppNumber`, which is exactly why it kept
 * being reached by accident. Listing it here means the internal domain refuses
 * it even if an operator sets `STAFF_NOTIFICATION_PHONE_NUMBER_ID` to it by
 * mistake. Configuration can ADD customer numbers to this set; it cannot
 * remove 6737 from it.
 */
const CUSTOMER_PHONE_NUMBER_IDS_FLOOR: readonly string[] = ['278390858690809']
export const CUSTOMER_PHONE_NUMBER_IDS_ENV = 'CUSTOMER_PHONE_NUMBER_IDS'

export function customerPhoneNumberIds(env: NodeJS.ProcessEnv = process.env): ReadonlySet<string> {
  return new Set([
    ...CUSTOMER_PHONE_NUMBER_IDS_FLOOR,
    ...(env[CUSTOMER_PHONE_NUMBER_IDS_ENV]?.split(',').map((s) => s.trim()).filter(Boolean) ?? []),
  ])
}

/**
 * The governed tool surface, per role, for the INTERNAL domain.
 *
 * Advisory to the agent and MANDATORY at the tool boundary: the staff-ops
 * surface re-checks the actor against Odoo on every write regardless of what
 * the model asked for. Prompt text is not a permission system and is not used
 * as one here — this list decides what may be OFFERED; Odoo decides what may
 * be DONE.
 *
 * Deliberately disjoint from the customer tool surface (`crm.*` on the
 * external domain). The two sets share no member, so "a customer agent called
 * an internal tool" is not a policy failure to detect at runtime — it is a
 * name that does not exist in that domain's list.
 */
const INTERNAL_TOOLS_STAFF: readonly string[] = [
  'staff.work.list',
  'staff.work.get',
  'staff.work.update',
  'staff.work.block',
  'staff.work.done',
  'staff.followup.create',
  'staff.note.create',
  'staff.manager.review.request',
]
const INTERNAL_TOOLS_MANAGER: readonly string[] = [
  ...INTERNAL_TOOLS_STAFF,
  'staff.team.work.list',
  'staff.team.overdue.list',
  'staff.verification.list',
  'staff.verification.approve',
  'staff.verification.return',
]
const INTERNAL_TOOLS_OWNER: readonly string[] = [
  ...INTERNAL_TOOLS_MANAGER,
  'ops.brief.read',
  'ops.support.read',
  'ops.network.read',
  'finance.receivables.read',
  'crm.pipeline.read',
]

export function permittedToolsForRole(role: InternalRole): readonly string[] {
  switch (role) {
    case 'owner':
      return INTERNAL_TOOLS_OWNER
    case 'manager':
      return INTERNAL_TOOLS_MANAGER
    case 'staff':
      return INTERNAL_TOOLS_STAFF
  }
}

export type InternalBindingRefusal =
  | 'no_tenant'
  | 'no_binding'
  | 'binding_inactive'
  | 'cross_tenant'
  | 'no_whatsapp_identity'
  | 'internal_number_unset'
  | 'wrong_number'
  | 'customer_number_refused'
  | 'workspace_unset'
  | 'agent_unset'

/** Everything a governed call must carry. No element is optional. */
export interface InternalDomainBinding {
  tenantId: string
  domain: 'internal'
  bindingId: string
  waId: string
  odooResUserId: number
  displayName: string
  role: InternalRole
  managerOdooResUserId: number | null
  clawithWorkspaceId: string
  clawithAgentId: string
  phoneNumberId: string
  permittedTools: readonly string[]
}

export type InternalDomainResolution =
  | { ok: true; binding: InternalDomainBinding }
  | { ok: false; refusal: InternalBindingRefusal; detail: string }

/**
 * Resolve one inbound internal-domain request to its complete binding.
 *
 * Order is deliberate: identity first, then channel, then runtime. An unknown
 * sender must be refused before this function reads any configuration, so a
 * misconfiguration can never be reported to a stranger, and the refusal an
 * operator sees names the FIRST thing that was wrong rather than the last.
 */
export function resolveInternalDomainBinding(input: {
  tenantId: string
  binding: StaffBindingRow | null | undefined
  phoneNumberId: string
  env?: NodeJS.ProcessEnv
}): InternalDomainResolution {
  const env = input.env ?? process.env
  const tenantId = (input.tenantId ?? '').trim()
  if (!tenantId) return { ok: false, refusal: 'no_tenant', detail: 'no tenant on this channel' }

  const b = input.binding
  if (!b) return { ok: false, refusal: 'no_binding', detail: 'sender is not an enrolled staff member' }
  if (b.active === false) return { ok: false, refusal: 'binding_inactive', detail: 'binding is inactive' }
  if (b.tenantId !== tenantId) {
    return { ok: false, refusal: 'cross_tenant', detail: 'binding belongs to a different tenant' }
  }
  const waId = (b.waId ?? '').replace(/\D/g, '')
  if (!waId) return { ok: false, refusal: 'no_whatsapp_identity', detail: 'binding has no wa_id' }

  // ── Channel. The number is part of the identity, not a transport detail. ──
  const internalNumber = (env[INTERNAL_PHONE_NUMBER_ENV] ?? '').trim()
  if (!internalNumber) {
    return { ok: false, refusal: 'internal_number_unset', detail: `${INTERNAL_PHONE_NUMBER_ENV} is not set` }
  }
  if (customerPhoneNumberIds(env).has(internalNumber)) {
    // The configured "internal" number is a customer number. Refuse rather
    // than serve internal data on a line customers can reach.
    return {
      ok: false,
      refusal: 'customer_number_refused',
      detail: `${INTERNAL_PHONE_NUMBER_ENV} names a customer-facing number`,
    }
  }
  const phoneNumberId = (input.phoneNumberId ?? '').trim()
  if (customerPhoneNumberIds(env).has(phoneNumberId)) {
    return { ok: false, refusal: 'customer_number_refused', detail: 'request arrived on a customer number' }
  }
  if (phoneNumberId !== internalNumber) {
    return { ok: false, refusal: 'wrong_number', detail: 'request did not arrive on the internal number' }
  }

  // ── Runtime. Explicit workspace, explicit per-role agent, or refuse. ──────
  const clawithWorkspaceId = (env[INTERNAL_WORKSPACE_ENV] ?? '').trim()
  if (!clawithWorkspaceId) {
    return { ok: false, refusal: 'workspace_unset', detail: `${INTERNAL_WORKSPACE_ENV} is not set` }
  }
  const role: InternalRole = b.role === 'owner' ? 'owner' : b.role === 'manager' ? 'manager' : 'staff'
  const agentEnvKey = INTERNAL_AGENT_ENV_BY_ROLE[role]
  const clawithAgentId = (env[agentEnvKey] ?? '').trim()
  if (!clawithAgentId) {
    return { ok: false, refusal: 'agent_unset', detail: `${agentEnvKey} is not set` }
  }

  return {
    ok: true,
    binding: {
      tenantId,
      domain: 'internal',
      bindingId: b.id,
      waId,
      odooResUserId: b.odooResUserId,
      displayName: b.displayName,
      role,
      managerOdooResUserId: b.managerOdooResUserId,
      clawithWorkspaceId,
      clawithAgentId,
      phoneNumberId,
      permittedTools: permittedToolsForRole(role),
    },
  }
}
