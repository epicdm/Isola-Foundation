/**
 * CODEX FIX ROUND 1 (review of 92ddc6c): D4 + D7.
 *
 *   D4 (P2)  the comment poll retried 4xx responses (400/404/422/429) until the
 *            deadline and ended as `model_timeout`. Every 4xx is a CONFIG DEFECT:
 *            one request, no retry, no customer message. Transport errors and 5xx
 *            keep their transient handling.
 *   D7 (P2)  an `X-Paperclip-Run-Id` injected through `PaperclipAuth.headers()` was
 *            forwarded. The seam's invariant (Law 10) is that this client NEVER
 *            sends, drops or invents a run id: a credential that supplies one is a
 *            config defect and NOTHING is sent.
 *
 * Tested ONLY against the local STUB Paperclip; it proves nothing about the
 * installed Paperclip. Every refusal has its positive twin in the same harness.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { inMemoryIssueStore, PAPERCLIP_OUTCOMES, PaperclipAgentRuntime } from "../src/paperclip-runtime.js";
import type { AgentRuntimeRequest } from "../src/runtime.js";
import { StubPaperclip } from "./paperclip-stub.js";

const KEY = "isolagw:tenant-acme|binding-1|1|7|delivery:abc-123|answer";
const BEARER = ["not", "a", "real", "credential", "paperclip", "0".repeat(16)].join("-");
const ANSWER = { isola: 1, disposition: "reply", text: "The 600 minute plan is 600 minutes." };

function request(): AgentRuntimeRequest {
  return {
    templateId: "tpl@v1",
    exposure: "PUBLIC",
    agentId: "emp-1",
    runId: "delivery-1",
    idempotencyKey: KEY,
    context: {
      source: "chatwoot",
      customerScope: { kind: "verified", customerId: "cust-a", serviceIds: ["svc-1"] },
      chatwoot: { accountId: 1, inboxId: 7, conversationDisplayId: 42, messageId: 9001 },
      message: { role: "customer", content: "What does the 600 minute plan cost?" },
    },
  };
}

let stub: StubPaperclip;
beforeEach(async () => {
  stub = new StubPaperclip();
  await stub.start();
});
afterEach(async () => {
  await stub.stop();
});

function makeRuntime(headers: () => Record<string, string>, deadlineMs = 400) {
  return new PaperclipAgentRuntime({
    baseUrl: stub.url,
    companyId: "company-1",
    auth: { headers },
    safeFetch: async (input, init) => fetch(input, init),
    issueStore: inMemoryIssueStore(),
    pollDeadlineMs: deadlineMs,
    pollIntervalMs: 15,
    requestTimeoutMs: 200,
  });
}
const bearer = (): Record<string, string> => ({ authorization: `Bearer ${BEARER}` });

describe("D4: a 4xx on the comment poll is a CONFIG DEFECT — one request, no retry", () => {
  it.each([400, 404, 422, 429])("status %i -> exactly ONE poll and paperclip_config_defect (not model_timeout)", async (status) => {
    stub.replyOnCreate(ANSWER);
    stub.commentsStatus = status;
    const result = await makeRuntime(bearer).invoke(request());
    expect(result.outcome).toBe(PAPERCLIP_OUTCOMES.configDefect);
    expect(result.text).toBeNull();
    expect(stub.polls).toHaveLength(1);
  });

  it("CONTROL: a transient 500 is still retried until the deadline (transient handling is intact)", async () => {
    stub.replyOnCreate(ANSWER);
    stub.commentsStatus = 500;
    const result = await makeRuntime(bearer, 250).invoke(request());
    expect(result.outcome).toBe(PAPERCLIP_OUTCOMES.timeout);
    expect(stub.polls.length).toBeGreaterThanOrEqual(2);
  });

  it("CONTROL: a healthy poll is answered over the same harness", async () => {
    stub.replyOnCreate(ANSWER);
    const result = await makeRuntime(bearer).invoke(request());
    expect(result.outcome).toBe("ok");
    expect(result.text).toBe(ANSWER.text);
  });
});

describe("D7: an injected X-Paperclip-Run-Id is REFUSED at the transport — nothing is sent (Law 10)", () => {
  it.each([
    ["X-Paperclip-Run-Id", "X-Paperclip-Run-Id"],
    ["lower case", "x-paperclip-run-id"],
    ["upper case", "X-PAPERCLIP-RUN-ID"],
  ])("on CREATE (%s) -> config defect and ZERO requests reach Paperclip", async (_name, header) => {
    stub.replyOnCreate(ANSWER);
    const result = await makeRuntime(() => ({ ...bearer(), [header]: "invented-run-id" })).invoke(request());
    expect(result.outcome).toBe(PAPERCLIP_OUTCOMES.configDefect);
    expect(result.text).toBeNull();
    expect(stub.log).toHaveLength(0);
  });

  it("on POLL: a credential that starts supplying a run id after the create -> config defect, and NO poll is sent", async () => {
    stub.replyOnCreate(ANSWER);
    let calls = 0;
    const result = await makeRuntime(() => {
      calls += 1;
      return calls === 1 ? bearer() : { ...bearer(), "X-Paperclip-Run-Id": "invented-run-id" };
    }).invoke(request());
    expect(result.outcome).toBe(PAPERCLIP_OUTCOMES.configDefect);
    expect(stub.creates).toHaveLength(1);
    expect(stub.polls).toHaveLength(0);
    for (const logged of stub.log) expect(JSON.stringify(logged.headers).toLowerCase()).not.toContain("invented-run-id");
  });

  it("CONTROL: an ordinary extra header is forwarded and the turn is answered (the guard is not a blanket refusal)", async () => {
    stub.replyOnCreate(ANSWER);
    const result = await makeRuntime(() => ({ ...bearer(), "x-isola-trace": "trace-1" })).invoke(request());
    expect(result.outcome).toBe("ok");
    expect(stub.creates[0]?.headers["x-isola-trace"]).toBe("trace-1");
    expect(stub.creates[0]?.headers["authorization"]).toBe(`Bearer ${BEARER}`);
    expect(stub.creates[0]?.headers["x-paperclip-run-id"]).toBeUndefined();
  });
});
