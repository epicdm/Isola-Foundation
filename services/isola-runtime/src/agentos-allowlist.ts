/**
 * The exact, hardcoded allowlist gating the AgentOS execution provider.
 *
 * Tenant enforcement did not exist anywhere in this service before this file —
 * `extractTenantId` (conversation.ts) was a best-effort DESCRIPTIVE extraction,
 * never gated (see config.ts / app.ts history). This is the FIRST place a
 * tenant id changes what a request is allowed to do, and it is scoped as
 * narrowly as possible: exactly one template, exactly one tenant, exactly one
 * exposure. Every other template and every other tenant is completely
 * unaffected — `evaluateAgentOsEligibility` returns `not_applicable`
 * immediately for anything that is not this one template id, and the caller
 * routes it through the unchanged direct-model path.
 *
 * Fail closed on anything that is not an EXACT match, mirroring
 * `registry.ts`'s `normaliseRequestedExposure`: an unknown or malformed value
 * never widens access, it only ever narrows it further.
 */
import type { Exposure } from "./registry.js";

export const AGENTOS_ALLOWED_TENANT = "8D3dp3z";
export const AGENTOS_ALLOWED_TEMPLATE_ID = "epic-staff-operations-coordinator@v1";
export const AGENTOS_ALLOWED_EXPOSURE: Exposure = "INTERNAL";

export type AgentOsEligibility =
  /** Not the AgentOS-gated template at all: route as normal, unaffected. */
  | { kind: "not_applicable" }
  | { kind: "eligible" }
  /** Matches the gated template id but fails tenant or exposure: hard refuse. */
  | { kind: "refused"; reason: string };

export interface AgentOsEligibilityInput {
  templateId: string;
  tenantId: string | null;
  exposure: Exposure;
}

/**
 * Pure decision function — no I/O, no config, so it is trivially unit
 * testable and trivially auditable. Called on EVERY request; there is no
 * caching and no memoisation, because caching an allow/deny decision is
 * exactly the kind of "silent fall-through" this function exists to prevent.
 */
export function evaluateAgentOsEligibility(
  input: AgentOsEligibilityInput,
): AgentOsEligibility {
  if (input.templateId !== AGENTOS_ALLOWED_TEMPLATE_ID) {
    return { kind: "not_applicable" };
  }

  if (input.tenantId !== AGENTOS_ALLOWED_TENANT) {
    return {
      kind: "refused",
      reason:
        `agentos_tenant_refused: template ${AGENTOS_ALLOWED_TEMPLATE_ID} is only permitted for ` +
        `tenant ${AGENTOS_ALLOWED_TENANT}; refusing rather than falling through to another provider`,
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

  return { kind: "eligible" };
}
