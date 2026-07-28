/**
 * inbound-routing.ts — pure decision core for "a staff member just messaged us".
 *
 * Two jobs, both fail-closed:
 *   1. Resolve the sender to exactly one active StaffBinding, or refuse.
 *   2. Decide what that message is: a staff action, a request for help, or
 *      something Foundation should not act on.
 *
 * ── The three failures this module exists to not repeat ─────────────────────
 *
 * (a) OWNER-PRINCIPAL SHADOWING. In BFF, the owner branch resolved first and
 *     returned unconditionally, so a person who was BOTH the owner and active
 *     staff — which the actual operator is — could never have an ACK recorded;
 *     the business-query brain answered instead
 *     (`ev-staff-inbound-ack-routing-2026-07-27` §1). Here, an explicit staff
 *     command OUTRANKS every other role the sender holds. Dual-role is the
 *     normal case, not the edge case, and it is encoded in the tests.
 *
 * (b) THE UNWRAPPED ENVELOPE. `isKnownStaff: Boolean(staffRow)` tested a
 *     `{ ok, data }` wrapper that is truthy for everyone, so every stranger was
 *     classified as staff and the non-staff branch became unreachable for all
 *     senders (`defect-staff-detection-unwrap-and-active-2026-07-28`). This
 *     module takes an explicit array of binding ROWS. There is no envelope to
 *     forget to unwrap, and the type does not permit one.
 *
 * (c) NO ACTIVE FILTER. An inactive row resolved as staff. Here `active` is
 *     checked in the resolver itself, and an inactive-only match is reported as
 *     its own outcome rather than being folded into "unknown" — an operator
 *     needs to tell "never heard of them" apart from "we deactivated them".
 */

import {
  parseStaffCommand,
  type OpenWorkRefCandidate,
  type StaffActionKind,
} from './staff-action'

export interface StaffBindingRow {
  id: string
  tenantId: string
  odooResUserId: number
  displayName: string
  waId: string | null
  role: string // staff | manager | owner
  active: boolean
  managerOdooResUserId: number | null
}

export type StaffIdentityResolution =
  | { resolved: true; binding: StaffBindingRow }
  | {
      resolved: false
      reason: 'unknown_sender' | 'inactive_binding' | 'ambiguous_binding' | 'cross_tenant'
      /** Present for ambiguous/cross-tenant so an operator exception can name them. */
      candidates?: StaffBindingRow[]
    }

/**
 * Resolve a Meta sender id to exactly one active StaffBinding.
 *
 * `candidates` is every binding row whose waId matches the sender, across all
 * tenants — the caller must NOT pre-filter by tenant, because a number bound in
 * two tenants is a cross-tenant exposure that has to be seen to be refused.
 *
 * `expectedTenantId`, when supplied, is the tenant that owns the inbound
 * channel. A match in a different tenant is refused as `cross_tenant` rather
 * than accepted, even when it is the only match.
 */
export function resolveStaffIdentity(
  candidates: StaffBindingRow[],
  expectedTenantId?: string | null,
): StaffIdentityResolution {
  if (!candidates || candidates.length === 0) {
    return { resolved: false, reason: 'unknown_sender' }
  }

  const active = candidates.filter((c) => c.active)
  if (active.length === 0) {
    return { resolved: false, reason: 'inactive_binding', candidates }
  }

  const distinctTenants = new Set(active.map((c) => c.tenantId))
  if (distinctTenants.size > 1) {
    return { resolved: false, reason: 'cross_tenant', candidates: active }
  }

  if (expectedTenantId && !distinctTenants.has(expectedTenantId)) {
    return { resolved: false, reason: 'cross_tenant', candidates: active }
  }

  if (active.length > 1) {
    return { resolved: false, reason: 'ambiguous_binding', candidates: active }
  }

  return { resolved: true, binding: active[0] }
}

export type InboundRoute =
  | {
      route: 'staff_action'
      binding: StaffBindingRow
      action: StaffActionKind
      target: OpenWorkRefCandidate
      note: string | null
      resolution: 'explicit_ref' | 'sole_open_work'
      grammar: 'strict' | 'bare'
    }
  | {
      route: 'staff_disambiguation'
      binding: StaffBindingRow
      action: StaffActionKind
      candidates: OpenWorkRefCandidate[]
    }
  | {
      route: 'staff_help'
      binding: StaffBindingRow
      /** Set when the sender used a verb but we could not target it. */
      attemptedAction?: StaffActionKind
      why: 'no_open_work' | 'unknown_reference' | 'explicit_help' | 'non_command'
    }
  | {
      route: 'exception'
      why: 'unknown_sender' | 'inactive_binding' | 'ambiguous_binding' | 'cross_tenant'
      candidates?: StaffBindingRow[]
    }

export interface DecideInboundRouteInput {
  text: string
  /** Every binding row matching the sender's waId, unfiltered by tenant. */
  bindingCandidates: StaffBindingRow[]
  /** The tenant that owns the channel the message arrived on. */
  channelTenantId?: string | null
  /** The sender's currently open Foundation-dispatched work. */
  openWork: OpenWorkRefCandidate[]
}

/**
 * The single decision function for inbound staff messages. Pure.
 *
 * Ordering is the whole point and is ratified, not incidental:
 *   identity first (fail closed) → explicit staff command → help → nothing.
 * No other role the sender holds — owner, manager, admin — is consulted before
 * a staff command is recognised.
 */
export function decideInboundRoute(input: DecideInboundRouteInput): InboundRoute {
  const identity = resolveStaffIdentity(input.bindingCandidates, input.channelTenantId)
  if (!identity.resolved) {
    return { route: 'exception', why: identity.reason, candidates: identity.candidates }
  }

  const binding = identity.binding
  const parsed = parseStaffCommand({ text: input.text, openWork: input.openWork })

  if (parsed.matched) {
    if (parsed.action === 'help') {
      return { route: 'staff_help', binding, attemptedAction: 'help', why: 'explicit_help' }
    }
    return {
      route: 'staff_action',
      binding,
      action: parsed.action,
      target: parsed.target,
      note: parsed.note,
      resolution: parsed.resolution,
      grammar: parsed.grammar,
    }
  }

  switch (parsed.reason) {
    case 'needs_disambiguation':
      return {
        route: 'staff_disambiguation',
        binding,
        action: parsed.action!,
        candidates: parsed.candidates ?? [],
      }
    case 'no_open_work':
      return {
        route: 'staff_help',
        binding,
        attemptedAction: parsed.action,
        why: parsed.action === 'help' ? 'explicit_help' : 'no_open_work',
      }
    case 'unknown_reference':
      return { route: 'staff_help', binding, attemptedAction: parsed.action, why: 'unknown_reference' }
    default:
      return { route: 'staff_help', binding, why: 'non_command' }
  }
}
