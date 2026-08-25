/**
 * THE STRUCTURED AGENT ACTION CONTRACT.
 *
 * The defect these tests exist for, measured on the real staging journey
 * 2026-08-25: two sentences carrying the same intent produced opposite
 * outcomes, because the intent was inferred from wording.
 *
 *   "a colleague will…"         -> the phrase list matched   -> escalated
 *   "I'll bring in a colleague" -> no phrase matched          -> NOBODY TOLD
 *
 * Under this contract the wording is free and the field decides, so the first
 * suite below drives several differently-worded human requests through and
 * requires the SAME action from all of them — with an ordinary use of the word
 * "colleague" as the control that must NOT escalate.
 */
import { describe, expect, it } from "vitest";

import {
  AGENT_ACTIONS,
  DEFAULT_ESCALATION_REASON,
  ESCALATION_REASON_CODES,
  STRUCTURED_OUTPUT_INSTRUCTION,
  isAgentAction,
  isEscalationReasonCode,
  parseAgentAction,
} from "../src/action.js";

/** Shorthand: the model emitted this envelope. */
function envelope(o: Record<string, unknown>): string {
  return JSON.stringify(o);
}

describe("differently worded human requests all produce request_human", () => {
  // Every one of these is a way a front desk might hand over. Under the phrase
  // heuristic only some of them matched; here the wording is irrelevant.
  const WORDINGS = [
    "A colleague will call you back shortly.",
    "I'll bring in a colleague who can help with that.",
    "Let me get one of our specialists to take this from here.",
    "I'm handing you over to a member of our team now.",
    "Someone from billing will pick this up.",
    "I'll escalate this to a person who can approve it.",
    // The exact sentence from the live measurement that did NOT match.
    "I'll bring in a colleague — they'll confirm the details with you.",
  ];

  for (const reply of WORDINGS) {
    it(`escalates regardless of wording: ${reply.slice(0, 42)}…`, () => {
      const out = parseAgentAction(envelope({ action: "request_human", reply }));
      expect(out.kind).toBe("ok");
      if (out.kind !== "ok") return;
      expect(out.action).toBe("request_human");
      // The customer-facing text survives verbatim and separately.
      expect(out.reply).toBe(reply);
    });
  }

  it("all seven wordings agree — the field decides, not the phrasing", () => {
    const actions = WORDINGS.map((reply) => {
      const out = parseAgentAction(envelope({ action: "request_human", reply }));
      return out.kind === "ok" ? out.action : `INVALID:${out.detail}`;
    });
    expect(new Set(actions)).toEqual(new Set(["request_human"]));
  });
});

describe("ordinary use of 'colleague' does not escalate", () => {
  // THE CONTROL for the suite above. Without it, "everything escalates" would
  // pass every test there and still be catastrophically wrong.
  const ORDINARY = [
    "A colleague handles installations, and they're available Tuesdays.",
    "My colleague wrote that guide — it covers the setup steps.",
    "Our team members are all trained on the fibre product.",
    "I can pass along your details once I have your number.",
  ];

  for (const reply of ORDINARY) {
    it(`stays an ordinary reply: ${reply.slice(0, 42)}…`, () => {
      const out = parseAgentAction(envelope({ action: "reply", reply }));
      expect(out.kind).toBe("ok");
      if (out.kind !== "ok") return;
      expect(out.action).toBe("reply");
      expect(out.reason).toBeNull();
    });
  }

  it("the word 'colleague' in the reply cannot by itself change the action", () => {
    const withWord = parseAgentAction(
      envelope({ action: "reply", reply: "A colleague will handle installs." }),
    );
    const withoutWord = parseAgentAction(
      envelope({ action: "reply", reply: "Installs are handled on Tuesdays." }),
    );
    expect(withWord.kind).toBe("ok");
    expect(withoutWord.kind).toBe("ok");
    if (withWord.kind !== "ok" || withoutWord.kind !== "ok") return;
    // "a colleague will" is a literal member of the old ESCALATION_PHRASES list.
    // Under the old mechanism this exact reply escalated. It must not now.
    expect(withWord.action).toBe(withoutWord.action);
    expect(withWord.action).toBe("reply");
  });
});

describe("the model cannot choose a destination", () => {
  it("ignores any identifier the model tries to smuggle in", () => {
    const out = parseAgentAction(
      envelope({
        action: "request_human",
        reply: "Bringing in a colleague.",
        reason: "explicit_human_request",
        // Every one of these is a routing decision the model does not get to make.
        teamId: 99,
        team: "billing",
        assigneeId: 7,
        accountId: 3,
        inboxId: 4,
        conversationId: 12345,
      }),
    );
    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") return;
    // The parse result has NO field through which any of them could travel.
    expect(Object.keys(out).sort()).toEqual(
      ["action", "actionDefaulted", "kind", "reason", "reasonRejected", "reply"].sort(),
    );
    expect(JSON.stringify(out)).not.toContain("99");
    expect(JSON.stringify(out)).not.toContain("billing");
  });

  it("a team named in the REPLY text is just text and routes nothing", () => {
    const out = parseAgentAction(
      envelope({
        action: "request_human",
        reply: "I'll send this to the billing team, ticket queue 99.",
      }),
    );
    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") return;
    expect(out.action).toBe("request_human");
    // No structured destination is produced from prose. The gateway resolves
    // the team from the binding and never from here.
    expect(out.reason).toBeNull();
  });
});

describe("malformed or unknown input fails closed", () => {
  it("refuses an unknown action rather than coercing it", () => {
    const out = parseAgentAction(
      envelope({ action: "transfer_to_billing", reply: "One moment." }),
    );
    expect(out.kind).toBe("invalid");
    if (out.kind !== "invalid") return;
    expect(out.detail).toContain("action is present but not one of");
  });

  it("does not echo the unknown action value (it may carry customer content)", () => {
    const out = parseAgentAction(
      envelope({ action: "call john on 555-0100", reply: "One moment." }),
    );
    expect(out.kind).toBe("invalid");
    if (out.kind !== "invalid") return;
    expect(out.detail).not.toContain("555-0100");
    expect(out.detail).not.toContain("john");
  });

  it.each([
    ["not json at all", "I'll bring in a colleague."],
    ["a json array", "[]"],
    ["a json string", '"request_human"'],
    ["a json number", "42"],
    ["json null", "null"],
    ["an empty object", "{}"],
    ["an object with no reply", '{"action":"request_human"}'],
    ["an empty reply", '{"action":"reply","reply":""}'],
    ["a whitespace reply", '{"action":"reply","reply":"   "}'],
    ["a non-string reply", '{"action":"reply","reply":123}'],
    ["truncated json", '{"action":"reply","reply":"hel'],
  ])("refuses %s", (_label, raw) => {
    expect(parseAgentAction(raw).kind).toBe("invalid");
  });

  it("refuses null content", () => {
    expect(parseAgentAction(null).kind).toBe("invalid");
  });

  it("CONTROL — a well-formed envelope is accepted, so the refusals above mean something", () => {
    const out = parseAgentAction(envelope({ action: "reply", reply: "Hello." }));
    expect(out.kind).toBe("ok");
  });
});

describe("a missing action defaults to reply, and is flagged", () => {
  // The SAFE direction. A missing action must never manufacture an escalation;
  // the worst case is the pre-existing behaviour of not escalating.
  it("defaults to reply", () => {
    const out = parseAgentAction(envelope({ reply: "We're open until six." }));
    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") return;
    expect(out.action).toBe("reply");
    expect(out.actionDefaulted).toBe(true);
  });

  it("an explicit action is NOT flagged as defaulted", () => {
    const out = parseAgentAction(envelope({ action: "reply", reply: "Hi." }));
    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") return;
    expect(out.actionDefaulted).toBe(false);
  });

  it("a missing action can never yield request_human, whatever the reply says", () => {
    const out = parseAgentAction(
      envelope({ reply: "I'm bringing in a colleague right now." }),
    );
    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") return;
    expect(out.action).toBe("reply");
  });
});

describe("reason codes are bounded", () => {
  for (const code of ESCALATION_REASON_CODES) {
    it(`accepts the ratified code ${code}`, () => {
      const out = parseAgentAction(
        envelope({ action: "request_human", reply: "One moment.", reason: code }),
      );
      expect(out.kind).toBe("ok");
      if (out.kind !== "ok") return;
      expect(out.reason).toBe(code);
      expect(out.reasonRejected).toBe(false);
    });
  }

  it("drops an unknown reason but still delivers the reply", () => {
    const out = parseAgentAction(
      envelope({
        action: "request_human",
        reply: "One moment.",
        reason: "customer said their card number is 4111 1111 1111 1111",
      }),
    );
    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") return;
    // The audit trail must never receive prose or customer content.
    expect(out.reason).toBeNull();
    expect(out.reasonRejected).toBe(true);
    expect(out.reply).toBe("One moment.");
  });

  it("never carries a reason on an ordinary reply", () => {
    const out = parseAgentAction(
      envelope({ action: "reply", reply: "Sure.", reason: "policy_boundary" }),
    );
    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") return;
    expect(out.reason).toBeNull();
  });

  it("every ratified code matches the ownership ledger's code shape", () => {
    // `services/isola-gateway/src/ownership.ts` throws on anything else, so a
    // code that failed this would fail the escalation at write time.
    const REASON_CODE_PATTERN = /^[a-z0-9][a-z0-9_.:-]{0,63}$/;
    for (const code of ESCALATION_REASON_CODES) {
      expect(REASON_CODE_PATTERN.test(code)).toBe(true);
    }
    expect(REASON_CODE_PATTERN.test(DEFAULT_ESCALATION_REASON)).toBe(true);
    // CONTROL: the pattern genuinely rejects something.
    expect(REASON_CODE_PATTERN.test("Customer asked for a human")).toBe(false);
  });
});

describe("prototype safety", () => {
  it("does not read an inherited action", () => {
    // JSON.parse cannot produce this, but the parser must not depend on that.
    const raw = '{"reply":"hi"}';
    const proto = { action: "request_human" };
    const original = Object.getPrototypeOf(Object.prototype);
    void original;
    void proto;
    // Simulate the hazard directly against the exported parser's contract by
    // polluting Object.prototype for the duration of the assertion.
    (Object.prototype as unknown as Record<string, unknown>)["action"] =
      "request_human";
    try {
      const out = parseAgentAction(raw);
      expect(out.kind).toBe("ok");
      if (out.kind !== "ok") return;
      // Must fall back to the safe default, NOT the inherited escalation.
      expect(out.action).toBe("reply");
      expect(out.actionDefaulted).toBe(true);
    } finally {
      delete (Object.prototype as unknown as Record<string, unknown>)["action"];
    }
  });

  it("CONTROL — the pollution above is actually visible on a plain object", () => {
    (Object.prototype as unknown as Record<string, unknown>)["action"] = "x";
    try {
      expect(({} as Record<string, unknown>)["action"]).toBe("x");
    } finally {
      delete (Object.prototype as unknown as Record<string, unknown>)["action"];
    }
  });
});

describe("fenced output is tolerated without weakening the schema", () => {
  it("accepts a ```json fence", () => {
    const out = parseAgentAction(
      '```json\n{"action":"request_human","reply":"One moment."}\n```',
    );
    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") return;
    expect(out.action).toBe("request_human");
  });

  it("a fenced UNKNOWN action is still refused", () => {
    const out = parseAgentAction('```json\n{"action":"nope","reply":"hi"}\n```');
    expect(out.kind).toBe("invalid");
  });
});

describe("the prompt instruction states the contract it will be judged against", () => {
  it("names both actions and every reason code", () => {
    for (const a of AGENT_ACTIONS) expect(STRUCTURED_OUTPUT_INSTRUCTION).toContain(a);
    for (const r of ESCALATION_REASON_CODES) {
      expect(STRUCTURED_OUTPUT_INSTRUCTION).toContain(r);
    }
  });

  it("satisfies DeepSeek's json-mode requirements: the word json and an example", () => {
    // api-docs.deepseek.com/guides/json_mode — generation can fail without both.
    expect(STRUCTURED_OUTPUT_INSTRUCTION.toLowerCase()).toContain("json");
    expect(STRUCTURED_OUTPUT_INSTRUCTION).toContain('"action": "reply"');
    expect(STRUCTURED_OUTPUT_INSTRUCTION).toContain('"action": "request_human"');
  });

  it("tells the model it does not choose a destination", () => {
    expect(STRUCTURED_OUTPUT_INSTRUCTION).toContain("You do not choose who this goes to");
  });

  it("its own examples parse under the parser that will judge them", () => {
    // A worked example that the validator would reject is worse than none: it
    // teaches the model to emit something that fails closed.
    const examples = STRUCTURED_OUTPUT_INSTRUCTION.split("\n").filter((l) =>
      l.trim().startsWith('{"action"'),
    );
    expect(examples.length).toBeGreaterThanOrEqual(2);
    for (const ex of examples) {
      const out = parseAgentAction(ex.trim());
      expect(out.kind).toBe("ok");
    }
  });
});

describe("type guards", () => {
  it("isAgentAction accepts exactly the two verbs", () => {
    expect(isAgentAction("reply")).toBe(true);
    expect(isAgentAction("request_human")).toBe(true);
    expect(isAgentAction("Reply")).toBe(false);
    expect(isAgentAction("")).toBe(false);
    expect(isAgentAction(null)).toBe(false);
    expect(isAgentAction(1)).toBe(false);
  });

  it("isEscalationReasonCode accepts exactly the seven codes", () => {
    expect(ESCALATION_REASON_CODES).toHaveLength(7);
    for (const c of ESCALATION_REASON_CODES) expect(isEscalationReasonCode(c)).toBe(true);
    expect(isEscalationReasonCode("something_else")).toBe(false);
  });
});
