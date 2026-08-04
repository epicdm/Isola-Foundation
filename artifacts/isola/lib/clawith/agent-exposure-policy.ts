/**
 * Foundation-owned agent exposure policy — B1.
 *
 * Ratifies `dec-clawith-single-org-foundation-owns-agent-exposure-2026-07-31`:
 * Clawith remains ONE organization; Foundation alone decides which of its
 * agents may be reached by customer/public traffic (PUBLIC) versus
 * authenticated Foundation staff traffic (INTERNAL). Every resolution is
 * FAIL CLOSED — a missing row, a disabled row, or an unrecognised
 * (tenant, clawith_agent_id) pair all resolve to "not classified", and
 * nothing downstream may treat "not classified" as either PUBLIC or
 * INTERNAL.
 *
 * MIGRATION GATE (xp-foundation-agent-exposure-enforcement-2026-08-04): no
 * schema field for this classification exists anywhere in prisma/schema.prisma
 * today (`ChannelBinding.classification` is a different, business-set
 * customer_facing/internal_private concept — not this policy). Creating an
 * `AgentExposurePolicy` table requires separate migration authorization this
 * packet does not have, so this module ships the SAME pattern already proven
 * in this codebase for shipping real enforcement without a schema change:
 * `HERMES_ALLOWED_PHONE_NUMBER_IDS` / `ISOLA_BRIDGE_ALLOWED_PHONE_NUMBER_IDS`
 * (lib/brain-provider.ts), `staffChatAgentAllowlist`
 * (lib/workspace/staff-agent-chat.ts), `gatedDoors`
 * (lib/clawith/gate.ts) — a hardcoded floor plus an additive, JSON-encoded
 * env var, so a future classification can go live with a Replit Secret +
 * restart and no code deploy, while every change to the floor itself is a
 * reviewed, git-blamable commit (the audit trail for a code-level policy
 * source). See the packet's final report for the exact DB-backed
 * `AgentExposurePolicy` schema proposed as the follow-up, separately
 * authorized migration.
 *
 * Ledger's classification is UNRESOLVED per the mission dispatch and is
 * deliberately absent from the floor below — do not add it without
 * authoritative confirmation from the owner. Its absence means every
 * `resolveAgentExposure` call for Ledger returns `matched: false`, which
 * fails closed for BOTH public and internal routing.
 */

export type AgentExposureClassification = 'PUBLIC' | 'INTERNAL';

export interface AgentExposurePolicyEntry {
  /** Foundation's own Tenant.id — never a Clawith-side tenant namespace. */
  foundationTenantId: string;
  /** Clawith's own agent id (ClawithBinding.clawith_agent_id) — the stable,
   *  finest-grained identity Foundation actually controls (mirrors the same
   *  observation in lib/clawith/circuit-breaker.ts). */
  clawithAgentId: string;
  classification: AgentExposureClassification;
  enabled: boolean;
  /** Human-readable label for logs/audit only — never routing logic. */
  label?: string;
}

const FOUNDATION_TENANT_ID = '43b006e4-33e0-42a8-bec7-4422ba290d79';

/**
 * The hardcoded floor — ratified classifications only. Additions here are a
 * reviewed code change, which IS this module's audit trail for policy
 * changes until a DB-backed table exists.
 */
const _POLICY_FLOOR: readonly AgentExposurePolicyEntry[] = [
  {
    foundationTenantId: FOUNDATION_TENANT_ID,
    clawithAgentId: '81b38cd6-9fba-4cc8-8f87-1bce1a4aa162', // EMA
    classification: 'PUBLIC',
    enabled: true,
    label: 'EMA',
  },
  {
    foundationTenantId: FOUNDATION_TENANT_ID,
    clawithAgentId: 'a71578a4-12cc-4e38-ad24-4b9fffd69309', // EPIC Front Desk
    classification: 'PUBLIC',
    enabled: true,
    label: 'EPIC Front Desk',
  },
  {
    foundationTenantId: FOUNDATION_TENANT_ID,
    clawithAgentId: '9baf6f00-f9e0-4bd4-9672-10865f438e2c', // Atlas
    classification: 'INTERNAL',
    enabled: true,
    label: 'Atlas',
  },
  {
    foundationTenantId: FOUNDATION_TENANT_ID,
    clawithAgentId: '695930c9-cfb0-4b52-b33e-f3826493b891', // Scout
    classification: 'INTERNAL',
    enabled: true,
    label: 'Scout',
  },
  // Ledger — classification unresolved. Do NOT add a row here without an
  // authoritative owner ruling (see xp-foundation-agent-exposure-enforcement-
  // 2026-08-04). Its absence is what makes it fail closed.
];

function isValidEntry(v: unknown): v is AgentExposurePolicyEntry {
  if (!v || typeof v !== 'object') return false;
  const e = v as Record<string, unknown>;
  return (
    typeof e.foundationTenantId === 'string' &&
    e.foundationTenantId.trim() !== '' &&
    typeof e.clawithAgentId === 'string' &&
    e.clawithAgentId.trim() !== '' &&
    (e.classification === 'PUBLIC' || e.classification === 'INTERNAL') &&
    typeof e.enabled === 'boolean'
  );
}

/**
 * Additive extension, parsed from a JSON array. Malformed JSON or malformed
 * entries are dropped with a console.warn — never thrown, never treated as a
 * wildcard, matching `staffChatAgentAllowlist`'s "one bad entry must not
 * widen access" discipline.
 */
function parseExtraPolicy(raw: string | undefined): AgentExposurePolicyEntry[] {
  if (typeof raw !== 'string' || raw.trim() === '') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.warn('[agent-exposure-policy] AGENT_EXPOSURE_POLICY_EXTRA_JSON is not valid JSON — ignoring');
    return [];
  }
  if (!Array.isArray(parsed)) {
    console.warn('[agent-exposure-policy] AGENT_EXPOSURE_POLICY_EXTRA_JSON is not a JSON array — ignoring');
    return [];
  }
  const valid: AgentExposurePolicyEntry[] = [];
  for (const entry of parsed) {
    if (isValidEntry(entry)) {
      valid.push(entry);
    } else {
      console.warn('[agent-exposure-policy] dropping malformed AGENT_EXPOSURE_POLICY_EXTRA_JSON entry:', JSON.stringify(entry));
    }
  }
  return valid;
}

function policyKey(e: { foundationTenantId: string; clawithAgentId: string }): string {
  return `${e.foundationTenantId}::${e.clawithAgentId}`;
}

/**
 * Builds the resolution index fresh from the floor + env every call. This
 * module is resolved a handful of times per turn, never in a hot loop across
 * thousands of messages, so the cost of not caching module-load-time env is
 * intentional: `env` is accepted as a parameter (mirrors every other
 * allowlist helper in this codebase) so tests never depend on process.env
 * leaking between cases, and a Replit Secret change takes effect on next
 * request without a restart-timing race.
 */
function buildPolicyIndex(env: NodeJS.ProcessEnv): Map<string, AgentExposurePolicyEntry> {
  const index = new Map<string, AgentExposurePolicyEntry>();
  for (const entry of parseExtraPolicy(env.AGENT_EXPOSURE_POLICY_EXTRA_JSON)) {
    index.set(policyKey(entry), entry);
  }
  // Floor entries are applied LAST so they always win over an env-supplied
  // entry for the same (tenant, agent) pair — the floor can never be
  // overridden by configuration, only extended.
  for (const entry of _POLICY_FLOOR) {
    index.set(policyKey(entry), entry);
  }
  return index;
}

export interface AgentExposureResolution {
  /** False when no policy row exists for this (tenant, agent) pair at all. */
  matched: boolean;
  classification: AgentExposureClassification | null;
  enabled: boolean;
  label: string | null;
}

const UNRESOLVED: AgentExposureResolution = {
  matched: false,
  classification: null,
  enabled: false,
  label: null,
};

/**
 * The single resolver every exposure gate (B2, B3) consults. Never throws.
 * An empty/missing tenant or agent id resolves unmatched rather than
 * matching an entry by accident.
 */
export function resolveAgentExposure(
  params: { foundationTenantId: string; clawithAgentId: string },
  env: NodeJS.ProcessEnv = process.env,
): AgentExposureResolution {
  if (!params.foundationTenantId?.trim() || !params.clawithAgentId?.trim()) {
    return UNRESOLVED;
  }
  const index = buildPolicyIndex(env);
  const entry = index.get(policyKey(params));
  if (!entry) return UNRESOLVED;
  return {
    matched: true,
    classification: entry.classification,
    enabled: entry.enabled,
    label: entry.label ?? null,
  };
}

export function isAuthorizedPublicAgent(
  params: { foundationTenantId: string; clawithAgentId: string },
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const r = resolveAgentExposure(params, env);
  return r.matched && r.enabled && r.classification === 'PUBLIC';
}

export function isAuthorizedInternalAgent(
  params: { foundationTenantId: string; clawithAgentId: string },
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const r = resolveAgentExposure(params, env);
  return r.matched && r.enabled && r.classification === 'INTERNAL';
}
