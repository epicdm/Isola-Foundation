import { describe, expect, it } from "vitest";

import { verifyAgentCallerProof } from "../src/agent-caller-proof.js";

const GATED = "epic-staff-operations-coordinator@v1";
const UNGATED = "isola-ai-sales-front-desk-agent@v1";
const REQUIRED = new Set([GATED]);
const PROOF_MAP = Object.freeze({ "agent-7": "correct-proof-value" });

describe("verifyAgentCallerProof", () => {
  it("not_required for a template outside the gated set, regardless of agentId/proof", () => {
    expect(
      verifyAgentCallerProof({
        templateId: UNGATED,
        agentId: null,
        suppliedProof: null,
        requiredForTemplateIds: REQUIRED,
        proofByAgentId: PROOF_MAP,
      }),
    ).toEqual({ kind: "not_required" });
  });

  it("ok when the supplied proof matches the value configured for this exact agentId", () => {
    expect(
      verifyAgentCallerProof({
        templateId: GATED,
        agentId: "agent-7",
        suppliedProof: "correct-proof-value",
        requiredForTemplateIds: REQUIRED,
        proofByAgentId: PROOF_MAP,
      }),
    ).toEqual({ kind: "ok" });
  });

  it("missing_agent_id when the gated template is invoked with no agentId at all", () => {
    expect(
      verifyAgentCallerProof({
        templateId: GATED,
        agentId: null,
        suppliedProof: "correct-proof-value",
        requiredForTemplateIds: REQUIRED,
        proofByAgentId: PROOF_MAP,
      }),
    ).toEqual({ kind: "missing_agent_id" });
  });

  it("no_proof_configured_for_agent when the map has no entry for this agentId -- refuses even a syntactically valid caller", () => {
    expect(
      verifyAgentCallerProof({
        templateId: GATED,
        agentId: "agent-unknown",
        suppliedProof: "anything",
        requiredForTemplateIds: REQUIRED,
        proofByAgentId: PROOF_MAP,
      }),
    ).toEqual({ kind: "no_proof_configured_for_agent" });
  });

  it("no_proof_configured_for_agent when the map is EMPTY -- the fail-closed default, not fail-open", () => {
    expect(
      verifyAgentCallerProof({
        templateId: GATED,
        agentId: "agent-7",
        suppliedProof: "anything",
        requiredForTemplateIds: REQUIRED,
        proofByAgentId: {},
      }),
    ).toEqual({ kind: "no_proof_configured_for_agent" });
  });

  it("missing_proof when this exact agentId HAS a configured value but the caller supplied none", () => {
    expect(
      verifyAgentCallerProof({
        templateId: GATED,
        agentId: "agent-7",
        suppliedProof: null,
        requiredForTemplateIds: REQUIRED,
        proofByAgentId: PROOF_MAP,
      }),
    ).toEqual({ kind: "missing_proof" });
  });

  it("proof_mismatch when the supplied proof does not equal the configured value for this agentId -- a DIFFERENT agent's real proof is still a mismatch", () => {
    expect(
      verifyAgentCallerProof({
        templateId: GATED,
        agentId: "agent-7",
        suppliedProof: "some-other-agents-proof",
        requiredForTemplateIds: REQUIRED,
        proofByAgentId: { "agent-7": "correct-proof-value", "agent-8": "some-other-agents-proof" },
      }),
    ).toEqual({ kind: "proof_mismatch" });
  });

  it("holding the shared exposure bearer alone is never sufficient for a gated template -- a caller with no proof at all is refused even with a perfectly valid agentId", () => {
    const result = verifyAgentCallerProof({
      templateId: GATED,
      agentId: "agent-7",
      suppliedProof: null,
      requiredForTemplateIds: REQUIRED,
      proofByAgentId: PROOF_MAP,
    });
    expect(result.kind).not.toBe("ok");
    expect(result.kind).not.toBe("not_required");
  });
});
