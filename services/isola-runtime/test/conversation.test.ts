/**
 * Conversation-scoped persistence.
 *
 * THE DEFECT
 * ----------
 * The PUBLIC employee answered a Chatwoot customer correctly — the model
 * returned in ~3s and tokens were consumed — and then the run failed:
 *
 *   outcome: recorder_failed
 *   detail: "run recorder failed: PAPERCLIP_RECORD_PATH requires issueId but the
 *            run context did not supply it"
 *   outcome: persistence_failed, httpStatus 502, issueId null, recorded false
 *
 * `PAPERCLIP_RECORD_PATH` is `/api/issues/{issueId}/comments`, which is right for
 * INTERNAL issue-driven work and impossible for a customer conversation. So the
 * PUBLIC path could never persist, never reach `completed`, and never return
 * `answerText` — and the gateway correctly escalated to a human rather than
 * replying. Safe, and the customer was never answered.
 *
 * WHAT IS PINNED HERE
 * -------------------
 *   1. a conversation reference with no issue id creates exactly ONE issue and
 *      comments on it; a second message reuses it; concurrent messages still
 *      yield one issue;
 *   2. `completed` is reached on the PUBLIC conversation path, and the answer
 *      returned is byte-for-byte the answer persisted;
 *   3. the invariant is NOT weakened: an issue that cannot be created or found
 *      is `persistence_failed` with `answerText: null`, never a silent success;
 *   4. a conversation issue is never transitioned — it is a record, not a work
 *      item, and transitioning it per message is how the 53-run loop starts;
 *   5. no customer content reaches the issue title or description;
 *   6. `RUNTIME_CONVERSATION_ISSUES=false` restores the old behaviour exactly,
 *      and the INTERNAL issue-driven path is unchanged either way.
 */
import { afterEach, describe, expect, it } from "vitest";

import {
  CONVERSATION_ISSUE_PRIORITY,
  CONVERSATION_ISSUE_STATUS,
  buildConversationIssue,
  conversationIssueDescription,
  conversationIssueTitle,
  conversationKey,
  conversationKeyMarker,
  extractConversationRef,
  extractTenantId,
  titleMatchesKey,
} from "../src/conversation.js";
import { PaperclipApiError, RecorderError } from "../src/errors.js";
import type { ModelResponse } from "../src/model.js";
import { renderOutcomeBody, type RunOutcome, type RunRecorder } from "../src/recorder.js";
import { parseIssueList, parseIssueSummary } from "../src/paperclip.js";
import { InMemoryStateStore, type StateStore } from "../src/state.js";
import {
  CapturingLogger,
  INTERNAL_SECRET,
  INTERNAL_TEMPLATE,
  PUBLIC_SECRET,
  PUBLIC_TEMPLATE,
  StubModelClient,
  StubPaperclipApi,
  envConfig,
  invoke,
  startServer,
  type TestServer,
} from "./harness.js";

const servers: TestServer[] = [];
afterEach(async () => {
  while (servers.length > 0) await servers.pop()?.close();
});

const COMPANY = "company-1";
const AGENT = "agent-7";
const PUBLIC_AGENT_KEY = ["agent", "key", "public"].join("-");
const INTERNAL_AGENT_KEY = ["agent", "key", "internal"].join("-");

const ENV: Record<string, string | undefined> = {
  PAPERCLIP_COMPANY_ID: COMPANY,
  PAPERCLIP_AGENT_KEY_PUBLIC: PUBLIC_AGENT_KEY,
  PAPERCLIP_AGENT_KEY_INTERNAL: INTERNAL_AGENT_KEY,
  PAPERCLIP_REVIEW_ASSIGNEE_USER_ID: "user-review-1",
};

/**
 * Deliberately awkward: markdown, a blank line, a non-ASCII character. Anything
 * that re-renders, normalises or regenerates on the way out fails the
 * byte-equality assertions. No trailing whitespace, so the answer also survives
 * verbatim inside the rendered comment body.
 */
const ANSWER = [
  "Yes — we can port your number.",
  "",
  "1. Send us a recent bill.",
  "2. We confirm the range holder.",
  "",
  "I have contacted no one and changed no record.",
].join("\n");

/** What a customer actually said. Must never appear on the issue itself. */
const CUSTOMER_MESSAGE =
  "Hi, my name is Brent Symes and my account number is ACC-1044, can I port 767-555-0142?";

const CONVERSATION_CONTEXT = {
  chatwootAccountId: 1,
  conversation: { id: 9012 },
  tenantId: "tenant-abc",
  message: { content: CUSTOMER_MESSAGE },
};

const CONV_KEY = "chatwoot:1:9012";

// Contract-aware for the same reason as `StubModelClient.returning`: the
// front-desk template opted into structured output, so "the model answered
// with this text" is the agent-action envelope carrying it, not bare prose.
// The assertions below are unchanged — only what a real provider would have
// put on the wire is.
function modelReturning(content: string): StubModelClient {
  return new StubModelClient(
    async (req): Promise<ModelResponse> => ({
      content:
        req.responseFormat === "json_object"
          ? JSON.stringify({ action: "reply", reply: content })
          : content,
      model: "deepseek-chat",
      finishReason: "stop",
      usage: { promptTokens: 900, completionTokens: 120, cachedPromptTokens: 100 },
    }),
  );
}

/**
 * A recorder that behaves like the real `PaperclipRunRecorder`: it needs an
 * issue id, and it posts the rendered outcome body as a comment on that issue.
 *
 * The missing-issue message is copied verbatim from `renderRecordPath`, so the
 * "feature off" test really does assert the failure the live system produced.
 */
class ApiRecorder implements RunRecorder {
  readonly kind = "paperclip";
  readonly outcomes: RunOutcome[] = [];

  constructor(
    private readonly api: StubPaperclipApi,
    private readonly apiKey: string,
  ) {}

  async record(outcome: RunOutcome): Promise<void> {
    this.outcomes.push(outcome);
    if (outcome.issueId === null || outcome.issueId.length === 0) {
      throw new RecorderError(
        "PAPERCLIP_RECORD_PATH requires issueId but the run context did not supply it",
      );
    }
    await this.api.postComment(outcome.issueId, renderOutcomeBody(outcome), {
      apiKey: this.apiKey,
      runId: outcome.runId,
    });
  }
}

interface Booted {
  server: TestServer;
  logger: CapturingLogger;
  model: StubModelClient;
  recorder: ApiRecorder;
  paperclip: StubPaperclipApi;
  store: StateStore;
}

async function boot(
  opts: {
    model?: StubModelClient;
    paperclip?: StubPaperclipApi;
    store?: StateStore;
    env?: Record<string, string | undefined>;
    agentKey?: string;
  } = {},
): Promise<Booted> {
  const logger = new CapturingLogger();
  const model = opts.model ?? modelReturning(ANSWER);
  const paperclip = opts.paperclip ?? new StubPaperclipApi();
  const store = opts.store ?? new InMemoryStateStore();
  const recorder = new ApiRecorder(paperclip, opts.agentKey ?? PUBLIC_AGENT_KEY);
  const server = await startServer({
    config: envConfig({ ...ENV, ...(opts.env ?? {}) }),
    logger: logger.logger,
    modelClient: model,
    recorder,
    paperclipApi: paperclip,
    stateStore: store,
  });
  servers.push(server);
  return { server, logger, model, recorder, paperclip, store };
}

const publicBody = (
  runId: string,
  context: unknown = CONVERSATION_CONTEXT,
): Record<string, unknown> => ({
  templateId: PUBLIC_TEMPLATE,
  exposure: "PUBLIC",
  agentId: AGENT,
  runId,
  context,
  responseMode: "inline",
});

// ---------------------------------------------------------------------------
// Resolving the reference — pure
// ---------------------------------------------------------------------------

describe("resolving the conversation reference", () => {
  it("accepts every documented shape and builds the same stable key", () => {
    const shapes: unknown[] = [
      { conversationRef: "chatwoot:1:9012" },
      { conversationId: 9012, chatwootAccountId: 1 },
      { chatwootConversationId: "9012", account: { id: "1" } },
      { conversation: { id: 9012 }, chatwootAccountId: 1 },
      { chatwoot: { conversationId: 9012, accountId: 1 } },
    ];
    for (const context of shapes) {
      expect(extractConversationRef(context)?.key).toBe(CONV_KEY);
    }
  });

  it("works without an account id rather than inventing one", () => {
    const ref = extractConversationRef({ conversationId: "9012" });
    expect(ref).toEqual({
      conversationId: "9012",
      accountId: null,
      key: "chatwoot:none:9012",
    });
  });

  it("does not nest a reference that is already in external-key form", () => {
    const ref = extractConversationRef({ conversationRef: "chatwoot:1:9012" });
    expect(ref).toEqual({ conversationId: "9012", accountId: "1", key: CONV_KEY });
  });

  it("returns null for anything that is not an explicit conversation field", () => {
    for (const context of [
      null,
      undefined,
      "chatwoot:1:9012",
      42,
      {},
      { issueId: "ISSUE-1" },
      { conversation: { reference: 9012 } },
      { conversations: [{ id: 9012 }] },
      { chatwootAccountId: 1 },
      { conversationId: "" },
      { conversationId: {} },
    ]) {
      expect(extractConversationRef(context)).toBeNull();
    }
  });

  it("reads the tenant only from explicit fields", () => {
    expect(extractTenantId({ tenantId: "t1" })).toBe("t1");
    expect(extractTenantId({ tenant: { id: "t2" } })).toBe("t2");
    expect(extractTenantId({ tenant_id: "t3" })).toBe("t3");
    expect(extractTenantId({ customer: { tenant: "t4" } })).toBeNull();
    expect(extractTenantId({})).toBeNull();
  });

  it("builds the key the same way whichever route it came in by", () => {
    expect(conversationKey("1", "9012")).toBe(CONV_KEY);
    expect(conversationKey(null, "9012")).toBe("chatwoot:none:9012");
  });
});

// ---------------------------------------------------------------------------
// What the issue looks like — pure
// ---------------------------------------------------------------------------

describe("the conversation issue itself", () => {
  const ref = extractConversationRef(CONVERSATION_CONTEXT)!;

  it("is titled recognisably and carries the key as a matchable marker", () => {
    expect(conversationIssueTitle(ref)).toBe(
      `Chatwoot conversation #9012 (account 1) [isola-conv:${CONV_KEY}]`,
    );
    expect(titleMatchesKey(conversationIssueTitle(ref), CONV_KEY)).toBe(true);
    expect(titleMatchesKey(conversationIssueTitle(ref), "chatwoot:1:9013")).toBe(false);
    expect(conversationKeyMarker(CONV_KEY)).toBe(`[isola-conv:${CONV_KEY}]`);
  });

  it("says account unknown rather than guessing one", () => {
    const anon = extractConversationRef({ conversationId: "9012" })!;
    expect(conversationIssueTitle(anon)).toContain("(account unknown)");
  });

  it("describes the conversation and the tenant and nothing else", () => {
    const description = conversationIssueDescription({ ref, tenantId: "tenant-abc" });
    expect(description).toContain("AI-handled customer conversation");
    expect(description).toContain(`\`${CONV_KEY}\``);
    expect(description).toContain("`tenant-abc`");
  });

  it("omits the tenant line entirely when no tenant was supplied", () => {
    const description = conversationIssueDescription({ ref, tenantId: null });
    expect(description).not.toContain("Tenant:");
  });

  it("is created unassigned in a status the scheduler does not pick up", () => {
    const input = buildConversationIssue({ ref, tenantId: "tenant-abc" });
    // Paperclip schedules `todo`/`in_progress` issues that have an assignee.
    expect(CONVERSATION_ISSUE_STATUS).toBe("backlog");
    expect(input.status).toBe("backlog");
    expect(input.priority).toBe(CONVERSATION_ISSUE_PRIORITY);
    // The create input type has no assignee field at all, by construction.
    expect(Object.keys(input).sort()).toEqual([
      "description",
      "priority",
      "status",
      "title",
    ]);
  });
});

describe("reading an issue back off the wire", () => {
  it("accepts a bare issue, and the common envelopes", () => {
    expect(parseIssueSummary({ id: "i1", title: "t", status: "backlog" })).toEqual({
      id: "i1",
      title: "t",
      status: "backlog",
    });
    expect(parseIssueSummary({ issue: { id: "i2" } })?.id).toBe("i2");
    expect(parseIssueSummary({ data: { id: "i3" } })?.id).toBe("i3");
  });

  it("refuses anything with no readable id rather than guessing one", () => {
    for (const payload of [null, [], "i1", {}, { id: "" }, { id: 7 }]) {
      expect(parseIssueSummary(payload)).toBeNull();
    }
  });

  it("reads a bare array, an envelope, and drops unreadable entries", () => {
    expect(parseIssueList([{ id: "a" }, { nope: 1 }, { id: "b" }]).map((i) => i.id)).toEqual(
      ["a", "b"],
    );
    expect(parseIssueList({ issues: [{ id: "c" }] }).map((i) => i.id)).toEqual(["c"]);
    expect(parseIssueList(null)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The end-to-end behaviour
// ---------------------------------------------------------------------------

describe("a conversation with no issue id", () => {
  it("creates exactly one issue, comments on it, and reaches completed", async () => {
    const { server, paperclip, recorder } = await boot();
    const res = await invoke(server.url, {
      bearer: PUBLIC_SECRET,
      body: publicBody("run-1"),
    });

    expect(res.status).toBe(200);
    expect(res.json["completionState"]).toBe("completed");
    expect(res.json["outcome"]).toBe("ok");
    expect(res.json["recorded"]).toBe(true);

    expect(paperclip.issueCreates).toHaveLength(1);
    const created = paperclip.issueCreates[0]!;
    expect(created.companyId).toBe(COMPANY);
    expect(created.input!.title).toContain(`[isola-conv:${CONV_KEY}]`);
    expect(created.input!.status).toBe("backlog");
    // The employee's own agent key, per exposure — never a shared board key.
    expect(created.apiKey).toBe(PUBLIC_AGENT_KEY);

    // The comment went to the issue that was just created.
    expect(paperclip.comments).toHaveLength(1);
    expect(paperclip.comments[0]!.issueId).toBe("issue-1");
    expect(recorder.outcomes[0]!.issueId).toBe("issue-1");
  });

  it("returns the answer byte-for-byte as it was persisted", async () => {
    const { server, paperclip, recorder } = await boot();
    const res = await invoke(server.url, {
      bearer: PUBLIC_SECRET,
      body: publicBody("run-1"),
    });

    const answerText = res.json["answerText"] as string;
    // The recorder was handed exactly this string...
    expect(answerText).toBe(recorder.outcomes[0]!.content);
    expect(answerText).toBe(ANSWER);
    // ...and exactly that string is inside the comment Paperclip accepted.
    const body = paperclip.comments[0]!.body!;
    expect(body).toBe(renderOutcomeBody(recorder.outcomes[0]!));
    expect(body.endsWith(answerText)).toBe(true);
  });

  it("calls the model exactly once", async () => {
    const { server, model } = await boot();
    await invoke(server.url, { bearer: PUBLIC_SECRET, body: publicBody("run-1") });
    expect(model.calls).toHaveLength(1);
  });

  it("never transitions the conversation's issue", async () => {
    const { server, paperclip, logger } = await boot();
    const res = await invoke(server.url, {
      bearer: PUBLIC_SECRET,
      body: publicBody("run-1"),
    });

    // The whole point: `PAPERCLIP_SUCCESS_STATUS` / `PAPERCLIP_FAILURE_STATUS`
    // close an issue-driven work item. A conversation issue is a record, and
    // moving it per customer message would bury the operator — and an actionable
    // assigned issue is what re-wakes the employee in the first place.
    expect(paperclip.transitions).toHaveLength(0);
    expect(res.json["transitioned"]).toBe(false);
    expect(res.json["issueStatus"]).toBeNull();
    expect(logger.withOutcome("conversation_issue_not_transitioned")).toHaveLength(1);
    expect(logger.withOutcome("issue_transitioned")).toHaveLength(0);
  });

  it("does not transition it on a failed run either", async () => {
    const { ModelProviderError } = await import("../src/errors.js");
    const { server, paperclip } = await boot({
      model: StubModelClient.throwing(new ModelProviderError("upstream 500", 500)),
    });
    const res = await invoke(server.url, {
      bearer: PUBLIC_SECRET,
      body: publicBody("run-1"),
    });
    expect(res.json["completionState"]).toBe("provider_error");
    expect(paperclip.transitions).toHaveLength(0);
  });

  it("puts no customer content in the issue title or description", async () => {
    const { server, paperclip } = await boot();
    await invoke(server.url, { bearer: PUBLIC_SECRET, body: publicBody("run-1") });

    const input = paperclip.createdIssues[0]!;
    const surface = `${input.title}\n${input.description}`;
    for (const fragment of [
      CUSTOMER_MESSAGE,
      "Brent Symes",
      "ACC-1044",
      "767-555-0142",
      // Nor the employee's answer, which belongs in the comment and nowhere else.
      ANSWER,
    ]) {
      expect(surface).not.toContain(fragment);
    }
    // What it MAY carry: the reference, the tenant, and what it is.
    expect(surface).toContain(CONV_KEY);
    expect(surface).toContain("tenant-abc");
  });
});

describe("the second message in the same conversation", () => {
  it("reuses the same issue and creates no second one", async () => {
    const { server, paperclip } = await boot();
    const first = await invoke(server.url, {
      bearer: PUBLIC_SECRET,
      body: publicBody("run-1"),
    });
    const second = await invoke(server.url, {
      bearer: PUBLIC_SECRET,
      body: publicBody("run-2"),
    });

    expect(first.json["completionState"]).toBe("completed");
    expect(second.json["completionState"]).toBe("completed");
    expect(paperclip.issueCreates).toHaveLength(1);
    expect(paperclip.comments.map((c) => c.issueId)).toEqual(["issue-1", "issue-1"]);
    // The cache is the point: the second message did not even look it up.
    expect(paperclip.issueLists).toHaveLength(1);
  });

  it("does not reuse another company's issue for the same key", async () => {
    const { server, paperclip } = await boot();
    await invoke(server.url, { bearer: PUBLIC_SECRET, body: publicBody("run-1") });
    await invoke(server.url, {
      bearer: PUBLIC_SECRET,
      body: publicBody("run-2", { ...CONVERSATION_CONTEXT, companyId: "company-2" }),
    });
    // A different company means a different issue, not a borrowed one.
    expect(paperclip.issueCreates).toHaveLength(2);
    expect(paperclip.issueCreates[1]!.companyId).toBe("company-2");
  });

  it("adopts an issue that already exists in Paperclip instead of creating one", async () => {
    const paperclip = new StubPaperclipApi();
    // A restart lost the cache, but the issue is still there.
    paperclip.issues.push({
      id: "issue-existing",
      title: `Chatwoot conversation #9012 (account 1) [isola-conv:${CONV_KEY}]`,
      status: "backlog",
    });
    const { server } = await boot({ paperclip });

    const res = await invoke(server.url, {
      bearer: PUBLIC_SECRET,
      body: publicBody("run-1"),
    });
    expect(res.json["completionState"]).toBe("completed");
    expect(paperclip.issueCreates).toHaveLength(0);
    expect(paperclip.comments[0]!.issueId).toBe("issue-existing");
  });

  it("ignores an issue whose title matches the search but not the key", async () => {
    const paperclip = new StubPaperclipApi();
    // Paperclip's `q` also matches descriptions and comments, so the client-side
    // check has to be the real gate.
    paperclip.issues.push({
      id: "issue-other",
      title: `Chatwoot conversation #9013 (account 1) [isola-conv:chatwoot:1:9013]`,
      status: "backlog",
    });
    const { server } = await boot({ paperclip });
    await invoke(server.url, { bearer: PUBLIC_SECRET, body: publicBody("run-1") });
    expect(paperclip.issueCreates).toHaveLength(1);
  });

  it("replays the stored answer without touching Paperclip or the model again", async () => {
    const { server, paperclip, model } = await boot();
    const first = await invoke(server.url, {
      bearer: PUBLIC_SECRET,
      body: publicBody("run-1"),
    });
    const replay = await invoke(server.url, {
      bearer: PUBLIC_SECRET,
      body: publicBody("run-1"),
    });

    expect(replay.status).toBe(200);
    expect(replay.json["replay"]).toBe(true);
    expect(replay.json["completionState"]).toBe("completed");
    expect(replay.json["answerText"]).toBe(first.json["answerText"]);
    expect(model.calls).toHaveLength(1);
    expect(paperclip.issueCreates).toHaveLength(1);
    expect(paperclip.comments).toHaveLength(1);
  });
});

describe("two messages arriving at once", () => {
  it("still yields exactly one issue for the conversation", async () => {
    const paperclip = new StubPaperclipApi();
    // Hold the first creation open long enough for the second run to arrive
    // inside the window a naive implementation would double-create in.
    paperclip.beforeCreateIssue = () =>
      new Promise<void>((resolve) => setTimeout(resolve, 60));
    const { server } = await boot({ paperclip });

    const [a, b] = await Promise.all([
      invoke(server.url, { bearer: PUBLIC_SECRET, body: publicBody("run-a") }),
      invoke(server.url, { bearer: PUBLIC_SECRET, body: publicBody("run-b") }),
    ]);

    expect(a.json["completionState"]).toBe("completed");
    expect(b.json["completionState"]).toBe("completed");
    expect(paperclip.issueCreates).toHaveLength(1);
    expect(paperclip.comments.map((c) => c.issueId)).toEqual(["issue-1", "issue-1"]);
  });

  it("does not wedge the conversation when the first creation fails", async () => {
    const paperclip = new StubPaperclipApi();
    paperclip.createIssueFailure = new PaperclipApiError("returned HTTP 500", 500, true);
    const { server } = await boot({ paperclip });

    const first = await invoke(server.url, {
      bearer: PUBLIC_SECRET,
      body: publicBody("run-a"),
    });
    expect(first.json["completionState"]).toBe("persistence_failed");

    // The lock released, so the next message gets a real attempt.
    paperclip.createIssueFailure = null;
    const second = await invoke(server.url, {
      bearer: PUBLIC_SECRET,
      body: publicBody("run-b"),
    });
    expect(second.json["completionState"]).toBe("completed");
  });
});

describe("the invariant is not weakened", () => {
  it("reports persistence_failed with no answer when the issue cannot be created", async () => {
    const paperclip = new StubPaperclipApi();
    paperclip.createIssueFailure = new PaperclipApiError("returned HTTP 422", 422, false);
    const { server, logger } = await boot({ paperclip });

    const res = await invoke(server.url, {
      bearer: PUBLIC_SECRET,
      body: publicBody("run-1"),
    });

    expect(res.status).toBe(502);
    expect(res.json["outcome"]).toBe("persistence_failed");
    expect(res.json["completionState"]).toBe("persistence_failed");
    expect(res.json["answerText"]).toBeNull();
    expect(res.json["recorded"]).toBe(false);
    expect(String(res.json["failureCategory"])).toContain("conversation issue create failed");
    expect(logger.withOutcome("conversation_issue_create_failed")).toHaveLength(1);
    // Nothing was commented anywhere.
    expect(paperclip.comments).toHaveLength(0);
  });

  it("does not create an issue when the lookup itself failed", async () => {
    const paperclip = new StubPaperclipApi();
    paperclip.listIssuesFailure = new PaperclipApiError("returned HTTP 503", 503, true);
    const { server, logger } = await boot({ paperclip });

    const res = await invoke(server.url, {
      bearer: PUBLIC_SECRET,
      body: publicBody("run-1"),
    });

    // Creating on an unproven absence is how one conversation ends up with two
    // issues. Fail closed instead.
    expect(paperclip.issueCreates).toHaveLength(0);
    expect(res.json["completionState"]).toBe("persistence_failed");
    expect(res.json["answerText"]).toBeNull();
    expect(logger.withOutcome("conversation_issue_lookup_failed")).toHaveLength(1);
  });

  it("reports persistence_failed when the comment on the new issue is refused", async () => {
    const paperclip = new StubPaperclipApi();
    paperclip.commentFailure = new PaperclipApiError("returned HTTP 500", 500, true);
    const { server } = await boot({ paperclip });

    const res = await invoke(server.url, {
      bearer: PUBLIC_SECRET,
      body: publicBody("run-1"),
    });
    expect(res.json["completionState"]).toBe("persistence_failed");
    expect(res.json["answerText"]).toBeNull();
  });

  it("changes nothing when the run carries neither an issue nor a conversation", async () => {
    const { server, paperclip, logger } = await boot();
    const res = await invoke(server.url, {
      bearer: PUBLIC_SECRET,
      body: publicBody("run-1", { question: "what are your rates?" }),
    });

    expect(paperclip.issueCreates).toHaveLength(0);
    expect(paperclip.issueLists).toHaveLength(0);
    expect(res.json["completionState"]).toBe("persistence_failed");
    expect(res.json["answerText"]).toBeNull();
    expect(String(res.json["recorderError"])).toContain("requires issueId");
    expect(logger.withOutcome("no_issue_context")).toHaveLength(1);
  });
});

describe("RUNTIME_CONVERSATION_ISSUES=false", () => {
  it("restores the previously observed behaviour exactly", async () => {
    const { server, paperclip, logger } = await boot({
      env: { RUNTIME_CONVERSATION_ISSUES: "false" },
    });

    const res = await invoke(server.url, {
      bearer: PUBLIC_SECRET,
      body: publicBody("run-1"),
    });

    // This is the live failure the feature exists to fix, reproduced on demand.
    expect(res.status).toBe(502);
    expect(res.json["outcome"]).toBe("persistence_failed");
    expect(res.json["completionState"]).toBe("persistence_failed");
    expect(res.json["answerText"]).toBeNull();
    expect(res.json["recorded"]).toBe(false);
    expect(String(res.json["recorderError"])).toContain(
      "PAPERCLIP_RECORD_PATH requires issueId",
    );
    expect(paperclip.issueCreates).toHaveLength(0);
    expect(paperclip.issueLists).toHaveLength(0);
    expect(logger.withOutcome("recorder_failed")).toHaveLength(1);
  });

  it("still answers an issue-driven run normally", async () => {
    const { server, paperclip } = await boot({
      env: { RUNTIME_CONVERSATION_ISSUES: "false" },
      agentKey: INTERNAL_AGENT_KEY,
    });
    const res = await invoke(server.url, {
      bearer: INTERNAL_SECRET,
      body: {
        templateId: INTERNAL_TEMPLATE,
        exposure: "INTERNAL",
        agentId: AGENT,
        runId: "run-1",
        context: { issueId: "ISSUE-4821" },
        responseMode: "inline",
      },
    });
    expect(res.json["completionState"]).toBe("completed");
    expect(paperclip.comments[0]!.issueId).toBe("ISSUE-4821");
    expect(paperclip.issueCreates).toHaveLength(0);
  });
});

describe("the INTERNAL issue-driven path is untouched", () => {
  async function runInternal(context: unknown) {
    const booted = await boot({ agentKey: INTERNAL_AGENT_KEY });
    const res = await invoke(booted.server.url, {
      bearer: INTERNAL_SECRET,
      body: {
        templateId: INTERNAL_TEMPLATE,
        exposure: "INTERNAL",
        agentId: AGENT,
        runId: "run-1",
        context,
        responseMode: "inline",
      },
    });
    return { ...booted, res };
  }

  it("comments on the supplied issue and transitions it, creating nothing", async () => {
    const { res, paperclip } = await runInternal({ issueId: "ISSUE-4821" });

    expect(res.json["completionState"]).toBe("completed");
    expect(paperclip.issueCreates).toHaveLength(0);
    expect(paperclip.issueLists).toHaveLength(0);
    expect(paperclip.comments[0]!.issueId).toBe("ISSUE-4821");
    expect(paperclip.transitions).toHaveLength(1);
    expect(paperclip.transitions[0]!.status).toBe("in_review");
    expect(paperclip.transitions[0]!.extra).toEqual({ assigneeUserId: "user-review-1" });
    expect(res.json["transitioned"]).toBe(true);
  });

  it("prefers the issue id even when a conversation reference is also present", async () => {
    // An issue-driven run is an issue-driven run. The conversation reference
    // must not divert its output into a second, parallel record.
    const { res, paperclip } = await runInternal({
      issueId: "ISSUE-4821",
      conversationId: 9012,
      chatwootAccountId: 1,
    });

    expect(res.json["completionState"]).toBe("completed");
    expect(paperclip.issueCreates).toHaveLength(0);
    expect(paperclip.comments[0]!.issueId).toBe("ISSUE-4821");
    expect(paperclip.transitions).toHaveLength(1);
  });
});

/**
 * Cross-service contract regression.
 *
 * isola-gateway builds its run context as
 *   { source, tenantId, companyId, chatwoot: { accountId, inboxId,
 *     conversationDisplayId, conversationStatus, messageId, customAttributes }, message: {...} }
 *
 * The runtime originally accepted `chatwoot.conversationId`. Live, nothing
 * resolved, so every PUBLIC run died as persistence_failed and the gateway
 * escalated instead of replying. This pins the shape the gateway actually sends.
 */
describe("gateway context shape (cross-service contract)", () => {
  const gatewayContext = (over: Record<string, unknown> = {}) => ({
    source: "chatwoot",
    tenantId: "isola-uat-a",
    companyId: "3ed3869b-463c-4876-8e16-ddc058f06cd9",
    chatwoot: {
      accountId: 3,
      inboxId: 4,
      conversationDisplayId: 7,
      conversationStatus: "pending",
      messageId: 42,
      customAttributes: {},
      ...over,
    },
    message: { role: "customer", content: "hello" },
  });

  it("resolves a reference from the exact context isola-gateway sends", () => {
    const ref = extractConversationRef(gatewayContext());
    expect(ref).not.toBeNull();
    expect(ref?.key).toBe("chatwoot:3:7");
  });

  it("prefers conversationDisplayId over conversationId when both are present", () => {
    // display_id is what Chatwoot's conversation API is addressed by; the row
    // primary key would build a key that points at the wrong conversation.
    const ref = extractConversationRef(gatewayContext({ conversationId: 999 }));
    expect(ref?.key).toBe("chatwoot:3:7");
  });

  it("still resolves the older accepted names", () => {
    expect(extractConversationRef({ chatwoot: { accountId: 3, conversationId: 7 } })?.key)
      .toBe("chatwoot:3:7");
    expect(extractConversationRef({ conversationRef: "chatwoot:3:7" })?.key).toBe("chatwoot:3:7");
  });
});
