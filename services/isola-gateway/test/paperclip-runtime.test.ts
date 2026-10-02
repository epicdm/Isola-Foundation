/**
 * PIVOT PACKET ISOLA-PIVOT-20261002-01, commit B: the PaperclipAgentRuntime seam.
 *
 * Tested ONLY against a local STUB Paperclip (test/paperclip-stub.ts). The stub is
 * NOT evidence of installed behaviour; every endpoint and field it models is
 * labelled SOURCE or UNVERIFIED in that file and in src/paperclip-runtime.ts.
 *
 * Every refusal has its positive twin in the same harness (Laws 11, 19, 23, 28):
 * the healthy stub IS answered, so "failed closed" cannot mean "fails everything".
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  inMemoryIssueStore,
  PAPERCLIP_OUTCOMES,
  PaperclipAgentRuntime,
  paperclipIdempotencyKey,
  type IssueStore,
} from "../src/paperclip-runtime.js";
import type { AgentRuntimeRequest } from "../src/runtime.js";
import { StubPaperclip } from "./paperclip-stub.js";

const KEY = "isolagw:tenant-acme|binding-1|1|7|delivery:abc-123|answer";
const BEARER = ["not", "a", "real", "credential", "paperclip", "0".repeat(16)].join("-");

const CUSTOM_ATTR_MARKER = "CUSTOM-ATTR-MARKER-77";
const HISTORY_MARKER = "HISTORY-MARKER-88";
const LITE_ACCOUNT_MARKER = "LITE-ACCOUNT-MARKER-99";
const MESSAGE_TEXT = "What does the 600 minute plan cost?";

function request(overrides: Partial<AgentRuntimeRequest> = {}): AgentRuntimeRequest {
  return {
    templateId: "tpl@v1",
    exposure: "PUBLIC",
    agentId: "emp-1",
    runId: "delivery-1",
    idempotencyKey: KEY,
    context: {
      source: "chatwoot",
      customerScope: {
        kind: "verified",
        customerId: "cust-a",
        serviceIds: ["svc-1"],
        liteAccountId: LITE_ACCOUNT_MARKER,
      },
      tenantId: "tenant-acme",
      companyId: "company-1",
      chatwoot: {
        accountId: 1,
        inboxId: 7,
        conversationDisplayId: 42,
        conversationStatus: "pending",
        messageId: 9001,
        customAttributes: { note: CUSTOM_ATTR_MARKER },
      },
      history: [{ role: "customer", content: HISTORY_MARKER }],
      message: { role: "customer", content: MESSAGE_TEXT },
    },
    ...overrides,
  };
}

function envelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { isola: 1, disposition: "reply", text: "The 600 minute plan is 600 minutes.", ...overrides };
}

let stub: StubPaperclip;

beforeEach(async () => {
  stub = new StubPaperclip();
  await stub.start();
});
afterEach(async () => {
  await stub.stop();
});

function makeRuntime(
  args: { store?: IssueStore; deadlineMs?: number; intervalMs?: number; requestTimeoutMs?: number } = {},
): { runtime: PaperclipAgentRuntime; store: IssueStore } {
  const store = args.store ?? inMemoryIssueStore();
  const runtime = new PaperclipAgentRuntime({
    baseUrl: stub.url,
    companyId: "company-1",
    auth: { headers: () => ({ authorization: `Bearer ${BEARER}` }) },
    safeFetch: async (input, init) => fetch(input, init),
    issueStore: store,
    pollDeadlineMs: args.deadlineMs ?? 1500,
    pollIntervalMs: args.intervalMs ?? 15,
    requestTimeoutMs: args.requestTimeoutMs ?? 400,
  });
  return { runtime, store };
}

describe("idempotency key (SOURCE: Lane A relay: create accepts idempotencyKey 1-255)", () => {
  const identity = {
    tenantId: "tenant-acme",
    bindingId: "binding-1",
    chatwootAccountId: 1,
    chatwootInboxId: 7,
    eventId: "delivery:abc-123",
  };

  it("is the ledger key (tenant, binding, account, inbox, event id, action), stable across calls", () => {
    expect(paperclipIdempotencyKey(identity, "answer")).toBe(KEY);
    expect(paperclipIdempotencyKey(identity, "answer")).toBe(paperclipIdempotencyKey({ ...identity }, "answer"));
  });

  it("differs when ANY part of the ledger key differs (control that the key is not a constant)", () => {
    const base = paperclipIdempotencyKey(identity, "answer");
    for (const changed of [
      { ...identity, tenantId: "tenant-x" },
      { ...identity, bindingId: "binding-2" },
      { ...identity, chatwootAccountId: 2 },
      { ...identity, chatwootInboxId: 8 },
      { ...identity, eventId: "delivery:other" },
    ]) {
      expect(paperclipIdempotencyKey(changed, "answer")).not.toBe(base);
    }
    expect(paperclipIdempotencyKey(identity, "other_action")).not.toBe(base);
  });

  it("stays within 255 characters, deterministically, for an over-long identity", () => {
    const long = { ...identity, eventId: "delivery:" + "x".repeat(400) };
    const k1 = paperclipIdempotencyKey(long, "answer");
    expect(k1.length).toBeLessThanOrEqual(255);
    expect(k1.length).toBeGreaterThan(0);
    expect(paperclipIdempotencyKey(long, "answer")).toBe(k1);
    expect(paperclipIdempotencyKey({ ...long, eventId: long.eventId + "y" }, "answer")).not.toBe(k1);
  });
});

describe("create: what Paperclip receives", () => {
  it("CONTROL: a healthy employee answers; the result carries the text and a 'reply' action", async () => {
    stub.replyOnCreate(envelope());
    const { runtime } = makeRuntime();
    const r = await runtime.invoke(request());
    expect(r.outcome).toBe("ok");
    expect(r.text).toBe("The 600 minute plan is 600 minutes.");
    expect(r.action).toBe("reply");
    expect(stub.creates).toHaveLength(1);
  });

  it("creates ONE issue with the stable idempotencyKey and assigneeAgentId = the configured employee", async () => {
    stub.replyOnCreate(envelope());
    const { runtime } = makeRuntime();
    await runtime.invoke(request());
    const body = stub.creates[0]!.body!;
    expect(body["idempotencyKey"]).toBe(KEY);
    expect(body["assigneeAgentId"]).toBe("emp-1");
    expect(stub.creates[0]!.url).toBe("/api/companies/company-1/issues");
  });

  it("carries correlation ids, the verified scope ids and the CURRENT message text: and NOTHING else from the context", async () => {
    stub.replyOnCreate(envelope());
    const { runtime } = makeRuntime();
    await runtime.invoke(request());
    const text = `${stub.creates[0]!.body!["title"]}\n${stub.creates[0]!.body!["description"]}`;
    // correlation ids
    for (const part of ["account=1", "inbox=7", "conversation=42", "message=9001", "delivery-1"]) {
      expect(text, part).toContain(part);
    }
    // the verified scope ids the employee's business tools are limited to
    expect(text).toContain("cust-a");
    expect(text).toContain("svc-1");
    // the message the employee must answer: this is the ONE piece of customer content that travels
    expect(text).toContain(MESSAGE_TEXT);
    // everything else in the run context stays out of Paperclip's stored fields
    expect(text).not.toContain(CUSTOM_ATTR_MARKER);
    expect(text).not.toContain(HISTORY_MARKER);
    expect(text).not.toContain(LITE_ACCOUNT_MARKER);
  });

  it("sends the injected auth header, and NEVER an X-Paperclip-Run-Id (Law 10: never drop or invent the header)", async () => {
    stub.replyOnCreate(envelope());
    const { runtime } = makeRuntime();
    await runtime.invoke(request());
    for (const logged of stub.log) {
      expect(logged.headers["authorization"], "auth header missing").toBe(`Bearer ${BEARER}`);
      expect(logged.headers["x-paperclip-run-id"], "a run id header was invented").toBeUndefined();
    }
    expect(stub.log.length).toBeGreaterThanOrEqual(2); // create + at least one poll
  });
});

describe("issue id storage and replay (SOURCE: schema text 'idempotency keys always replay their original issue'; replay UNVERIFIED by behaviour)", () => {
  it("stores the issueId as soon as create returns (even when no answer ever arrives)", async () => {
    const { runtime, store } = makeRuntime({ deadlineMs: 120 });
    const r = await runtime.invoke(request()); // silent employee
    expect(r.outcome).toBe(PAPERCLIP_OUTCOMES.timeout);
    expect(await store.get(KEY)).toBe([...stub.issues.keys()][0]);
  });

  it("a stored issueId is REUSED: the second delivery makes NO create call (works even when the server would not honour replay)", async () => {
    stub.honourReplay = false;
    const { runtime, store } = makeRuntime({ deadlineMs: 120 });
    await runtime.invoke(request()); // creates, times out
    const issueId = [...stub.issues.keys()][0]!;
    stub.postComment(issueId, JSON.stringify(envelope()));
    const r = await runtime.invoke(request());
    expect(stub.creates, "a duplicate issue was created").toHaveLength(1);
    expect(stub.issues.size).toBe(1);
    expect(r.outcome).toBe("ok");
    expect(await store.get(KEY)).toBe(issueId);
  });

  it("REPLAY HONOURED (store lost, e.g. a restart): the SAME create with the SAME key returns the SAME issue", async () => {
    stub.honourReplay = true;
    const first = makeRuntime({ deadlineMs: 100 });
    await first.runtime.invoke(request());
    const second = makeRuntime({ deadlineMs: 100 }); // fresh store
    await second.runtime.invoke(request());
    expect(stub.creates).toHaveLength(2);
    expect(stub.creates[1]!.body!["idempotencyKey"]).toBe(stub.creates[0]!.body!["idempotencyKey"]);
    expect(stub.issues.size, "replay produced a second issue").toBe(1);
  });

  it("REPLAY NOT HONOURED (store lost): a duplicate issue is the visible cost: which is exactly why the stored id is preferred (distinctness control for the test above)", async () => {
    stub.honourReplay = false;
    const first = makeRuntime({ deadlineMs: 100 });
    await first.runtime.invoke(request());
    const second = makeRuntime({ deadlineMs: 100 });
    await second.runtime.invoke(request());
    expect(stub.issues.size).toBe(2);
  });
});

describe("uncertain create: NEVER re-created", () => {
  it("a 5xx on create is an UNCERTAIN create: distinct outcome, nothing stored, no customer text", async () => {
    stub.createMode = "500";
    const { runtime, store } = makeRuntime();
    const r = await runtime.invoke(request());
    expect(r.outcome).toBe(PAPERCLIP_OUTCOMES.createUncertain);
    expect(r.text).toBeNull();
    expect(await store.get(KEY)).toBeNull();
    expect(await store.isUncertain(KEY)).toBe(true);
  });

  it("the connection dropped AFTER the server created the issue: uncertain, and the issue really exists (the case the rule is for)", async () => {
    stub.createMode = "drop_after_create";
    const { runtime } = makeRuntime();
    const r = await runtime.invoke(request());
    expect(r.outcome).toBe(PAPERCLIP_OUTCOMES.createUncertain);
    expect(stub.issues.size).toBe(1);
  });

  it("a create that never answers (timeout) is uncertain too", async () => {
    stub.createMode = "hang";
    const { runtime } = makeRuntime({ requestTimeoutMs: 80 });
    const r = await runtime.invoke(request());
    expect(r.outcome).toBe(PAPERCLIP_OUTCOMES.createUncertain);
  });

  it("with an uncertain create on record and NO stored issueId, the next attempt does NOT create again: it escalates", async () => {
    stub.createMode = "500";
    const { runtime, store } = makeRuntime();
    await runtime.invoke(request());
    stub.createMode = "ok"; // the server is healthy now: still no re-create
    stub.replyOnCreate(envelope());
    const r = await runtime.invoke(request());
    expect(r.outcome).toBe(PAPERCLIP_OUTCOMES.createUncertain);
    expect(stub.creates, "an uncertain create was re-created").toHaveLength(1);
    expect(await store.get(KEY)).toBeNull();
  });

  it("CONTROL: a different delivery (different key) on the same runtime is created normally after an uncertain one", async () => {
    stub.createMode = "500";
    const { runtime } = makeRuntime();
    await runtime.invoke(request());
    stub.createMode = "ok";
    stub.replyOnCreate(envelope());
    const r = await runtime.invoke(request({ idempotencyKey: KEY + "-other", runId: "delivery-2" }));
    expect(r.outcome).toBe("ok");
  });
});

describe("transport errors: 401/403 are a CONFIG DEFECT, never retried, never a customer message (Law 10)", () => {
  it("'Task bridge key cannot use this API action' -> paperclip_config_defect, exactly ONE request, no customer text", async () => {
    stub.createMode = "401_task_bridge";
    const { runtime } = makeRuntime();
    const r = await runtime.invoke(request());
    expect(r.outcome).toBe(PAPERCLIP_OUTCOMES.configDefect);
    expect(r.text).toBeNull();
    expect(stub.log, "the request was retried").toHaveLength(1);
    expect(stub.log[0]!.headers["x-paperclip-run-id"], "a run id was invented to 'recover'").toBeUndefined();
  });

  it("any 403 is also a config defect, one request", async () => {
    stub.createMode = "403";
    const { runtime } = makeRuntime();
    const r = await runtime.invoke(request());
    expect(r.outcome).toBe(PAPERCLIP_OUTCOMES.configDefect);
    expect(stub.log).toHaveLength(1);
  });

  it("a config defect is distinguishable from an uncertain create (different outcome, nothing marked uncertain)", async () => {
    stub.createMode = "403";
    const { runtime, store } = makeRuntime();
    const r = await runtime.invoke(request());
    expect(r.outcome).not.toBe(PAPERCLIP_OUTCOMES.createUncertain);
    expect(await store.isUncertain(KEY)).toBe(false);
  });

  it("a missing idempotency key is refused before any network call", async () => {
    const { runtime } = makeRuntime();
    const { idempotencyKey: _omit, ...rest } = request();
    const r = await runtime.invoke(rest as AgentRuntimeRequest);
    expect(r.outcome).toBe(PAPERCLIP_OUTCOMES.configDefect);
    expect(stub.log).toHaveLength(0);
  });
});

describe("result parsing: the final disposition is a MODEL CONVENTION: anything else FAILS CLOSED", () => {
  async function outcomeFor(posted: string[]): Promise<Awaited<ReturnType<PaperclipAgentRuntime["invoke"]>>> {
    stub.onCreate = (issue) => {
      for (const body of posted) stub.postComment(issue.id, body);
    };
    const { runtime } = makeRuntime({ deadlineMs: 150 });
    return runtime.invoke(request());
  }

  it("CONTROL: a conforming 'reply' envelope after progress chatter is accepted", async () => {
    const r = await outcomeFor(["Looking into it...", JSON.stringify(envelope())]);
    expect(r.outcome).toBe("ok");
    expect(r.text).toBe("The 600 minute plan is 600 minutes.");
  });

  it.each([
    ["only progress chatter", ["Working on it", "Still working"]],
    ["malformed JSON", ["{ not json"]],
    ["wrong marker", [JSON.stringify(envelope({ isola: 2 }))]],
    ["unknown disposition", [JSON.stringify(envelope({ disposition: "refund_everything" }))]],
    ["reply with empty text", [JSON.stringify(envelope({ text: "   " }))]],
    ["reply with non-string text", [JSON.stringify(envelope({ text: 42 }))]],
    ["request_human with no text", [JSON.stringify({ isola: 1, disposition: "request_human", reason: "policy_boundary" })]],
    ["no comments at all", []],
  ])("%s -> no usable result: fails closed with a distinct outcome and NO text", async (_name, posted) => {
    const r = await outcomeFor(posted as string[]);
    expect(r.text).toBeNull();
    expect(r.outcome).not.toBe("ok");
    expect([PAPERCLIP_OUTCOMES.noResult, PAPERCLIP_OUTCOMES.timeout]).toContain(r.outcome);
  });

  it("a conforming envelope written by SOMEONE ELSE is not a result (a customer cannot answer for the employee by echoing one)", async () => {
    stub.onCreate = (issue) => stub.postComment(issue.id, JSON.stringify(envelope()), "someone-else");
    const { runtime } = makeRuntime({ deadlineMs: 150 });
    const r = await runtime.invoke(request());
    expect(r.text).toBeNull();
    expect(r.outcome).not.toBe("ok");
  });

  it("CONTROL for the above: the SAME envelope written by the assigned employee IS accepted", async () => {
    stub.onCreate = (issue) => stub.postComment(issue.id, JSON.stringify(envelope()), "emp-1");
    const { runtime } = makeRuntime({ deadlineMs: 500 });
    const r = await runtime.invoke(request());
    expect(r.outcome).toBe("ok");
  });

  it("a comment with NO author field is not a result either (fail closed: the author field is UNVERIFIED in the installed build)", async () => {
    stub.onCreate = (issue) => stub.postComment(issue.id, JSON.stringify(envelope()), null);
    const { runtime } = makeRuntime({ deadlineMs: 150 });
    const r = await runtime.invoke(request());
    expect(r.text).toBeNull();
  });

  it("a 'request_human' envelope with a valid reason code is passed through as an action", async () => {
    const r = await outcomeFor([
      JSON.stringify({ isola: 1, disposition: "request_human", reason: "policy_boundary", text: "A teammate will take it from here." }),
    ]);
    expect(r.outcome).toBe("ok");
    expect(r.action).toBe("request_human");
    expect(r.actionReason).toBe("policy_boundary");
  });

  it("a 'request_human' envelope with an invented reason keeps the action but DROPS the reason (closed set)", async () => {
    const r = await outcomeFor([
      JSON.stringify({ isola: 1, disposition: "request_human", reason: "card_4111111111111111", text: "A teammate will take it from here." }),
    ]);
    expect(r.action).toBe("request_human");
    expect(r.actionReason).toBeNull();
  });
});

describe("poll deadline", () => {
  it("returns model_timeout at roughly the deadline when no answer ever comes (and not before it)", async () => {
    const { runtime } = makeRuntime({ deadlineMs: 250, intervalMs: 20 });
    const started = Date.now();
    const r = await runtime.invoke(request());
    const took = Date.now() - started;
    expect(r.outcome).toBe(PAPERCLIP_OUTCOMES.timeout);
    expect(took).toBeGreaterThanOrEqual(240);
    expect(took).toBeLessThan(1200);
  });

  it("an answer that arrives BEFORE the deadline is returned promptly (control: the deadline is not a fixed sleep)", async () => {
    stub.onPoll = (issue, n) => {
      if (n === 3) stub.postComment(issue.id, JSON.stringify(envelope()));
    };
    const { runtime } = makeRuntime({ deadlineMs: 5000, intervalMs: 20 });
    const started = Date.now();
    const r = await runtime.invoke(request());
    expect(r.outcome).toBe("ok");
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe("takeover during the poll (SOURCE: POST /heartbeat-runs/:runId/cancel, Lane A relay; reaching Hermes mid-run is UNVERIFIED)", () => {
  it("CONTROL: while the gateway still owns the conversation the poll continues and answers", async () => {
    stub.onPoll = (issue, n) => {
      if (n === 3) stub.postComment(issue.id, JSON.stringify(envelope()));
    };
    const { runtime } = makeRuntime();
    const r = await runtime.invoke(request({ isStillOwned: async () => true }));
    expect(r.outcome).toBe("ok");
    expect(stub.cancelCalls).toHaveLength(0);
  });

  it("ownership lost mid-poll: stops polling, cancels the run (run id known) once, returns ownership_lost: no text", async () => {
    let calls = 0;
    const { runtime } = makeRuntime({ deadlineMs: 5000, intervalMs: 20 });
    const r = await runtime.invoke(request({ isStillOwned: async () => ++calls < 3 }));
    expect(r.outcome).toBe(PAPERCLIP_OUTCOMES.ownershipLost);
    expect(r.text).toBeNull();
    expect(stub.cancelCalls).toEqual(["run-1"]);
    const pollsAtStop = stub.polls.length;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(stub.polls.length, "kept polling after the takeover").toBe(pollsAtStop);
  });

  it("run id NOT discoverable: no cancel is attempted (never a guessed id), the poll still stops", async () => {
    stub.runId = null;
    const { runtime } = makeRuntime({ deadlineMs: 5000, intervalMs: 20 });
    const r = await runtime.invoke(request({ isStillOwned: async () => false }));
    expect(r.outcome).toBe(PAPERCLIP_OUTCOMES.ownershipLost);
    expect(stub.cancelCalls).toHaveLength(0);
  });

  it("a FAILED cancel does not change the outcome and does not throw", async () => {
    stub.cancelStatus = 500;
    const { runtime } = makeRuntime({ deadlineMs: 5000, intervalMs: 20 });
    const r = await runtime.invoke(request({ isStillOwned: async () => false }));
    expect(r.outcome).toBe(PAPERCLIP_OUTCOMES.ownershipLost);
    expect(stub.cancelCalls).toHaveLength(1);
  });

  it("an ownership read that REJECTS fails closed: stop and report ownership_lost, no text", async () => {
    const { runtime } = makeRuntime({ deadlineMs: 5000, intervalMs: 20 });
    const r = await runtime.invoke(
      request({
        isStillOwned: async () => {
          throw new Error("ownership store down");
        },
      }),
    );
    expect(r.outcome).toBe(PAPERCLIP_OUTCOMES.ownershipLost);
    expect(r.text).toBeNull();
  });
});
