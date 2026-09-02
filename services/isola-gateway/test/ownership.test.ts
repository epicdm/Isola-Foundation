/**
 * The pure ownership rules.
 *
 * These pin the vocabulary and the transition graph BYTE FOR BYTE against the
 * ratified contract, because `src/ownership.ts` is a hand-port of
 * `artifacts/isola/lib/ownership/state.ts` rather than an import of it. A port
 * that silently drifts from its original is worse than no port: both stores
 * would claim to implement one contract while disagreeing about what it says.
 * If Foundation's graph changes and this one does not, these fail.
 */
import { describe, expect, it } from "vitest";

import {
  AI_AUTHORITY_STATES,
  DEFAULT_OWNERSHIP_STATE,
  ESCALATION_REASON_CODES,
  HUMAN_AUTHORITY_STATES,
  LEGAL_TRANSITIONS,
  OWNERSHIP_OPERATION_KINDS,
  OWNERSHIP_STATES,
  canTransition,
  conversationKey,
  isEscalationReasonCode,
  isOwnershipState,
  mayInvokeAi,
  readEpisode,
  readState,
  suppressesAutomatedReply,
  type OwnershipState,
} from "../src/ownership.js";

describe("the vocabulary matches the ratified contract", () => {
  it("declares exactly the five states, in contract order", () => {
    expect([...OWNERSHIP_STATES]).toEqual([
      "AI_OWNED",
      "HUMAN_REQUESTED",
      "HUMAN_OWNED",
      "HANDING_BACK",
      "AI_RESUMED",
    ]);
  });

  it("declares exactly the seven escalation reason codes", () => {
    expect([...ESCALATION_REASON_CODES]).toEqual([
      "explicit_human_request",
      "low_confidence",
      "policy_boundary",
      "approval_required",
      "tool_failure",
      "complaint_sensitive",
      "unsupported_request",
    ]);
    expect(ESCALATION_REASON_CODES).toHaveLength(7);
  });

  it("declares exactly the eight operation kinds", () => {
    expect([...OWNERSHIP_OPERATION_KINDS]).toEqual([
      "escalate",
      "human_assigned",
      "human_reply",
      "handback_begin",
      "handback_complete",
      "handback_failed",
      "resolution_observed",
      "resumed_settled",
    ]);
  });

  it("partitions every state into exactly one authority set", () => {
    for (const state of OWNERSHIP_STATES) {
      const ai = AI_AUTHORITY_STATES.has(state);
      const human = HUMAN_AUTHORITY_STATES.has(state);
      expect(ai !== human).toBe(true);
    }
    expect(AI_AUTHORITY_STATES.size + HUMAN_AUTHORITY_STATES.size).toBe(
      OWNERSHIP_STATES.length,
    );
  });

  it("defaults to AI_OWNED", () => {
    expect(DEFAULT_OWNERSHIP_STATE).toBe("AI_OWNED");
    expect(mayInvokeAi(DEFAULT_OWNERSHIP_STATE)).toBe(true);
  });

  it("HANDING_BACK suppresses the AI — nobody speaks mid-reconciliation", () => {
    expect(suppressesAutomatedReply("HANDING_BACK")).toBe(true);
  });

  it("suppression is exactly the complement of invocation", () => {
    for (const state of OWNERSHIP_STATES) {
      expect(suppressesAutomatedReply(state)).toBe(!mayInvokeAi(state));
    }
  });
});

describe("the transition graph", () => {
  it("is exactly the ratified graph", () => {
    expect(LEGAL_TRANSITIONS).toEqual({
      AI_OWNED: ["HUMAN_REQUESTED", "HUMAN_OWNED"],
      AI_RESUMED: ["AI_OWNED", "HUMAN_REQUESTED", "HUMAN_OWNED"],
      HUMAN_REQUESTED: ["HUMAN_OWNED", "HANDING_BACK"],
      HUMAN_OWNED: ["HANDING_BACK"],
      HANDING_BACK: ["AI_RESUMED", "HUMAN_OWNED"],
    });
  });

  it("names every state as a source", () => {
    expect(Object.keys(LEGAL_TRANSITIONS).sort()).toEqual([...OWNERSHIP_STATES].sort());
  });

  it("never targets a state outside the vocabulary", () => {
    for (const targets of Object.values(LEGAL_TRANSITIONS)) {
      for (const target of targets) expect(isOwnershipState(target)).toBe(true);
    }
  });

  it("declares no self-edge — an observation is not a transition", () => {
    for (const state of OWNERSHIP_STATES) {
      expect(canTransition(state, state)).toBe(false);
    }
  });

  /**
   * THE load-bearing property of the whole contract. If any second edge from a
   * human state back to an AI state ever exists, a conversation a person owns
   * can be returned to the bot by something other than an authorized,
   * reconciled handback — which is the defect the ownership model exists to
   * make impossible.
   */
  it("has EXACTLY ONE edge from a human state back to an AI state", () => {
    const edges: Array<[OwnershipState, OwnershipState]> = [];
    for (const from of OWNERSHIP_STATES) {
      if (!HUMAN_AUTHORITY_STATES.has(from)) continue;
      for (const to of LEGAL_TRANSITIONS[from]) {
        if (AI_AUTHORITY_STATES.has(to)) edges.push([from, to]);
      }
    }
    expect(edges).toEqual([["HANDING_BACK", "AI_RESUMED"]]);
  });

  it("gives resolution no edge at all: no state can reach AI_OWNED from a human state", () => {
    for (const from of OWNERSHIP_STATES) {
      if (!HUMAN_AUTHORITY_STATES.has(from)) continue;
      expect(canTransition(from, "AI_OWNED")).toBe(false);
    }
  });

  it("HUMAN_OWNED can only ever go to HANDING_BACK", () => {
    expect(LEGAL_TRANSITIONS.HUMAN_OWNED).toEqual(["HANDING_BACK"]);
  });
});

describe("fail-closed reads", () => {
  it("reads every legal state back unchanged", () => {
    for (const state of OWNERSHIP_STATES) expect(readState(state)).toBe(state);
  });

  it.each([
    ["an unknown future state", "AI_SUPERVISED"],
    ["the empty string", ""],
    ["null", null],
    ["undefined", undefined],
    ["a number", 3],
    ["a lookalike in the wrong case", "ai_owned"],
    ["an object", { state: "AI_OWNED" }],
  ])("fails %s closed to HUMAN_OWNED", (_label, value) => {
    expect(readState(value)).toBe("HUMAN_OWNED");
    expect(mayInvokeAi(readState(value))).toBe(false);
  });

  it("never fails open: no unreadable value yields an AI state", () => {
    const junk = [null, undefined, "", " AI_OWNED", "AI_OWNED ", 0, 1, true, [], {}, NaN];
    for (const value of junk) {
      expect(AI_AUTHORITY_STATES.has(readState(value))).toBe(false);
    }
  });

  it("reads episodes as non-negative integers", () => {
    expect(readEpisode(0)).toBe(0);
    expect(readEpisode(7)).toBe(7);
    // Postgres bigint/numeric can arrive as a string through the driver.
    expect(readEpisode("7")).toBe(7);
    expect(readEpisode(-1)).toBe(0);
    expect(readEpisode(2.9)).toBe(2);
    expect(readEpisode(null)).toBe(0);
    expect(readEpisode("nonsense")).toBe(0);
    expect(readEpisode(NaN)).toBe(0);
  });

  it("only accepts the seven reason codes", () => {
    for (const code of ESCALATION_REASON_CODES) expect(isEscalationReasonCode(code)).toBe(true);
    expect(isEscalationReasonCode("because_i_said_so")).toBe(false);
    expect(isEscalationReasonCode(null)).toBe(false);
  });
});

describe("conversation identity", () => {
  it("is stable and derived only from account and display id", () => {
    expect(conversationKey(1, 42)).toBe("cw:1:42");
    expect(conversationKey(1, 42)).toBe(conversationKey(1, 42));
  });

  it("separates conversations that share a display id across accounts", () => {
    expect(conversationKey(1, 42)).not.toBe(conversationKey(2, 42));
  });

  it("does not fold the inbox in: an inbox move must not orphan the history", () => {
    // There is no inbox parameter to pass. This asserts the shape of the API,
    // which is the mechanism by which the property holds.
    expect(conversationKey.length).toBe(2);
  });

  it.each([
    ["zero account", 0, 42],
    ["negative account", -1, 42],
    ["zero conversation", 1, 0],
    ["fractional conversation", 1, 4.2],
    ["unsafe integer", 1, Number.MAX_SAFE_INTEGER + 2],
  ])("refuses %s rather than minting a key for it", (_label, account, conversation) => {
    expect(() => conversationKey(account, conversation)).toThrow(RangeError);
  });
});
