/**
 * The exact, hardcoded allowlist gating the AgentOS execution provider.
 *
 * SERVER-SIDE TENANT SELECTION. The tenant this path runs as is decided by
 * OPERATOR CONFIGURATION (`AGENTOS_TENANT_ID`, see config.ts), never by the
 * request. An earlier revision of this file compared the caller-supplied
 * `context.tenantId` against a constant and treated a match as authoritative
 * — that is CLIENT-side selection validated against a constant, and any
 * holder of a valid INTERNAL credential could set `context.tenantId` to the
 * allowlisted value regardless of their real tenant. The routing decision now
 * reads the configured value; a request may only ECHO it, never choose it.
 *
 * Tenant enforcement did not exist anywhere in this service before this file —
 * `extractTenantId` (conversation.ts) was a best-effort DESCRIPTIVE extraction,
 * never gated. This is the FIRST place a tenant id changes what a request is
 * allowed to do, and it is scoped as narrowly as possible: exactly one
 * template, exactly one configured tenant, exactly one exposure. Every other
 * template is completely unaffected — `evaluateAgentOsEligibility` returns
 * `not_applicable` immediately for anything that is not this one template id,
 * and the caller routes it through the unchanged direct-model path.
 *
 * Fail closed on anything that is not an EXACT match, mirroring
 * `registry.ts`'s `normaliseRequestedExposure`: an unknown or malformed value
 * never widens access, it only ever narrows it further.
 */
import type { Exposure } from "./registry.js";

/**
 * The EXPECTED value of `AGENTOS_TENANT_ID` — the tenant this path was built
 * for. Deployment configuration must set it explicitly (config.ts refuses to
 * boot otherwise); this constant is the value it is expected to be set TO, and
 * is no longer the thing a request body is compared against.
 */
export const AGENTOS_ALLOWED_TENANT = "8D3dp3z";
export const AGENTOS_ALLOWED_TEMPLATE_ID = "epic-staff-operations-coordinator@v1";
export const AGENTOS_ALLOWED_EXPOSURE: Exposure = "INTERNAL";

export type AgentOsEligibility =
  /** Not the AgentOS-gated template at all: route as normal, unaffected. */
  | { kind: "not_applicable" }
  /**
   * Eligible. `tenantId` is the SERVER-CONFIGURED value — the caller never
   * supplies the tenant this run executes as, only (optionally) echoes it.
   */
  | { kind: "eligible"; tenantId: string }
  /** Matches the gated template id but fails tenant or exposure: hard refuse. */
  | { kind: "refused"; reason: string }
  /** Matches the gated template but no server-side tenant is configured. */
  | { kind: "not_configured" };

export interface AgentOsEligibilityInput {
  /**
   * The operator's master switch (`AGENTOS_ENABLED`). When off, NOTHING routes
   * into AgentOS and every template takes the unchanged direct-model path —
   * checked FIRST, before any other condition, so a disabled runtime cannot
   * refuse a request on an AgentOS ground.
   */
  enabled: boolean;
  templateId: string;
  /** The tenant id the CALLER supplied, if any. Descriptive, never decisive. */
  requestTenantId: string | null;
  exposure: Exposure;
  /** The operator-configured tenant. `null` means unconfigured — fail closed. */
  configuredTenantId: string | null;
}

/**
 * Pure decision function — no I/O, no config lookup, so it is trivially unit
 * testable and trivially auditable. Called on EVERY request; there is no
 * caching and no memoisation, because caching an allow/deny decision is
 * exactly the kind of "silent fall-through" this function exists to prevent.
 */
export function evaluateAgentOsEligibility(
  input: AgentOsEligibilityInput,
): AgentOsEligibility {
  // THE MASTER SWITCH, checked before everything else. A disabled runtime
  // behaves as though this feature does not exist: no routing, and no refusal
  // on an AgentOS ground either.
  if (!input.enabled) {
    return { kind: "not_applicable" };
  }

  if (input.templateId !== AGENTOS_ALLOWED_TEMPLATE_ID) {
    return { kind: "not_applicable" };
  }

  if (input.configuredTenantId === null) {
    return { kind: "not_configured" };
  }

  // A request MAY carry a tenant id, but only as an echo of the configured
  // one. It may never select a different tenant, and a mismatch is refused
  // outright rather than coerced to the configured value — silently rewriting
  // a caller's stated tenant would hide a misrouted integration.
  if (input.requestTenantId !== null && input.requestTenantId !== input.configuredTenantId) {
    return {
      kind: "refused",
      reason:
        `agentos_tenant_refused: the request declared a tenant that is not the tenant this ` +
        `runtime is configured to serve; refusing rather than routing or falling through to ` +
        `another provider`,
    };
  }

  if (input.exposure !== AGENTOS_ALLOWED_EXPOSURE) {
    return {
      kind: "refused",
      reason:
        `agentos_exposure_refused: template ${AGENTOS_ALLOWED_TEMPLATE_ID} is only permitted at ` +
        `exposure ${AGENTOS_ALLOWED_EXPOSURE}; refusing rather than falling through to another provider`,
    };
  }

  // The SERVER's tenant, not the caller's. This is the value that reaches the
  // sidecar envelope.
  return { kind: "eligible", tenantId: input.configuredTenantId };
}
