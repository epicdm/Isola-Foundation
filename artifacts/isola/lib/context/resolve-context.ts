/**
 * resolve-context@1 — Foundation answers "who is this, at which company, looking
 * at what, and what are they allowed to do about it".
 *
 * BOUNDARY: this resolves BUSINESS identity. It does not create or maintain a
 * Clawith session, does not touch a provider, and does not send anything. It
 * hands back SAFE references — the ids Lane 2 needs to run a turn — and the list
 * of governed actions this actor may take on this object.
 *
 * THE RULE THAT SHAPES EVERY LINE HERE: no field of the request may assert
 * identity. A caller says which object it is interested in; it never says who it
 * is, what role it holds, or what it may do. Those are resolved from the
 * authenticated principal and re-checked here. Prompt text is not authorization,
 * and neither is a JSON field.
 */

export const RESOLVE_CONTEXT_VERSION = 'resolve-context@1' as const

export const OBJECT_TYPES = [
  'customer',
  'service',
  'device',
  'pbx',
  'task',
  'issue',
  'opportunity',
] as const
export type ObjectType = (typeof OBJECT_TYPES)[number]

export const ROLES = ['staff', 'manager', 'owner', 'service_account'] as const
export type Role = (typeof ROLES)[number]

export type ResolveRefusal =
  | 'unknown_identity'
  | 'inactive_user'
  | 'no_company'
  | 'company_mismatch'
  | 'unauthorized_object'
  | 'unauthorized_agent'
  | 'stale_binding'
  | 'invalid_object_type'
  | 'missing_context'

/** Every refusal is deliberately opaque about WHY at the edge — see `publicDetail`. */
export interface ResolveRefusalResult {
  ok: false
  refusal: ResolveRefusal
  /** For operators and audit. May name records. */
  detail: string
  /**
   * For the caller. Must never distinguish "does not exist" from "not yours" —
   * that difference is an enumeration oracle.
   */
  publicDetail: string
  correlationId: string
}

export interface ResolveContextRequest {
  /** Opaque principal id from the authenticated session. NEVER from a payload field. */
  principalId: string
  /** Set only for machine callers acting on behalf of an agent. */
  requestingAgentRef?: string | null
  channelBindingId?: string | null
  /** Sender reference (e.g. a wa_id) when the turn originated on a channel. */
  contactRef?: string | null
  selectedObjectType?: string | null
  selectedObjectId?: string | null
  correlationId: string
}

export interface SafeBindingRefs {
  clawithAgentRef: string | null
  clawithWorkspaceRef: string | null
  chatwootTeamRef: string | null
  chatwootInboxRef: string | null
}

export interface ResolvedContext {
  version: typeof RESOLVE_CONTEXT_VERSION
  correlationId: string
  principalId: string
  displayName: string
  role: Role
  companyId: string
  selectedObject: { type: ObjectType; id: string } | null
  relatedObjectIds: Readonly<Record<string, string>>
  permittedActions: readonly string[]
  actionsRequiringApproval: readonly string[]
  bindings: SafeBindingRefs
  workspaceUrl: string | null
  auditRef: string
}

export type ResolveContextResult =
  | { ok: true; context: ResolvedContext }
  | ResolveRefusalResult

/* ── Ports. Injected, so this module has no transport and no ambient state. ── */

export interface PrincipalRecord {
  id: string
  displayName: string
  role: string
  companyId: string
  active: boolean
}

export interface BusinessObjectRecord {
  type: string
  id: string
  companyId: string
  relatedObjectIds?: Record<string, string>
}

export interface ChannelBindingRecord {
  id: string
  companyId: string
  classification: string
  clawithAgentRef: string | null
  chatwootTeamRef: string | null
  clawithWorkspaceRef?: string | null
  chatwootInboxRef?: string | null
  /** Provisioning has completed and the last verification is recent enough to trust. */
  fresh: boolean
}

export interface ResolveContextPorts {
  loadPrincipal(principalId: string): Promise<PrincipalRecord | null>
  loadObject(type: ObjectType, id: string): Promise<BusinessObjectRecord | null>
  loadChannelBinding(id: string): Promise<ChannelBindingRecord | null>
  /** Which agent refs this company has actually bound. Never trusted from input. */
  agentIsBoundToCompany(agentRef: string, companyId: string): Promise<boolean>
  workspaceUrlFor(objectType: ObjectType, objectId: string, companyId: string): string
  newAuditRef(correlationId: string): string
}

/**
 * Action catalogue, strictly nested. A manager may do everything staff may do; an
 * owner everything a manager may. Nesting is asserted by a test, so a future edit
 * cannot quietly give staff an owner-only action.
 *
 * THESE NAMES MUST BE THE EXECUTORS' NAMES.
 * ----------------------------------------
 * This list says what a role is PERMITTED to do; `lib/governed/executors` says
 * what can actually be DONE, and `runGovernedAction` looks an action up by the
 * name registered there. A name in one list and not the other is not a harmless
 * mismatch — it is either a button whose only possible outcome is a refusal
 * (permitted here, no executor) or an implemented action nobody can reach
 * (registered there, never permitted). Both happened:
 *
 *   `note.add` was permitted here and the executor is `note.create`, so every
 *   proposal returned VALIDATION_FAILED, "no executor declared for note.add".
 *
 *   `activity.schedule` has had a working executor and appeared in no role's
 *   list, so it was unreachable.
 *
 * `lib/governed/executors/catalogue.test.ts` now asserts the two agree, for
 * every role, in both directions. `customer.lookup`, `task.reassign`,
 * `business_field.update` and `approval.override` are deliberately here without
 * executors: they are permissions this resolver grants, not writes the governed
 * runtime performs, and the catalogue test scopes itself to the six that are.
 */
const STAFF_ACTIONS = [
  'customer.lookup',
  'note.create',
  'task.create',
  'activity.schedule',
  'followup.schedule',
  // S8-W1. Customer-visible, so the executor restricts it to real people
  // (staff/manager/owner) and excludes service_account, which this list would
  // otherwise grant it via the shared STAFF_ACTIONS.
  'document.send',
] as const
const MANAGER_ACTIONS = [
  ...STAFF_ACTIONS,
  'lead.create',
  'lead.update',
  'task.reassign',
  // ev-isola-360-followup-assignment-2026-09-27: manager/owner only, per the
  // owner's ruling that assigning a follow-up to someone else is a different,
  // higher-trust act than followup.schedule (which staff already has above).
  'followup.scheduleAssigned',
] as const
const OWNER_ACTIONS = [...MANAGER_ACTIONS, 'business_field.update', 'approval.override'] as const

export const ACTIONS_BY_ROLE: Readonly<Record<Role, readonly string[]>> = {
  staff: STAFF_ACTIONS,
  manager: MANAGER_ACTIONS,
  owner: OWNER_ACTIONS,
  service_account: STAFF_ACTIONS,
}

/** Actions that always require a human approval, whatever the role. */
export const ACTIONS_REQUIRING_APPROVAL: readonly string[] = [
  'business_field.update',
  'approval.override',
  'lead.update',
]

const NOT_FOUND_OR_NOT_YOURS = 'not found, or not available to you'

function refuse(
  refusal: ResolveRefusal,
  detail: string,
  correlationId: string,
  publicDetail = NOT_FOUND_OR_NOT_YOURS,
): ResolveRefusalResult {
  return { ok: false, refusal, detail, publicDetail, correlationId }
}

export async function resolveContext(
  req: ResolveContextRequest,
  ports: ResolveContextPorts,
): Promise<ResolveContextResult> {
  const correlationId = (req.correlationId ?? '').trim()
  if (!correlationId) {
    return refuse('missing_context', 'correlationId is required', '', 'missing correlation id')
  }

  const principalId = (req.principalId ?? '').trim()
  if (!principalId) return refuse('unknown_identity', 'no principalId', correlationId)

  const principal = await ports.loadPrincipal(principalId)
  if (!principal) return refuse('unknown_identity', `principal ${principalId}`, correlationId)
  if (!principal.active) {
    return refuse('inactive_user', `principal ${principalId} is inactive`, correlationId)
  }
  if (!principal.companyId) {
    return refuse('no_company', `principal ${principalId} has no company`, correlationId)
  }
  if (!(ROLES as readonly string[]).includes(principal.role)) {
    return refuse('unknown_identity', `unknown role ${principal.role}`, correlationId)
  }
  const role = principal.role as Role
  const companyId = principal.companyId

  // ── Agent identity, when one is claimed, must be BOUND to this company ──────
  const agentRef = req.requestingAgentRef?.trim() || null
  if (agentRef) {
    const bound = await ports.agentIsBoundToCompany(agentRef, companyId)
    if (!bound) {
      return refuse(
        'unauthorized_agent',
        `agent ${agentRef} is not bound to company ${companyId}`,
        correlationId,
      )
    }
  }

  // ── Channel binding, when supplied ─────────────────────────────────────────
  let bindings: SafeBindingRefs = {
    clawithAgentRef: null,
    clawithWorkspaceRef: null,
    chatwootTeamRef: null,
    chatwootInboxRef: null,
  }
  const bindingId = req.channelBindingId?.trim() || null
  if (bindingId) {
    const binding = await ports.loadChannelBinding(bindingId)
    if (!binding) return refuse('missing_context', `binding ${bindingId}`, correlationId)
    if (binding.companyId !== companyId) {
      return refuse(
        'company_mismatch',
        `binding ${bindingId} belongs to ${binding.companyId}, principal to ${companyId}`,
        correlationId,
      )
    }
    if (!binding.fresh) {
      return refuse(
        'stale_binding',
        `binding ${bindingId} has not been verified recently enough to trust`,
        correlationId,
        'channel is not currently verified',
      )
    }
    bindings = {
      clawithAgentRef: binding.clawithAgentRef,
      clawithWorkspaceRef: binding.clawithWorkspaceRef ?? null,
      chatwootTeamRef: binding.chatwootTeamRef,
      chatwootInboxRef: binding.chatwootInboxRef ?? null,
    }
  }

  // ── Selected object ────────────────────────────────────────────────────────
  let selectedObject: { type: ObjectType; id: string } | null = null
  let relatedObjectIds: Record<string, string> = {}
  let workspaceUrl: string | null = null

  const rawType = req.selectedObjectType?.trim() || null
  const rawId = req.selectedObjectId?.trim() || null
  if (rawType || rawId) {
    if (!rawType || !rawId) {
      return refuse(
        'missing_context',
        'selectedObjectType and selectedObjectId must be supplied together',
        correlationId,
        'incomplete selection',
      )
    }
    if (!(OBJECT_TYPES as readonly string[]).includes(rawType)) {
      return refuse('invalid_object_type', `unknown object type ${rawType}`, correlationId)
    }
    const type = rawType as ObjectType
    const record = await ports.loadObject(type, rawId)
    // Absent and forbidden collapse to ONE refusal with ONE public message, so a
    // caller cannot probe which ids exist in another company.
    if (!record || record.companyId !== companyId) {
      return refuse(
        'unauthorized_object',
        record
          ? `object ${type}/${rawId} belongs to ${record.companyId}, principal to ${companyId}`
          : `object ${type}/${rawId} not found`,
        correlationId,
      )
    }
    selectedObject = { type, id: rawId }
    relatedObjectIds = record.relatedObjectIds ?? {}
    workspaceUrl = ports.workspaceUrlFor(type, rawId, companyId)
  }

  const permitted = ACTIONS_BY_ROLE[role]

  return {
    ok: true,
    context: {
      version: RESOLVE_CONTEXT_VERSION,
      correlationId,
      principalId: principal.id,
      displayName: principal.displayName,
      role,
      companyId,
      selectedObject,
      relatedObjectIds,
      permittedActions: permitted,
      actionsRequiringApproval: ACTIONS_REQUIRING_APPROVAL.filter((a) => permitted.includes(a)),
      bindings,
      workspaceUrl,
      auditRef: ports.newAuditRef(correlationId),
    },
  }
}
