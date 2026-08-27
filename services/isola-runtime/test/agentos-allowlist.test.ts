/**
 * The server-side (Node) half of the AgentOS allowlist. Pure function, so
 * every branch is directly testable with no server, no network, no config.
 *
 * Test category mapping (see PR description's 13-item matrix):
 *   3. Tenant refusal   4. Template refusal   5. Exposure refusal
 */
import { describe, expect, it } from "vitest";

import {
  AGENTOS_ALLOWED_EXPOSURE,
  AGENTOS_ALLOWED_TEMPLATE_ID,
  AGENTOS_ALLOWED_TENANT,
  evaluateAgentOsEligibility,
} from "../src/agentos-allowlist.js";

describe("evaluateAgentOsEligibility", () => {
  it("is a no-op for every template other than the gated one", () => {
    const result = evaluateAgentOsEligibility({
      templateId: "isola-ai-sales-front-desk-agent@v1",
      tenantId: null,
      exposure: "PUBLIC",
    });
    expect(result).toEqual({ kind: "not_applicable" });
  });

  it("is a no-op even for the wrong tenant, when the template does not match", () => {
    // Proves isolation: a request for an unrelated template with a WRONG
    // tenant must not be treated as an AgentOS refusal — it never reaches
    // this allowlist's concern at all.
    const result = evaluateAgentOsEligibility({
      templateId: "isola-internal-manager@v1",
      tenantId: "some-random-tenant",
      exposure: "INTERNAL",
    });
    expect(result).toEqual({ kind: "not_applicable" });
  });

  it("is eligible on an EXACT match", () => {
    const result = evaluateAgentOsEligibility({
      templateId: AGENTOS_ALLOWED_TEMPLATE_ID,
      tenantId: AGENTOS_ALLOWED_TENANT,
      exposure: AGENTOS_ALLOWED_EXPOSURE,
    });
    expect(result).toEqual({ kind: "eligible" });
  });

  it("refuses a wrong tenant for the gated template", () => {
    const result = evaluateAgentOsEligibility({
      templateId: AGENTOS_ALLOWED_TEMPLATE_ID,
      tenantId: "wrong-tenant",
      exposure: AGENTOS_ALLOWED_EXPOSURE,
    });
    expect(result.kind).toBe("refused");
    expect(result.kind === "refused" && result.reason).toContain("agentos_tenant_refused");
  });

  it("refuses a null (absent) tenant for the gated template — unknown is not a wildcard", () => {
    const result = evaluateAgentOsEligibility({
      templateId: AGENTOS_ALLOWED_TEMPLATE_ID,
      tenantId: null,
      exposure: AGENTOS_ALLOWED_EXPOSURE,
    });
    expect(result.kind).toBe("refused");
    expect(result.kind === "refused" && result.reason).toContain("agentos_tenant_refused");
  });

  it("refuses the wrong exposure for the gated template, even with the right tenant", () => {
    const result = evaluateAgentOsEligibility({
      templateId: AGENTOS_ALLOWED_TEMPLATE_ID,
      tenantId: AGENTOS_ALLOWED_TENANT,
      exposure: "PUBLIC",
    });
    expect(result.kind).toBe("refused");
    expect(result.kind === "refused" && result.reason).toContain("agentos_exposure_refused");
  });

  it("checks tenant before exposure — a wrong tenant is named even when exposure is ALSO wrong", () => {
    const result = evaluateAgentOsEligibility({
      templateId: AGENTOS_ALLOWED_TEMPLATE_ID,
      tenantId: "wrong-tenant",
      exposure: "PUBLIC",
    });
    expect(result.kind).toBe("refused");
    expect(result.kind === "refused" && result.reason).toContain("agentos_tenant_refused");
  });

  it("is case-sensitive on the tenant id — no normalisation, no fuzzy matching", () => {
    const result = evaluateAgentOsEligibility({
      templateId: AGENTOS_ALLOWED_TEMPLATE_ID,
      tenantId: AGENTOS_ALLOWED_TENANT.toLowerCase(),
      exposure: AGENTOS_ALLOWED_EXPOSURE,
    });
    // Guard against the allowlist itself accidentally being all-lowercase,
    // which would make this assertion pass vacuously.
    expect(AGENTOS_ALLOWED_TENANT).not.toBe(AGENTOS_ALLOWED_TENANT.toLowerCase());
    expect(result.kind).toBe("refused");
  });
});
