/**
 * The asynchronous half: reply, escalation, and the read-modify-write
 * annotations.
 *
 * The rule these tests exist to protect: a customer-facing message is sent ONLY
 * when the runtime returned real answer text. Everything else is a private note
 * plus an escalation.
 */
import { describe, expect, it } from "vitest";

import { ChatwootApiError } from "../src/errors.js";
import {
  buildRuntimeContext,
  explainFailure,
  renderFailureNote,
} from "../src/pipeline.js";
import {
  bindingsJson,
  CapturingLogger,
  CUSTOMER_MESSAGE,
  envConfig,
  makeBinding,
  postWebhook,
  signRequest,
  startServer,
  StubAgentRuntime,
  StubChatwootApi,
  TEMPLATE_ID,
  TENANT_ID,
} from "./harness.js";

const ANSWER = "A DID costs USD 2.50 per month.";

async function run(args: {
  runtime?: StubAgentRuntime;
  chatwoot?: StubChatwootApi;
  config?: ReturnType<typeof envConfig>;
  logger?: CapturingLogger;
}) {
  const logger = args.logger ?? new CapturingLogger();
  const server = await startServer({
    ...(args.runtime === undefined ? {} : { runtime: args.runtime }),
    ...(args.chatwoot === undefined ? {} : { chatwoot: args.chatwoot }),
    ...(args.config === undefined ? {} : { config: args.config }),
    logger: logger.logger,
  });
  const res = await postWebhook(server.url, signRequest());
  await server.gateway.drain();
  const chatwoot = server.chatwoot;
  await server.close();
  return { res, chatwoot, logger };
}

describe("the happy path", () => {
  it("posts the answer as a public outgoing message and nothing else customer-facing", async () => {
    const { chatwoot } = await run({ runtime: StubAgentRuntime.answering(ANSWER) });
    expect(chatwoot.customerMessages).toHaveLength(1);
    expect(chatwoot.customerMessages[0]?.content).toBe(ANSWER);
    expect(chatwoot.privateNotes).toHaveLength(0);
    expect(chatwoot.statusToggles).toHaveLength(0);
  });

  it("hands the runtime the template, the PUBLIC exposure and the tenant's agent", async () => {
    const runtime = StubAgentRuntime.answering(ANSWER);
    await run({ runtime });
    const request = runtime.requests[0];
    expect(request?.templateId).toBe(TEMPLATE_ID);
    expect(request?.exposure).toBe("PUBLIC");
    expect(request?.agentId).toBe("agent-1");
    expect(request?.runId).toBeTruthy();
  });

  it("labels and attributes the conversation as answered", async () => {
    const { chatwoot } = await run({ runtime: StubAgentRuntime.answering(ANSWER) });
    expect(chatwoot.labelWrites[0]?.labels).toContain("isola-ai-answered");
    const attributes = chatwoot.attributeWrites[0]?.attributes ?? {};
    expect(attributes["isola_last_outcome"]).toBe("replied");
    expect(attributes["isola_tenant_id"]).toBe(TENANT_ID);
  });
});

describe("runtime_no_text — the contract violation", () => {
  it("sends NO customer message, posts a private note and escalates", async () => {
    const { chatwoot, logger } = await run({ runtime: StubAgentRuntime.withoutText() });

    expect(chatwoot.customerMessages).toHaveLength(0);
    expect(chatwoot.privateNotes).toHaveLength(1);
    expect(chatwoot.privateNotes[0]?.content).toContain("runtime_no_text");
    expect(chatwoot.statusToggles).toHaveLength(1);

    const line = logger.withOutcome("runtime_no_text")[0];
    expect(line).toBeDefined();
    expect(line?.["customerMessageSent"]).toBe(false);
  });

  it("treats whitespace-only text as no text at all", async () => {
    const runtime = new StubAgentRuntime(async () => ({
      text: "   \n ",
      outcome: "ok",
      correlationId: "c",
      completionState: "completed",
      contractVersion: 1,
    }));
    const { chatwoot } = await run({ runtime });
    expect(chatwoot.customerMessages).toHaveLength(0);
    expect(chatwoot.privateNotes).toHaveLength(1);
  });
});

describe("runtime failures", () => {
  for (const outcome of [
    "budget_exhausted",
    "provider_error",
    "model_timeout",
    "exposure_mismatch",
    "runtime_unreachable",
  ]) {
    it(`${outcome}: private note + escalation, and no customer message`, async () => {
      const { chatwoot } = await run({ runtime: StubAgentRuntime.failing(outcome) });
      expect(chatwoot.customerMessages).toHaveLength(0);
      expect(chatwoot.privateNotes).toHaveLength(1);
      expect(chatwoot.privateNotes[0]?.content).toContain(outcome);
      expect(chatwoot.privateNotes[0]?.content).toContain(explainFailure(outcome));
      expect(chatwoot.statusToggles).toHaveLength(1);
      expect(chatwoot.labelWrites[0]?.labels).toContain("isola-ai-escalated");
    });
  }

  it("assigns the configured escalation team", async () => {
    const config = envConfig({
      GATEWAY_BINDINGS_JSON: bindingsJson([makeBinding({ escalationTeamId: 5 })]),
    });
    const { chatwoot } = await run({
      config,
      runtime: StubAgentRuntime.failing("provider_error"),
    });
    expect(chatwoot.assignments).toHaveLength(1);
    expect(chatwoot.assignments[0]?.teamId).toBe(5);
  });

  it("does not assign when no escalation team is configured", async () => {
    const { chatwoot } = await run({ runtime: StubAgentRuntime.failing("provider_error") });
    expect(chatwoot.assignments).toHaveLength(0);
  });

  it("escalates when the customer reply itself fails, and never re-sends it", async () => {
    const chatwoot = new StubChatwootApi();
    chatwoot.postMessageFailure = new ChatwootApiError("returned HTTP 502", 502);
    const result = await run({ runtime: StubAgentRuntime.answering(ANSWER), chatwoot });
    // One attempt, which threw. No retry.
    expect(result.chatwoot.customerMessages).toHaveLength(1);
    expect(result.chatwoot.privateNotes).toHaveLength(1);
    expect(result.chatwoot.privateNotes[0]?.content).toContain("reply_failed");
    expect(result.chatwoot.statusToggles).toHaveLength(1);
  });
});

describe("labels and custom attributes are read-modify-write", () => {
  it("preserves labels a human already applied", async () => {
    const chatwoot = new StubChatwootApi();
    chatwoot.labels = ["vip", "billing"];
    const { chatwoot: after } = await run({
      chatwoot,
      runtime: StubAgentRuntime.answering(ANSWER),
    });
    const written = after.labelWrites[0]?.labels ?? [];
    expect(written).toEqual(["vip", "billing", "isola-ai-answered"]);
  });

  it("preserves custom attributes the tenant already set", async () => {
    const chatwoot = new StubChatwootApi();
    chatwoot.customAttributes = { crm_id: "ACC-1001", plan: "gold" };
    const { chatwoot: after } = await run({
      chatwoot,
      runtime: StubAgentRuntime.answering(ANSWER),
    });
    const written = after.attributeWrites[0]?.attributes ?? {};
    expect(written["crm_id"]).toBe("ACC-1001");
    expect(written["plan"]).toBe("gold");
    expect(written["isola_last_outcome"]).toBe("replied");
  });

  it("does not write at all when the read fails, rather than clobbering", async () => {
    const chatwoot = new StubChatwootApi();
    chatwoot.labels = ["vip"];
    chatwoot.labelReadFailure = new ChatwootApiError("returned HTTP 500", 500);
    chatwoot.attributeReadFailure = new ChatwootApiError("returned HTTP 500", 500);
    const { chatwoot: after } = await run({
      chatwoot,
      runtime: StubAgentRuntime.answering(ANSWER),
    });
    expect(after.labelWrites).toHaveLength(0);
    expect(after.attributeWrites).toHaveLength(0);
    // The pre-existing labels are untouched.
    expect(after.labels).toEqual(["vip"]);
  });

  it("does not write a label that is already present", async () => {
    const chatwoot = new StubChatwootApi();
    chatwoot.labels = ["isola-ai-answered"];
    const { chatwoot: after } = await run({
      chatwoot,
      runtime: StubAgentRuntime.answering(ANSWER),
    });
    expect(after.labelWrites).toHaveLength(0);
  });

  it("can be switched off entirely", async () => {
    const config = envConfig({
      GATEWAY_APPLY_LABELS: "false",
      GATEWAY_APPLY_CUSTOM_ATTRIBUTES: "false",
    });
    const { chatwoot } = await run({
      config,
      runtime: StubAgentRuntime.answering(ANSWER),
    });
    expect(chatwoot.labelWrites).toHaveLength(0);
    expect(chatwoot.attributeWrites).toHaveLength(0);
    expect(chatwoot.customerMessages).toHaveLength(1);
  });
});

describe("pure helpers", () => {
  it("the failure note names the failure and says no message was sent", () => {
    const note = renderFailureNote({
      outcome: "budget_exhausted",
      correlationId: "corr-1",
      tenantId: TENANT_ID,
    });
    expect(note).toContain("budget_exhausted");
    expect(note).toContain("No message was sent to the customer");
    expect(note).toContain("corr-1");
  });

  it("has an explanation for every failure it can produce", () => {
    for (const outcome of [
      "runtime_no_text",
      "budget_exhausted",
      "provider_error",
      "model_timeout",
      "exposure_mismatch",
      "unauthorized",
      "runtime_unreachable",
      "runtime_error",
      "reply_failed",
    ]) {
      expect(explainFailure(outcome).length).toBeGreaterThan(10);
    }
    expect(explainFailure("something_new")).toContain("did not produce a usable answer");
  });

  it("the runtime context carries the tenant, the company and the message", () => {
    const binding = makeBinding();
    const context = buildRuntimeContext(binding, {
      event: "message_created",
      messageId: 1,
      content: CUSTOMER_MESSAGE,
      messageType: "incoming",
      private: false,
      senderPhone: null,
    senderType: "contact",
      accountId: 1,
      inboxId: 7,
      conversationDisplayId: 42,
      conversationStatus: "pending",
      assignee: null,
      customAttributes: {},
      attachmentTypes: [],
      contentType: "text",
    });
    expect(context["tenantId"]).toBe(TENANT_ID);
    expect(context["companyId"]).toBe("company-1");
    expect((context["message"] as Record<string, unknown>)["content"]).toBe(CUSTOMER_MESSAGE);
  });
});
