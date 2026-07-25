/**
 * Cold-start seed guard for ChatwootBinding — the governed REGISTRATION that
 * points a Chatwoot door (account + inbox + mode) at exactly one Foundation
 * Agent row, which in turn points at one Clawith agent owned by one tenant.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 * ChatwootBinding lost its UNIQUE(tenant_id) in migration
 * 20260717130000_add_agent_id_to_bindings and gained no replacement uniqueness
 * on (account_id, inbox_id, mode). Nothing at the database level stops two
 * registrations from claiming the same door. The cold-start seeder in
 * instrumentation.ts used to look a binding up by tenant_id alone and then
 * unconditionally `update()` it on EVERY process start. Two consequences:
 *
 *   1. It could create/refresh a registration for a RETIRED tenant, with a
 *      NULL agent pointer, on a door an ACTIVE tenant already owned.
 *   2. Because ChatwootBinding.updated_at is `@updatedAt`, that unconditional
 *      update made the invalid row permanently the "freshest" row at the door.
 *      resolveActiveBinding() in lib/chatwoot-binding-resolution.ts breaks ties
 *      on updated_at, so the churn actively fought the tie-breaker.
 *
 * This module is the pure, side-effect-free decision half of the fix. The
 * caller gathers facts with reads only, asks decideChatwootBindingSeed() what
 * to do, and performs at most the single write it is told to perform. When the
 * correct registration already exists the answer is `noop` — zero writes, so
 * updated_at never churns.
 *
 * ── Vocabulary (do not interchange) ────────────────────────────────────────
 *   Tenant                 customer business + authority boundary; may own many agents
 *   Foundation Agent row   the governed REGISTRATION/pointer to a Clawith agent
 *   Clawith agent          the real AI employee, created in Clawith
 *   Chatwoot inbox         the customer door + operator workspace
 *
 * ── Secrets ────────────────────────────────────────────────────────────────
 * `token` is carried through so the caller can detect a genuine rotation, but
 * it is NEVER placed in a decision reason, conflict detail, warning or changed-
 * field value. Refusal details carry ids, statuses and reason codes only, so
 * they are safe to log verbatim.
 */

/** The registration the seeder wants to exist, entirely from configuration. */
export interface DesiredRegistration {
  /** Owning tenant id — explicit config, never inferred from account_id. */
  tenantId: string;
  /**
   * Foundation Agent row id resolved from configuration-backed identity
   * (tenant + agent name). Null means the caller could not resolve it — the
   * guard refuses rather than writing a NULL registration pointer.
   */
  agentId: string | null;
  baseUrl: string;
  accountId: string;
  /** Chatwoot inbox id — required. A door is (account, inbox, mode), never account alone. */
  inboxId: string | null;
  mode: string;
  /** Chatwoot auth token. Compared, never logged. */
  token: string;
}

export interface TenantFacts {
  id: string;
  status: string;
}

export interface AgentFacts {
  id: string;
  tenant_id: string;
  brain_provider: string;
  /**
   * clawith_agent_id resolved for this Agent row — per-agent ClawithBinding
   * first, then the tenant-level (agent_id IS NULL) fallback, exactly the
   * order app/api/chatwoot/agent-bot/route.ts resolves it at runtime.
   */
  clawith_agent_id: string | null;
}

/** An existing ChatwootBinding row sitting at the same door. */
export interface ExistingRegistration {
  id: string;
  tenant_id: string;
  tenant_status: string;
  agent_id: string | null;
  base_url: string;
  account_id: string;
  inbox_id: string | null;
  mode: string;
  token: string;
}

export interface SeedInput {
  desired: DesiredRegistration;
  /** The desired tenant, or null when it does not exist. */
  tenant: TenantFacts | null;
  /** The Agent row named by desired.agentId, or null when it does not exist. */
  agent: AgentFacts | null;
  /**
   * EVERY existing ChatwootBinding row at the same door
   * (account_id + inbox_id + mode). Door-keyed, never tenant-keyed — ownership
   * of a door is a property of the door, not of the account.
   */
  doorRegistrations: ExistingRegistration[];
}

export type SeedRefusalReason =
  /** base_url / account_id / inbox_id / mode / tenant id not fully configured */
  | 'config_incomplete'
  /** the registration pointer (Agent row id) would be NULL */
  | 'agent_registration_null'
  /** the configured tenant row does not exist */
  | 'tenant_missing'
  /** the configured tenant is retired or otherwise not active */
  | 'tenant_not_active'
  /** the referenced Foundation Agent row does not exist */
  | 'agent_row_missing'
  /** the Agent row exists but belongs to a different tenant */
  | 'agent_tenant_mismatch'
  /** Agent.brain_provider is 'clawith' but no ClawithBinding/clawith_agent_id exists */
  | 'clawith_identity_missing'
  /** another ACTIVE registration already owns this (account_id, inbox_id, mode) */
  | 'door_owned_by_other_active_registration'
  /** this tenant already has more than one registration at this door */
  | 'ambiguous_duplicate_registration';

/** Correlation-safe conflict payload: ids, statuses and reason codes only. */
export interface ConflictDetail {
  door: { account_id: string; inbox_id: string | null; mode: string };
  desired_tenant_id: string;
  desired_agent_id: string | null;
  conflicting: Array<{
    binding_id: string;
    tenant_id: string;
    tenant_status: string;
    agent_id: string | null;
  }>;
}

export interface SeedWarning {
  code: 'stale_inactive_registration_at_door';
  binding_id: string;
  tenant_id: string;
  tenant_status: string;
  agent_id: string | null;
}

/** Fields the seeder is allowed to write. Never includes `token` in logs. */
export interface RegistrationWriteData {
  tenant_id: string;
  agent_id: string;
  base_url: string;
  account_id: string;
  inbox_id: string;
  mode: string;
  token: string;
}

export type SeedDecision =
  | { action: 'noop'; bindingId: string; warnings: SeedWarning[] }
  | { action: 'create'; data: RegistrationWriteData; warnings: SeedWarning[] }
  | {
      action: 'update';
      bindingId: string;
      data: RegistrationWriteData;
      /** field names only — a rotated token shows as "token", never its value */
      changedFields: string[];
      warnings: SeedWarning[];
    }
  | {
      action: 'refuse';
      reason: SeedRefusalReason;
      detail: ConflictDetail;
      warnings: SeedWarning[];
    };

const ACTIVE_TENANT_STATUS = 'active';

function blank(v: string | null | undefined): boolean {
  return v == null || v.trim() === '';
}

function doorOf(d: DesiredRegistration) {
  return { account_id: d.accountId, inbox_id: d.inboxId, mode: d.mode };
}

function refuse(
  reason: SeedRefusalReason,
  desired: DesiredRegistration,
  conflicting: ConflictDetail['conflicting'],
  warnings: SeedWarning[],
): SeedDecision {
  return {
    action: 'refuse',
    reason,
    detail: {
      door: doorOf(desired),
      desired_tenant_id: desired.tenantId,
      desired_agent_id: desired.agentId,
      conflicting,
    },
    warnings,
  };
}

function summarise(r: ExistingRegistration) {
  return {
    binding_id: r.id,
    tenant_id: r.tenant_id,
    tenant_status: r.tenant_status,
    agent_id: r.agent_id,
  };
}

/**
 * Decide what a cold start may do to the ChatwootBinding registration for one
 * door. Pure: no I/O, no clock, no randomness — same input, same decision.
 *
 * REFUSES (leaving every existing row untouched) when any of these holds:
 *   • the tenant is retired or not active, or does not exist
 *   • the registration pointer (Agent row id) would be NULL
 *   • the referenced Agent row does not exist, or belongs to another tenant
 *   • the Agent requires a Clawith identity (brain_provider 'clawith') but no
 *     ClawithBinding / clawith_agent_id exists
 *   • another ACTIVE registration already owns this (account_id, inbox_id, mode)
 *   • this tenant already holds more than one registration at this door
 *
 * Otherwise returns `noop` when the correct registration already exists (no
 * write at all, so updated_at does not churn), `update` listing exactly which
 * fields differ, or `create`.
 */
export function decideChatwootBindingSeed(input: SeedInput): SeedDecision {
  const { desired, tenant, agent, doorRegistrations } = input;

  // Warnings are computed up front so a refusal still reports what it saw.
  const others = doorRegistrations.filter((r) => r.tenant_id !== desired.tenantId);
  const activeOthers = others.filter((r) => r.tenant_status === ACTIVE_TENANT_STATUS);
  const inactiveOthers = others.filter((r) => r.tenant_status !== ACTIVE_TENANT_STATUS);
  const warnings: SeedWarning[] = inactiveOthers.map((r) => ({
    code: 'stale_inactive_registration_at_door' as const,
    ...summarise(r),
  }));

  // 1. Configuration completeness. A door is (account, inbox, mode) — an
  //    account id alone never identifies ownership, so inbox_id is required.
  if (
    blank(desired.tenantId) ||
    blank(desired.baseUrl) ||
    blank(desired.accountId) ||
    blank(desired.inboxId) ||
    blank(desired.mode)
  ) {
    return refuse('config_incomplete', desired, [], warnings);
  }

  // 2. The registration pointer must never be NULL.
  if (blank(desired.agentId)) {
    return refuse('agent_registration_null', desired, [], warnings);
  }

  // 3/4. Tenant must exist and be active.
  if (!tenant) {
    return refuse('tenant_missing', desired, [], warnings);
  }
  if (tenant.status !== ACTIVE_TENANT_STATUS) {
    return refuse(
      'tenant_not_active',
      desired,
      [
        {
          binding_id: '',
          tenant_id: tenant.id,
          tenant_status: tenant.status,
          agent_id: desired.agentId,
        },
      ],
      warnings,
    );
  }

  // 5/6. The referenced Agent row must exist and be owned by that tenant.
  if (!agent) {
    return refuse('agent_row_missing', desired, [], warnings);
  }
  if (agent.tenant_id !== desired.tenantId) {
    return refuse(
      'agent_tenant_mismatch',
      desired,
      [
        {
          binding_id: '',
          tenant_id: agent.tenant_id,
          tenant_status: tenant.status,
          agent_id: agent.id,
        },
      ],
      warnings,
    );
  }

  // 7. An Agent that routes to Clawith must have a real Clawith identity.
  if (agent.brain_provider === 'clawith' && blank(agent.clawith_agent_id)) {
    return refuse(
      'clawith_identity_missing',
      desired,
      [
        {
          binding_id: '',
          tenant_id: agent.tenant_id,
          tenant_status: tenant.status,
          agent_id: agent.id,
        },
      ],
      warnings,
    );
  }

  // 8. Door ownership.
  if (activeOthers.length > 0) {
    return refuse(
      'door_owned_by_other_active_registration',
      desired,
      activeOthers.map(summarise),
      warnings,
    );
  }

  const ours = doorRegistrations.filter((r) => r.tenant_id === desired.tenantId);
  if (ours.length > 1) {
    return refuse('ambiguous_duplicate_registration', desired, ours.map(summarise), warnings);
  }

  const data: RegistrationWriteData = {
    tenant_id: desired.tenantId,
    agent_id: desired.agentId as string,
    base_url: desired.baseUrl,
    account_id: desired.accountId,
    inbox_id: desired.inboxId as string,
    mode: desired.mode,
    token: desired.token,
  };

  if (ours.length === 0) {
    return { action: 'create', data, warnings };
  }

  const existing = ours[0];
  const changedFields: string[] = [];
  if (existing.agent_id !== data.agent_id) changedFields.push('agent_id');
  if (existing.base_url !== data.base_url) changedFields.push('base_url');
  if (existing.account_id !== data.account_id) changedFields.push('account_id');
  if (existing.inbox_id !== data.inbox_id) changedFields.push('inbox_id');
  if (existing.mode !== data.mode) changedFields.push('mode');
  if (existing.token !== data.token) changedFields.push('token');

  if (changedFields.length === 0) {
    // Already correct — no write, so @updatedAt does not churn.
    return { action: 'noop', bindingId: existing.id, warnings };
  }

  return { action: 'update', bindingId: existing.id, data, changedFields, warnings };
}

/**
 * Render a decision as a single correlation-safe log line body. Contains ids,
 * statuses, reason codes and changed FIELD NAMES only — never a token value.
 */
export function describeSeedDecision(decision: SeedDecision): string {
  const warn = decision.warnings.length
    ? ` stale=[${decision.warnings
        .map((w) => `${w.binding_id}:${w.tenant_id}(${w.tenant_status})`)
        .join(', ')}]`
    : '';

  switch (decision.action) {
    case 'noop':
      return `noop binding=${decision.bindingId} (already correct — no write)${warn}`;
    case 'create':
      return `create tenant=${decision.data.tenant_id} agent=${decision.data.agent_id} account=${decision.data.account_id} inbox=${decision.data.inbox_id} mode=${decision.data.mode}${warn}`;
    case 'update':
      return `update binding=${decision.bindingId} fields=[${decision.changedFields.join(', ')}]${warn}`;
    case 'refuse': {
      const c = decision.detail.conflicting
        .map((x) => `${x.binding_id || '-'}:${x.tenant_id}(${x.tenant_status})/agent=${x.agent_id ?? 'null'}`)
        .join(', ');
      return `REFUSED reason=${decision.reason} door=${decision.detail.door.account_id}/${decision.detail.door.inbox_id ?? 'null'}/${decision.detail.door.mode} desired_tenant=${decision.detail.desired_tenant_id} desired_agent=${decision.detail.desired_agent_id ?? 'null'} conflicting=[${c}]${warn}`;
    }
  }
}
