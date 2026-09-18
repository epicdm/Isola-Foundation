import { describe, expect, it } from "vitest";

import { verifyAgentCallerProof } from "../src/agent-caller-proof.js";

const GATED = "epic-staff-operations-coordinator@v1";
const UNGATED = "isola-ai-sales-front-desk-agent@v1";
const REQUIRED = new Set([GATED]);
const AGENT = "agent-real-42";

describe("verifyAgentCallerProof", () => {
  it("not_required for a template outside the gated set, regardless of agentId/credentialAgentId", () => {
    expect(
      verifyAgentCallerProof({
        templateId: UNGATED,
        agentId: null,
        credentialAgentId: null,
        requiredForTemplateIds: REQUIRED,
      }),
    ).toEqual({ kind: "not_required" });
  });

  it("ok when the credential-proven agent id matches the claimed agentId", () => {
    expect(
      verifyAgentCallerProof({
        templateId: GATED,
        agentId: AGENT,
        credentialAgentId: AGENT,
        requiredForTemplateIds: REQUIRED,
      }),
    ).toEqual({ kind: "ok" });
  });

  it("missing_agent_id when the gated template is invoked with no agentId at all", () => {
    expect(
      verifyAgentCallerProof({
        templateId: GATED,
        agentId: null,
        credentialAgentId: AGENT,
        requiredForTemplateIds: REQUIRED,
      }),
    ).toEqual({ kind: "missing_agent_id" });
  });

  it("no_agent_bound_credential when the caller's credential proves no agent identity at all -- includes every caller holding only the shared exposure bearer", () => {
    expect(
      verifyAgentCallerProof({
        templateId: GATED,
        agentId: AGENT,
        credentialAgentId: null,
        requiredForTemplateIds: REQUIRED,
      }),
    ).toEqual({ kind: "no_agent_bound_credential" });
  });

  it("agent_identity_mismatch when the credential proves a DIFFERENT agent than the one claimed", () => {
    expect(
      verifyAgentCallerProof({
        templateId: GATED,
        agentId: AGENT,
        credentialAgentId: "some-other-agent",
        requiredForTemplateIds: REQUIRED,
      }),
    ).toEqual({ kind: "agent_identity_mismatch" });
  });

  it("holding the shared exposure bearer alone is NEVER sufficient for a gated template -- even with a perfectly valid claimed agentId", () => {
    const result = verifyAgentCallerProof({
      templateId: GATED,
      agentId: AGENT,
      credentialAgentId: null,
      requiredForTemplateIds: REQUIRED,
    });
    expect(result.kind).not.toBe("ok");
    expect(result.kind).not.toBe("not_required");
  });

  it("NO INSECURE FALLBACK: every non-ok, non-not_required outcome is a refusal -- there is no branch that treats a mismatch as acceptable", () => {
    const outcomes = [
      verifyAgentCallerProof({ templateId: GATED, agentId: null, credentialAgentId: AGENT, requiredForTemplateIds: REQUIRED }),
      verifyAgentCallerProof({ templateId: GATED, agentId: AGENT, credentialAgentId: null, requiredForTemplateIds: REQUIRED }),
      verifyAgentCallerProof({ templateId: GATED, agentId: AGENT, credentialAgentId: "wrong", requiredForTemplateIds: REQUIRED }),
    ];
    for (const outcome of outcomes) {
      expect(["ok", "not_required"]).not.toContain(outcome.kind);
    }
  });
});
