/**
 * THE STRUCTURED ACTION CONTRACT, OVER HTTP.
 *
 * `action.test.ts` proves the parser. This proves the PATH: a real server, a
 * real request, the real registry, and the body a caller actually receives —
 * because a green parser with an unwired call site is exactly the failure
 * CLAUDE.md §2.20 was written after (mint→render, 13/13 green, feature broken).
 *
 * Four properties are pinned here:
 *   1. the PUBLIC template asks the provider for json_object and appends the
 *      contract instruction; the INTERNAL one does neither;
 *   2. `answerText` carries the REPLY, never the json envelope;
 *   3. `action` reaches the caller on success and is null on every failure;
 *   4. a malformed structured turn fails closed with no answer.
 */
import { afterEach, describe, expect, it } from "vitest";

import { STRUCTURED_OUTPUT_INSTRUCTION } from "../src/action.js";
import { RESPONSE_CONTRACT_VERSION } from "../src/response.js";
import { findTemplate } from "../src/registry.js";
import {
  INTERNAL_SECRET,
  INTERNAL_TEMPLATE,
  OVERDUE_FIXTURE,
  PUBLIC_SECRET,
  PUBLIC_TEMPLATE,
  RecordingRecorder,
  StubModelClient,
  envConfig,
  invoke,
  startServer,
  type TestServer,
} from "./harness.js";

const servers: TestServer[] = [];
afterEach(async () => {
  while (servers.length > 0) await servers.pop()?.close();
});

async function server(model: StubModelClient): Promise<TestServer> {
  // A recorder that accepts the write-back, so a good run can reach
  // `completed`. Without it every run reports `persistence_failed` and the
  // action field would never be exercised — the same trap the default config
  // set for the first draft of this suite.
  const s = await startServer({
    config: envConfig(),
    modelClient: model,
    recorder: new RecordingRecorder(),
  });
  servers.push(s);
  return s;
}

function publicBody(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    templateId: PUBLIC_TEMPLATE,
    exposure: "PUBLIC",
    agentId: "agent-1",
    runId: "11111111-1111-4111-8111-111111111111",
    responseMode: "inline",
    // Issue-driven, so the write-back has a target and the run can reach
    // `completed`. The conversation-ref path is proven separately in
    // `conversation.test.ts`; what is under test here is the ACTION contract.
    context: {
      issueId: "ISSUE-4821",
      chatwoot: { accountId: 3, conversationDisplayId: 900 },
    },
    ...extra,
  };
}

describe("the request the provider actually receives", () => {
  it("PUBLIC template: asks for json_object and appends the contract", async () => {
    const model = StubModelClient.returning("We're open until six.");
    const s = await server(model);
    const res = await invoke(s.url, { bearer: PUBLIC_SECRET, body: publicBody() });

    expect(res.status).toBe(200);
    expect(model.calls).toHaveLength(1);
    const call = model.calls[0]!;
    expect(call.responseFormat).toBe("json_object");
    const system = call.messages.find((m) => m.role === "system")!.content;
    expect(system).toContain(STRUCTURED_OUTPUT_INSTRUCTION);
    // The persona is still there — the instruction is appended, not substituted.
    expect(system).toContain("AI Sales Front Desk Agent");
  });

  it("INTERNAL template: no json_object, no contract instruction", async () => {
    // The internal coordinator answers with a markdown table. Forcing json on it
    // would break a working template to fix a different one.
    const model = StubModelClient.returning("| a | b |\n|---|---|");
    const s = await server(model);
    const res = await invoke(s.url, {
      bearer: INTERNAL_SECRET,
      body: {
        templateId: INTERNAL_TEMPLATE,
        exposure: "INTERNAL",
        agentId: "agent-1",
        runId: "22222222-2222-4222-8222-222222222222",
        responseMode: "inline",
        context: OVERDUE_FIXTURE,
      },
    });

    expect(res.status).toBe(200);
    const call = model.calls[0]!;
    expect(call.responseFormat).toBeUndefined();
    const system = call.messages.find((m) => m.role === "system")!.content;
    expect(system).not.toContain(STRUCTURED_OUTPUT_INSTRUCTION);
    expect(system).not.toContain("STRUCTURED OUTPUT");
  });

  it("the registry marks exactly the customer-facing template as structured", () => {
    expect(findTemplate(PUBLIC_TEMPLATE)!.structuredOutput).toBe(true);
    expect(findTemplate(INTERNAL_TEMPLATE)!.structuredOutput).toBeUndefined();
  });

  it("structured output is NOT a tool grant — toolPolicy is untouched", () => {
    const t = findTemplate(PUBLIC_TEMPLATE)!;
    expect(t.structuredOutput).toBe(true);
    expect(t.toolPolicy).toEqual({
      shell: false,
      filesystem: false,
      web: false,
      mcp: false,
      customTools: false,
    });
  });
});

describe("the body the caller receives", () => {
  it("an ordinary reply: action=reply and the envelope never reaches the customer", async () => {
    const s = await server(
      StubModelClient.returningAction("reply", "We're open until six."),
    );
    const res = await invoke(s.url, { bearer: PUBLIC_SECRET, body: publicBody() });

    expect(res.status).toBe(200);
    expect(res.json["completionState"]).toBe("completed");
    expect(res.json["action"]).toBe("reply");
    expect(res.json["actionReason"]).toBeNull();
    // THE REPLY, not the json the model emitted.
    expect(res.json["answerText"]).toBe("We're open until six.");
    expect(String(res.json["answerText"])).not.toContain("request_human");
    expect(String(res.json["answerText"])).not.toContain('"action"');
    expect(res.json["contractVersion"]).toBe(RESPONSE_CONTRACT_VERSION);
  });

  it("an escalation: action=request_human with the agent's bounded reason", async () => {
    const s = await server(
      StubModelClient.returningAction(
        "request_human",
        "I'm bringing in a colleague who can help with that.",
        "complaint_sensitive",
      ),
    );
    const res = await invoke(s.url, { bearer: PUBLIC_SECRET, body: publicBody() });

    expect(res.status).toBe(200);
    expect(res.json["action"]).toBe("request_human");
    expect(res.json["actionReason"]).toBe("complaint_sensitive");
    expect(res.json["answerText"]).toBe(
      "I'm bringing in a colleague who can help with that.",
    );
  });

  it("an escalation with no reason gets the ratified default", async () => {
    const s = await server(
      StubModelClient.returningAction("request_human", "One moment please."),
    );
    const res = await invoke(s.url, { bearer: PUBLIC_SECRET, body: publicBody() });
    expect(res.json["action"]).toBe("request_human");
    expect(res.json["actionReason"]).toBe("explicit_human_request");
  });

  it("THE DEFECT, end to end: two wordings, one outcome", async () => {
    // "a colleague will…" escalated under the phrase list.
    // "I'll bring in a colleague" did not. Both must now escalate, because
    // both set the same field.
    const wordings = [
      "A colleague will call you back shortly.",
      "I'll bring in a colleague who can help with that.",
    ];
    const actions: unknown[] = [];
    for (const reply of wordings) {
      const s = await server(StubModelClient.returningAction("request_human", reply));
      const res = await invoke(s.url, {
        bearer: PUBLIC_SECRET,
        body: publicBody({ runId: `3333${wordings.indexOf(reply)}333-3333-4333-8333-333333333333` }),
      });
      actions.push(res.json["action"]);
    }
    expect(actions).toEqual(["request_human", "request_human"]);
  });

  it("CONTROL — an ordinary reply mentioning a colleague does NOT escalate", async () => {
    const s = await server(
      StubModelClient.returningAction(
        "reply",
        "A colleague handles installations on Tuesdays.",
      ),
    );
    const res = await invoke(s.url, { bearer: PUBLIC_SECRET, body: publicBody() });
    expect(res.json["action"]).toBe("reply");
  });
});

describe("a malformed structured turn fails closed", () => {
  it("unparseable json: no answer, invalid_output, and it is visible", async () => {
    const s = await server(StubModelClient.returningRaw("I'll bring in a colleague."));
    const res = await invoke(s.url, { bearer: PUBLIC_SECRET, body: publicBody() });

    expect(res.status).toBe(502);
    expect(res.json["completionState"]).toBe("invalid_output");
    // NEVER a reply. The gateway will post nothing and escalate.
    expect(res.json["answerText"]).toBeNull();
    expect(res.json["action"]).toBeNull();
    expect(String(res.json["failureCategory"])).toContain("structured_output_invalid");
  });

  it("an unknown action is refused rather than coerced to reply", async () => {
    const s = await server(
      StubModelClient.returningAction("transfer_to_billing", "One moment."),
    );
    const res = await invoke(s.url, { bearer: PUBLIC_SECRET, body: publicBody() });

    expect(res.status).toBe(502);
    expect(res.json["completionState"]).toBe("invalid_output");
    expect(res.json["answerText"]).toBeNull();
  });

  it("a failure body can NEVER carry an action", async () => {
    // Structural, not conventional: `inlineFailureBody` hardcodes both fields.
    const s = await server(StubModelClient.returningRaw("not json"));
    const res = await invoke(s.url, { bearer: PUBLIC_SECRET, body: publicBody() });
    expect(res.json["ok"]).toBe(false);
    expect(res.json["action"]).toBeNull();
    expect(res.json["actionReason"]).toBeNull();
  });

  it("CONTROL — the same server returns 200 for a well-formed turn", async () => {
    const s = await server(StubModelClient.returningAction("reply", "Hello."));
    const res = await invoke(s.url, { bearer: PUBLIC_SECRET, body: publicBody() });
    expect(res.status).toBe(200);
  });
});

describe("a replay reproduces the original decision", () => {
  it("a duplicate run id returns the SAME action without calling the model again", async () => {
    const model = StubModelClient.returningAction(
      "request_human",
      "Bringing in a colleague.",
      "approval_required",
    );
    const s = await server(model);
    const body = publicBody({ runId: "44444444-4444-4444-8444-444444444444" });

    const first = await invoke(s.url, { bearer: PUBLIC_SECRET, body });
    expect(first.status).toBe(200);
    expect(first.json["action"]).toBe("request_human");
    expect(first.json["actionReason"]).toBe("approval_required");

    const replay = await invoke(s.url, { bearer: PUBLIC_SECRET, body });
    expect(replay.json["replay"]).toBe(true);
    // THE POINT: a redelivery that lost the action would silently downgrade the
    // first delivery's escalation to an ordinary reply.
    expect(replay.json["action"]).toBe("request_human");
    expect(replay.json["actionReason"]).toBe("approval_required");
    expect(replay.json["answerText"]).toBe(first.json["answerText"]);
    // The provider was called exactly once across both.
    expect(model.calls).toHaveLength(1);
  });
});

describe("no customer text leaks through the action fields", () => {
  it("the reply text never appears in the action or reason", async () => {
    const s = await server(
      StubModelClient.returningAction(
        "request_human",
        "My card is 4111 1111 1111 1111 and I want a refund.",
        "complaint_sensitive",
      ),
    );
    const res = await invoke(s.url, { bearer: PUBLIC_SECRET, body: publicBody() });
    expect(String(res.json["action"])).not.toContain("4111");
    expect(String(res.json["actionReason"])).not.toContain("4111");
    expect(res.json["action"]).toBe("request_human");
  });
});
