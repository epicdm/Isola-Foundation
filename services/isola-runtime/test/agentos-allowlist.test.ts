/**
 * The server-side (Node) half of the AgentOS allowlist. Pure function, so
 * every branch is directly testable with no server, no network, no config.
 *
 * Test category mapping (see PR description's 13-item matrix):
 *   3. Tenant refusal   4. Template refusal   5. Exposure refusal
 *
 * The central property under test after the Codex review: the tenant is
 * chosen by CONFIGURATION and only ever echoed by the request. A request that
 * names a different tenant is refused, never coerced and never routed.
 */
import { describe, expect, it } from "vitest";

import {
  AGENTOS_ALLOWED_EXPOSURE,
  AGENTOS_ALLOWED_TEMPLATE_ID,
  AGENTOS_ALLOWED_TENANT,
  evaluateAgentOsEligibility,
} from "../src/agentos-allowlist.js";
import { bootErrors } from "../src/config.js";
import { envConfig } from "./harness.js";

const CONFIGURED = AGENTOS_ALLOWED_TENANT;

describe("evaluateAgentOsEligibility", () => {
  it("is a no-op for every template other than the gated one", () => {
    const result = evaluateAgentOsEligibility({
      enabled: true,
      templateId: "isola-ai-sales-front-desk-agent@v1",
      requestTenantId: null,
      exposure: "PUBLIC",
      configuredTenantId: CONFIGURED,
    });
    expect(result).toEqual({ kind: "not_applicable" });
  });

  it("is a no-op even for a forged tenant, when the template does not match", () => {
    // Proves isolation: a request for an unrelated template carrying the
    // allowlisted tenant string must not be treated as an AgentOS concern at all.
    const result = evaluateAgentOsEligibility({
      enabled: true,
      templateId: "isola-internal-manager@v1",
      requestTenantId: CONFIGURED,
      exposure: "INTERNAL",
      configuredTenantId: CONFIGURED,
    });
    expect(result).toEqual({ kind: "not_applicable" });
  });

  it("is eligible when the request names no tenant at all — the SERVER supplies it", () => {
    const result = evaluateAgentOsEligibility({
      enabled: true,
      templateId: AGENTOS_ALLOWED_TEMPLATE_ID,
      requestTenantId: null,
      exposure: AGENTOS_ALLOWED_EXPOSURE,
      configuredTenantId: CONFIGURED,
    });
    expect(result).toEqual({ kind: "eligible", tenantId: CONFIGURED });
  });

  it("is eligible when the request merely ECHOES the configured tenant", () => {
    const result = evaluateAgentOsEligibility({
      enabled: true,
      templateId: AGENTOS_ALLOWED_TEMPLATE_ID,
      requestTenantId: CONFIGURED,
      exposure: AGENTOS_ALLOWED_EXPOSURE,
      configuredTenantId: CONFIGURED,
    });
    expect(result).toEqual({ kind: "eligible", tenantId: CONFIGURED });
  });

  it("REGRESSION: a forged context tenant cannot select a tenant the server is not configured for", () => {
    // This is the Codex finding. The server is configured for some OTHER
    // tenant; the caller forges the historically-allowlisted constant. Before
    // the fix this matched a compiled-in constant and routed. It must refuse.
    const result = evaluateAgentOsEligibility({
      enabled: true,
      templateId: AGENTOS_ALLOWED_TEMPLATE_ID,
      requestTenantId: AGENTOS_ALLOWED_TENANT,
      exposure: AGENTOS_ALLOWED_EXPOSURE,
      configuredTenantId: "a-different-configured-tenant",
    });
    expect(result.kind).toBe("refused");
    expect(result.kind === "refused" && result.reason).toContain("agentos_tenant_refused");
  });

  it("refuses a request naming any tenant other than the configured one", () => {
    const result = evaluateAgentOsEligibility({
      enabled: true,
      templateId: AGENTOS_ALLOWED_TEMPLATE_ID,
      requestTenantId: "someone-elses-tenant",
      exposure: AGENTOS_ALLOWED_EXPOSURE,
      configuredTenantId: CONFIGURED,
    });
    expect(result.kind).toBe("refused");
    expect(result.kind === "refused" && result.reason).toContain("agentos_tenant_refused");
  });

  it("never coerces a mismatched tenant to the configured one", () => {
    // Silently rewriting a caller's stated tenant would hide a misrouted
    // integration behind a working-looking run.
    const result = evaluateAgentOsEligibility({
      enabled: true,
      templateId: AGENTOS_ALLOWED_TEMPLATE_ID,
      requestTenantId: "someone-elses-tenant",
      exposure: AGENTOS_ALLOWED_EXPOSURE,
      configuredTenantId: CONFIGURED,
    });
    expect(result.kind).not.toBe("eligible");
  });

  it("reports not_configured when no server-side tenant is set — never falls back to a constant", () => {
    const result = evaluateAgentOsEligibility({
      enabled: true,
      templateId: AGENTOS_ALLOWED_TEMPLATE_ID,
      requestTenantId: AGENTOS_ALLOWED_TENANT,
      exposure: AGENTOS_ALLOWED_EXPOSURE,
      configuredTenantId: null,
    });
    expect(result).toEqual({ kind: "not_configured" });
  });

  it("refuses the wrong exposure for the gated template, even with the right tenant", () => {
    const result = evaluateAgentOsEligibility({
      enabled: true,
      templateId: AGENTOS_ALLOWED_TEMPLATE_ID,
      requestTenantId: CONFIGURED,
      exposure: "PUBLIC",
      configuredTenantId: CONFIGURED,
    });
    expect(result.kind).toBe("refused");
    expect(result.kind === "refused" && result.reason).toContain("agentos_exposure_refused");
  });

  it("checks tenant before exposure — a wrong tenant is named even when exposure is ALSO wrong", () => {
    const result = evaluateAgentOsEligibility({
      enabled: true,
      templateId: AGENTOS_ALLOWED_TEMPLATE_ID,
      requestTenantId: "wrong-tenant",
      exposure: "PUBLIC",
      configuredTenantId: CONFIGURED,
    });
    expect(result.kind).toBe("refused");
    expect(result.kind === "refused" && result.reason).toContain("agentos_tenant_refused");
  });

  it("is case-sensitive on the tenant id — no normalisation, no fuzzy matching", () => {
    const result = evaluateAgentOsEligibility({
      enabled: true,
      templateId: AGENTOS_ALLOWED_TEMPLATE_ID,
      requestTenantId: CONFIGURED.toLowerCase(),
      exposure: AGENTOS_ALLOWED_EXPOSURE,
      configuredTenantId: CONFIGURED,
    });
    // Guard against the constant itself accidentally being all-lowercase,
    // which would make this assertion pass vacuously.
    expect(CONFIGURED).not.toBe(CONFIGURED.toLowerCase());
    expect(result.kind).toBe("refused");
  });

  it("the returned tenant is ALWAYS the configured one, never the request's", () => {
    // Positive control for the whole fix: even on the eligible path, the value
    // that flows onward is the server's.
    const result = evaluateAgentOsEligibility({
      enabled: true,
      templateId: AGENTOS_ALLOWED_TEMPLATE_ID,
      requestTenantId: null,
      exposure: AGENTOS_ALLOWED_EXPOSURE,
      configuredTenantId: "server-chosen-tenant",
    });
    expect(result).toEqual({ kind: "eligible", tenantId: "server-chosen-tenant" });
  });
});

describe("the AGENTOS_ENABLED master switch", () => {
  it("is OFF when absent — absence must never mean on", () => {
    expect(envConfig({ AGENTOS_ENABLED: undefined }).agentOsEnabled).toBe(false);
  });

  it("routes NOTHING into AgentOS when disabled, even a perfectly eligible request", () => {
    const result = evaluateAgentOsEligibility({
      enabled: false,
      templateId: AGENTOS_ALLOWED_TEMPLATE_ID,
      requestTenantId: CONFIGURED,
      exposure: AGENTOS_ALLOWED_EXPOSURE,
      configuredTenantId: CONFIGURED,
    });
    expect(result).toEqual({ kind: "not_applicable" });
  });

  it("does not REFUSE on an AgentOS ground when disabled — a wrong tenant is simply not its business", () => {
    // A disabled runtime must behave as though the feature does not exist:
    // no routing AND no refusal, or turning the feature off would still
    // change how unrelated requests are answered.
    const result = evaluateAgentOsEligibility({
      enabled: false,
      templateId: AGENTOS_ALLOWED_TEMPLATE_ID,
      requestTenantId: "someone-elses-tenant",
      exposure: "PUBLIC",
      configuredTenantId: null,
    });
    expect(result).toEqual({ kind: "not_applicable" });
  });
});

describe("the AgentOS settings are boot-fatal ONLY when AGENTOS_ENABLED is on", () => {
  /**
   * THE PRODUCTION-OUTAGE REGRESSION. `deploy/isola-rt-stack.yml` defines none
   * of the three AgentOS settings. While they were unconditionally boot-fatal,
   * deploying this image with that stack file would have boot-refused and taken
   * the live runtime out of service.
   */
  it("DISABLED with none of the three configured: boots clean", () => {
    const errors = bootErrors(
      envConfig({
        AGENTOS_ENABLED: undefined,
        AGENTOS_BASE_URL: undefined,
        AGENTOS_SHARED_SECRET: undefined,
        AGENTOS_TENANT_ID: undefined,
      }),
    );
    expect(errors).toEqual([]);
  });

  it("ENABLED + missing base URL: boot refused", () => {
    const errors = bootErrors(
      envConfig({ AGENTOS_ENABLED: "true", AGENTOS_BASE_URL: undefined }),
    );
    expect(errors.join(" | ")).toContain("AGENTOS_BASE_URL is unset");
  });

  it("ENABLED + missing shared secret: boot refused", () => {
    const errors = bootErrors(
      envConfig({ AGENTOS_ENABLED: "true", AGENTOS_SHARED_SECRET: undefined }),
    );
    expect(errors.join(" | ")).toContain("AGENTOS_SHARED_SECRET");
  });

  it("ENABLED + missing tenant: boot refused", () => {
    const errors = bootErrors(
      envConfig({ AGENTOS_ENABLED: "true", AGENTOS_TENANT_ID: undefined }),
    );
    expect(errors.join(" | ")).toContain("AGENTOS_TENANT_ID is unset");
  });

  it("POSITIVE CONTROL: ENABLED and fully configured is NOT fatal", () => {
    // Without this, every refusal test above would pass against a bootErrors()
    // that simply refused everything.
    expect(bootErrors(envConfig({ AGENTOS_ENABLED: "true" }))).toEqual([]);
  });

  it("the refusal names the VARIABLE, never a credential value", () => {
    const joined = bootErrors(
      envConfig({ AGENTOS_ENABLED: "true", AGENTOS_TENANT_ID: undefined }),
    ).join(" | ");
    expect(joined).not.toContain(envConfig().agentOsSharedSecret);
  });
});
