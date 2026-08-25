/**
 * STRUCTURED AI-INITIATED ESCALATION, THROUGH THE GATEWAY.
 *
 * The defect, measured on the real staging journey 2026-08-25:
 *
 *   "a colleague will…"          -> a phrase matched -> team assigned
 *   "I'll bring in a colleague"  -> nothing matched  -> NOBODY WAS TOLD
 *
 * Same intent, opposite outcome, decided by wording the model was never asked
 * to control. These tests drive the whole delivery path — webhook in, Chatwoot
 * writes out — and require that the ACTION decides and the wording does not.
 *
 * The precedence rule under test:
 *   action !== null  -> the action decides, the reply text is never inspected
 *   action === null  -> the legacy phrase heuristic decides (the rollback path)
 * so the two mechanisms are the two arms of one branch and can never both fire.
 */
import { describe, expect, it } from "vitest";

import {
  bindingsJson,
  CapturingLogger,
  envConfig,
  makeBinding,
  postWebhook,
  signRequest,
  startServer,
  StubAgentRuntime,
  StubChatwootApi,
  type RecordedChatwootCall,
} from "./harness.js";

/**
 * The staging binding's configured escalation team. The default test binding
 * has NO team, and `escalate()` skips the assignment entirely when there is
 * none — so without this every "no assignment" assertion below would pass
 * vacuously, and every "one assignment" assertion would fail for the wrong
 * reason. The control in each block exists for the same purpose.
 */
const ESCALATION_TEAM_ID = 4;

function configWith(overrides: Record<string, string> = {}) {
  return envConfig({
    GATEWAY_BINDINGS_JSON: bindingsJson([
      makeBinding({ escalationTeamId: ESCALATION_TEAM_ID }),
    ]),
    ...overrides,
  });
}

async function deliver(args: {
  runtime: StubAgentRuntime;
  chatwoot?: StubChatwootApi;
  config?: ReturnType<typeof envConfig>;
  logger?: CapturingLogger;
}) {
  const logger = args.logger ?? new CapturingLogger();
  const server = await startServer({
    runtime: args.runtime,
    ...(args.chatwoot === undefined ? {} : { chatwoot: args.chatwoot }),
    config: args.config ?? configWith(),
    logger: logger.logger,
  });
  const res = await postWebhook(server.url, signRequest());
  await server.gateway.drain();
  const chatwoot = server.chatwoot;
  await server.close();
  return { res, chatwoot, logger };
}

/** Team assignments Chatwoot actually received. */
function assignments(chatwoot: StubChatwootApi): RecordedChatwootCall[] {
  return chatwoot.calls.filter((c) => c.kind === "assignment");
}

describe("differently worded human requests all assign the team", () => {
  // Every one of these carries `action: "request_human"`. Only the prose
  // differs — including the two sentences from the live measurement.
  const WORDINGS = [
    "A colleague will call you back shortly.",
    "I'll bring in a colleague who can help with that.",
    "Let me get one of our specialists to take this from here.",
    "I'm handing you over to a member of our team now.",
    "Someone from billing will pick this up.",
  ];

  for (const reply of WORDINGS) {
    it(`assigns regardless of wording: ${reply.slice(0, 40)}…`, async () => {
      const { chatwoot } = await deliver({
        runtime: StubAgentRuntime.answeringWithAction(reply, "request_human"),
      });

      // The customer still gets the reply — the handover is announced, not silent.
      expect(chatwoot.customerMessages).toHaveLength(1);
      expect(chatwoot.customerMessages[0]?.content).toBe(reply);
      // And a human is actually told.
      expect(assignments(chatwoot)).toHaveLength(1);
      expect(assignments(chatwoot)[0]?.teamId).toBe(ESCALATION_TEAM_ID);
    });
  }

  it("THE DEFECT: the two live sentences now behave identically", async () => {
    const results: number[] = [];
    for (const reply of [
      "A colleague will call you back shortly.", // used to escalate
      "I'll bring in a colleague who can help with that.", // used to be silent
    ]) {
      const { chatwoot } = await deliver({
        runtime: StubAgentRuntime.answeringWithAction(reply, "request_human"),
      });
      results.push(assignments(chatwoot).length);
    }
    expect(results).toEqual([1, 1]);
  });
});

describe("ordinary use of 'colleague' does not escalate", () => {
  it("a reply carrying a legacy trigger phrase does NOT assign when the action says reply", async () => {
    // "a colleague will" is a literal member of ESCALATION_PHRASES. Under the
    // old mechanism this exact sentence assigned a team. The agent has now said
    // explicitly that no human is needed, and that must win.
    const reply = "A colleague will handle the installation on Tuesday.";
    const { chatwoot } = await deliver({
      runtime: StubAgentRuntime.answeringWithAction(reply, "reply"),
    });

    expect(chatwoot.customerMessages).toHaveLength(1);
    expect(assignments(chatwoot)).toHaveLength(0);
    expect(chatwoot.statusToggles).toHaveLength(0);
  });

  it.each([
    "My colleague wrote that guide.",
    "I can pass this to our order form once you're ready.",
    "Our team members are trained on the fibre product.",
  ])("stays an ordinary reply: %s", async (reply) => {
    const { chatwoot } = await deliver({
      runtime: StubAgentRuntime.answeringWithAction(reply, "reply"),
    });
    expect(assignments(chatwoot)).toHaveLength(0);
  });

  it("CONTROL — the same harness DOES assign when the action asks for it", async () => {
    // Without this, "no assignment" above could equally mean the harness cannot
    // assign at all, and every test in this block would pass vacuously.
    const { chatwoot } = await deliver({
      runtime: StubAgentRuntime.answeringWithAction(
        "A colleague will handle the installation on Tuesday.",
        "request_human",
      ),
    });
    expect(assignments(chatwoot)).toHaveLength(1);
  });
});

describe("the model cannot select another team", () => {
  it("assigns the BINDING's team, never anything the reply names", async () => {
    const { chatwoot } = await deliver({
      runtime: StubAgentRuntime.answeringWithAction(
        "Sending this to team 99, the escalations desk, assignee 7.",
        "request_human",
      ),
    });
    const assigned = assignments(chatwoot);
    expect(assigned).toHaveLength(1);
    expect(assigned[0]?.teamId).toBe(ESCALATION_TEAM_ID);
    expect(assigned[0]?.teamId).not.toBe(99);
    expect(assigned[0]?.teamId).not.toBe(7);
  });

  it("an action this build cannot perform FAILS CLOSED — no reply, human shown", async () => {
    // Adversarial review, 2026-08-25. The first draft degraded an unrecognised
    // action to the legacy path and SENT the reply. That is unsafe: the reply
    // may describe the very action that was requested ("I've arranged your
    // callback"), so the customer would be told something happened that did
    // not. A future runtime meeting an old gateway is exactly when that would
    // be hardest to notice.
    const { chatwoot } = await deliver({
      runtime: new StubAgentRuntime(async () => ({
        text: "I've arranged a callback for you.",
        action: null,
        actionUnrecognised: true,
        actionReason: null,
        outcome: "ok",
        correlationId: "c",
        completionState: "completed",
        contractVersion: 99,
      })),
    });
    // The answer is WITHHELD.
    expect(chatwoot.customerMessages).toHaveLength(0);
    // And a human is shown the conversation.
    expect(assignments(chatwoot)).toHaveLength(1);
  });

  it("CONTROL — the same runtime with a KNOWN action does send the reply", async () => {
    const { chatwoot } = await deliver({
      runtime: StubAgentRuntime.answeringWithAction("I've noted that.", "reply"),
    });
    expect(chatwoot.customerMessages).toHaveLength(1);
  });
});

describe("the runtime client's own validation", () => {
  it("classifies an unknown action as unrecognised, NOT as absent", async () => {
    // The distinction decides what is safe: absent -> legacy fallback,
    // unrecognised -> fail closed. Collapsing them loses that.
    const { readAgentAction, readActionReason } = await import("../src/runtime.js");
    expect(readAgentAction({ action: "transfer_to_team_99" })).toEqual({
      kind: "unrecognised",
    });
    expect(readAgentAction({})).toEqual({ kind: "absent" });
    expect(readAgentAction({ action: null })).toEqual({ kind: "absent" });
    expect(readAgentAction({ action: "request_human" })).toEqual({
      kind: "known",
      action: "request_human",
    });
  });

  it("refuses a reason outside the seven ratified codes, even if code-shaped", async () => {
    // `card_4111111111111111` passes the ownership code PATTERN and would be
    // written verbatim to the audit table. Shape is not membership.
    const { readActionReason } = await import("../src/runtime.js");
    expect(readActionReason({ actionReason: "card_4111111111111111" })).toBeNull();
    expect(readActionReason({ actionReason: "Customer asked for a human" })).toBeNull();
    // CONTROL — a ratified code is accepted, so the refusals mean something.
    expect(readActionReason({ actionReason: "complaint_sensitive" })).toBe(
      "complaint_sensitive",
    );
  });

  it("an unbounded reason degrades to the default code, never to free text", async () => {
    const logger = new CapturingLogger();
    await deliver({
      runtime: new StubAgentRuntime(async () => ({
        text: "Bringing in a colleague.",
        action: "request_human" as const,
        actionUnrecognised: false,
        // What a compromised or buggy runtime might send.
        actionReason: "card_4111111111111111",
        outcome: "ok",
        correlationId: "c",
        completionState: "completed" as const,
        contractVersion: 2,
      })),
      logger,
    });
    const line = logger.withOutcome("human_promised")[0];
    expect(line?.["escalationReason"]).toBe("explicit_human_request");
    expect(String(line?.["escalationReason"])).not.toContain("4111");
  });
});

describe("the ledger records HUMAN_REQUESTED exactly once", () => {
  it("a structured escalation moves ownership and suppresses the AI", async () => {
    const logger = new CapturingLogger();
    const { chatwoot } = await deliver({
      runtime: StubAgentRuntime.answeringWithAction(
        "I'll bring in a colleague.",
        "request_human",
        "complaint_sensitive",
      ),
      logger,
    });

    expect(assignments(chatwoot)).toHaveLength(1);

    const promised = logger.withOutcome("human_promised")[0];
    expect(promised).toBeDefined();
    // WHICH MECHANISM DECIDED — the field that makes the two paths
    // distinguishable in staging without an investigation.
    expect(promised?.["escalationSource"]).toBe("structured_action");
    expect(promised?.["agentAction"]).toBe("request_human");
    expect(promised?.["escalationReason"]).toBe("complaint_sensitive");
    // The phrase list was never consulted.
    expect(promised?.["matchedPhrases"]).toEqual([]);
  });

  it("an escalation with no reason falls back to the ratified default code", async () => {
    const logger = new CapturingLogger();
    await deliver({
      runtime: StubAgentRuntime.answeringWithAction("One moment.", "request_human"),
      logger,
    });
    expect(logger.withOutcome("human_promised")[0]?.["escalationReason"]).toBe(
      "explicit_human_request",
    );
  });

  it("a duplicate webhook produces exactly ONE assignment", async () => {
    // Chatwoot redelivers. The escalation is keyed on the delivery's ledger
    // identity, so a redelivery claims the same operation and does not assign
    // a second time.
    const logger = new CapturingLogger();
    const runtime = StubAgentRuntime.answeringWithAction(
      "Bringing in a colleague.",
      "request_human",
    );
    const server = await startServer({
      runtime,
      config: configWith(),
      logger: logger.logger,
    });

    const signed = signRequest();
    await postWebhook(server.url, signed);
    await server.gateway.drain();
    await postWebhook(server.url, signed);
    await server.gateway.drain();

    const chatwoot = server.chatwoot;
    await server.close();

    expect(assignments(chatwoot)).toHaveLength(1);
    // And exactly one customer-facing message, too.
    expect(chatwoot.customerMessages).toHaveLength(1);
  });
});

describe("the legacy phrase heuristic is the fallback, and only the fallback", () => {
  it("a pre-v2 runtime (action null) still escalates on a matching phrase", async () => {
    // THE ROLLBACK PATH. `StubAgentRuntime.answering` returns action: null.
    const { chatwoot } = await deliver({
      runtime: StubAgentRuntime.answering("I'm passing this to a colleague now."),
    });
    expect(assignments(chatwoot)).toHaveLength(1);
  });

  it("a pre-v2 runtime does NOT escalate on a non-matching phrase — the original defect", async () => {
    const { chatwoot } = await deliver({
      runtime: StubAgentRuntime.answering("I'll bring in a colleague who can help."),
    });
    // This is the bug, still present on the legacy path by construction. It is
    // pinned here so the difference the structured path makes is measurable
    // rather than asserted.
    expect(assignments(chatwoot)).toHaveLength(0);
  });

  it("the heuristic is NEVER consulted when an action is present", async () => {
    const logger = new CapturingLogger();
    const { chatwoot } = await deliver({
      // A reply stuffed with legacy trigger phrases, and an action saying no.
      runtime: StubAgentRuntime.answeringWithAction(
        "I'm passing this to a colleague, a team member will connect you with someone.",
        "reply",
      ),
      logger,
    });
    expect(assignments(chatwoot)).toHaveLength(0);
    expect(logger.withOutcome("human_promised")).toHaveLength(0);
  });

  it("both mechanisms can never assign for the same delivery", async () => {
    // Structural: they are two arms of one branch. Whatever the reply says,
    // exactly one decision is made and at most one assignment happens.
    for (const [text, action] of [
      ["I'm passing this to a colleague.", "request_human"],
      ["I'm passing this to a colleague.", "reply"],
    ] as const) {
      const { chatwoot } = await deliver({
        runtime: StubAgentRuntime.answeringWithAction(text, action),
      });
      expect(assignments(chatwoot).length).toBeLessThanOrEqual(1);
      expect(assignments(chatwoot)).toHaveLength(action === "request_human" ? 1 : 0);
    }
  });
});

describe("the heuristic can be disabled in staging", () => {
  function heuristicOff(): ReturnType<typeof envConfig> {
    return configWith({ GATEWAY_ESCALATION_PHRASE_HEURISTIC: "off" });
  }

  it("defaults ON, so no existing deployment changes on upgrade", () => {
    expect(envConfig().escalationPhraseHeuristic).toBe(true);
  });

  it("turns OFF explicitly", () => {
    expect(heuristicOff().escalationPhraseHeuristic).toBe(false);
  });

  it("with it off, a pre-v2 runtime no longer escalates on wording", async () => {
    const { chatwoot } = await deliver({
      runtime: StubAgentRuntime.answering("I'm passing this to a colleague now."),
      config: heuristicOff(),
    });
    expect(assignments(chatwoot)).toHaveLength(0);
  });

  it("CONTROL — the same reply DOES escalate with the heuristic on", async () => {
    const { chatwoot } = await deliver({
      runtime: StubAgentRuntime.answering("I'm passing this to a colleague now."),
    });
    expect(assignments(chatwoot)).toHaveLength(1);
  });

  it("with it off, a structured escalation still works", async () => {
    // The flag must disable the FALLBACK, never the contract.
    const { chatwoot } = await deliver({
      runtime: StubAgentRuntime.answeringWithAction(
        "I'll bring in a colleague.",
        "request_human",
      ),
      config: heuristicOff(),
    });
    expect(assignments(chatwoot)).toHaveLength(1);
  });
});

describe("ordinary replies remain ordinary replies", () => {
  it("posts one customer message, no note, no toggle, no assignment", async () => {
    const { chatwoot } = await deliver({
      runtime: StubAgentRuntime.answeringWithAction(
        "A DID costs USD 2.50 per month.",
        "reply",
      ),
    });
    expect(chatwoot.customerMessages).toHaveLength(1);
    expect(chatwoot.privateNotes).toHaveLength(0);
    expect(chatwoot.statusToggles).toHaveLength(0);
    expect(assignments(chatwoot)).toHaveLength(0);
  });
});

describe("a failed run cannot ask for a human", () => {
  it("a runtime failure escalates on its OWN terms and sends no customer message", async () => {
    const { chatwoot } = await deliver({
      runtime: StubAgentRuntime.failingWithState("invalid_output", "invalid_output"),
    });
    // No fabricated reply — this is the fail-closed path a malformed structured
    // turn lands on.
    expect(chatwoot.customerMessages).toHaveLength(0);
    // A human is still told, because the failure path escalates.
    expect(assignments(chatwoot)).toHaveLength(1);
  });
});
