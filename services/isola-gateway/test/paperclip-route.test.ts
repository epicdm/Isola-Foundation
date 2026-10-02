/**
 * PIVOT PACKET ISOLA-PIVOT-20261002-01, commit B: the Paperclip path, tested
 * THROUGH THE ROUTE (Law 20): a SIGNED webhook is POSTed over a real socket, the
 * gateway ACKs, the pipeline runs on the accepted delivery and calls the REAL
 * PaperclipAgentRuntime, which talks HTTP to a local STUB Paperclip.
 *
 * The stub is NOT evidence of installed Paperclip behaviour (see paperclip-stub.ts).
 *
 * CONTROLS (Laws 11, 19, 28): the healthy delivery is answered over the same route,
 * so every "nothing was sent" below is a property of the gateway, not of a harness
 * that refuses everything. ONE EXECUTION OWNER: a spy proves the old /v1/invoke
 * runtime is NOT also called for a message the Paperclip path handles.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { bootErrors, loadConfig } from "../src/config.js";
import { bindingIdentity } from "../src/deliveryref.js";
import {
  inMemoryIssueStore,
  PaperclipAgentRuntime,
  paperclipIdempotencyKey,
  RoutingAgentRuntime,
} from "../src/paperclip-runtime.js";
import type { ConversationRef } from "../src/ownership.js";
import {
  ACCOUNT_ID,
  BASE_ENV,
  CapturingLogger,
  CONVERSATION_DISPLAY_ID,
  CUSTOMER_MESSAGE,
  envConfig,
  INBOX_ID,
  InMemoryOwnershipGate,
  makeBinding,
  postWebhook,
  signRequest,
  startServer,
  StubAgentRuntime,
  TENANT_ID,
} from "./harness.js";
import { StubPaperclip } from "./paperclip-stub.js";

const DELIVERY = "11111111-2222-3333-4444-555555555555";
const REF: ConversationRef = {
  tenantId: TENANT_ID,
  chatwootAccountId: ACCOUNT_ID,
  chatwootConversationId: CONVERSATION_DISPLAY_ID,
};
const BEARER = ["not", "a", "real", "credential", "paperclip", "0".repeat(16)].join("-");
const EXPECTED_KEY = paperclipIdempotencyKey(
  {
    tenantId: TENANT_ID,
    bindingId: bindingIdentity(makeBinding()),
    chatwootAccountId: ACCOUNT_ID,
    chatwootInboxId: INBOX_ID,
    eventId: `delivery:${DELIVERY}`,
  },
  "answer",
);

let stub: StubPaperclip;
beforeEach(async () => {
  stub = new StubPaperclip();
  await stub.start();
});
afterEach(async () => {
  await stub.stop();
});

function paperclipRuntime(deadlineMs = 2000): PaperclipAgentRuntime {
  return new PaperclipAgentRuntime({
    baseUrl: stub.url,
    companyId: "company-1",
    auth: { headers: () => ({ authorization: `Bearer ${BEARER}` }) },
    safeFetch: async (input, init) => fetch(input, init),
    issueStore: inMemoryIssueStore(),
    pollDeadlineMs: deadlineMs,
    pollIntervalMs: 15,
    requestTimeoutMs: 400,
  });
}

const OK_ENVELOPE = { isola: 1, disposition: "reply", text: "Here is your answer from Paperclip." };

describe("signed webhook -> pipeline -> PaperclipAgentRuntime -> stub Paperclip -> reply", () => {
  it("CONTROL + ONE EXECUTION OWNER: exactly one reply, one issue with the ledger-key idempotencyKey, and the old runtime is never called", async () => {
    stub.replyOnCreate(OK_ENVELOPE);
    const legacy = StubAgentRuntime.answering("LEGACY RUNTIME ANSWER");
    const server = await startServer({
      runtime: new RoutingAgentRuntime(legacy, paperclipRuntime(), new Set(["agent-1"])),
    });
    try {
      const res = await postWebhook(server.url, signRequest({ deliveryId: DELIVERY }));
      expect(res.status).toBe(200);
      expect(res.json["outcome"]).toBe("accepted");
      await server.gateway.drain();

      expect(server.chatwoot.customerMessages).toHaveLength(1);
      expect(JSON.stringify(server.chatwoot.customerMessages[0])).toContain("Here is your answer from Paperclip.");
      expect(JSON.stringify(server.chatwoot.customerMessages[0])).not.toContain("LEGACY RUNTIME ANSWER");
      expect(legacy.requests, "the old runtime was also called for the same message").toHaveLength(0);
      expect(stub.creates).toHaveLength(1);
      expect(stub.creates[0]!.body!["idempotencyKey"]).toBe(EXPECTED_KEY);
      expect(stub.creates[0]!.body!["assigneeAgentId"]).toBe("agent-1");
      expect(String(stub.creates[0]!.body!["description"])).toContain(CUSTOMER_MESSAGE);
      // The delivery row plus the write rows for the reply / annotations: every one closed, none left for the sweeper.
      const states = [...server.ledger.rows.values()].map((r) => r.state);
      expect(states.length).toBeGreaterThanOrEqual(1);
      expect(states.every((s) => s === "completed")).toBe(true);
    } finally {
      await server.close();
    }
  });

  it("a binding whose employee is NOT enabled for Paperclip keeps the old path and never touches Paperclip (default OFF)", async () => {
    const legacy = StubAgentRuntime.answering("LEGACY RUNTIME ANSWER");
    const server = await startServer({
      runtime: new RoutingAgentRuntime(legacy, paperclipRuntime(), new Set()),
    });
    try {
      await postWebhook(server.url, signRequest({ deliveryId: DELIVERY }));
      await server.gateway.drain();
      expect(legacy.requests).toHaveLength(1);
      expect(stub.log, "Paperclip was contacted although it is not enabled").toHaveLength(0);
      expect(server.chatwoot.customerMessages).toHaveLength(1);
    } finally {
      await server.close();
    }
  });

  it("the runtime request carries the ledger-key idempotencyKey and an ownership probe on EVERY path (the legacy runtime simply ignores them)", async () => {
    const legacy = StubAgentRuntime.answering("ok");
    const server = await startServer({
      runtime: new RoutingAgentRuntime(legacy, paperclipRuntime(), new Set()),
    });
    try {
      await postWebhook(server.url, signRequest({ deliveryId: DELIVERY }));
      await server.gateway.drain();
      const seen = legacy.requests[0]!;
      expect(seen.idempotencyKey).toBe(EXPECTED_KEY);
      expect(typeof seen.isStillOwned).toBe("function");
      expect(await seen.isStillOwned!()).toBe(true);
    } finally {
      await server.close();
    }
  });

  it("a human takes the conversation while the Paperclip employee is 'working': nothing is sent or written, the run is cancelled, the ledger row closes", async () => {
    const ownership = new InMemoryOwnershipGate();
    const capture = new CapturingLogger();
    stub.onPoll = (_issue, n) => {
      if (n === 2) ownership.seed(REF, "HUMAN_OWNED", 1); // the human acts mid-run
    };
    const server = await startServer({
      ownership,
      logger: capture.logger,
      runtime: new RoutingAgentRuntime(StubAgentRuntime.answering("legacy"), paperclipRuntime(5000), new Set(["agent-1"])),
    });
    try {
      const res = await postWebhook(server.url, signRequest({ deliveryId: DELIVERY }));
      expect(res.status).toBe(200);
      await server.gateway.drain();

      expect((await ownership.read(REF)).state).toBe("HUMAN_OWNED");
      expect(server.chatwoot.customerMessages).toHaveLength(0);
      const writes = server.chatwoot.calls.filter((c) =>
        ["message", "toggle_status", "toggle_status_pending", "assignment", "labels_write", "attributes_write"].includes(c.kind),
      );
      expect(writes).toEqual([]);
      expect(capture.withOutcome("suppressed_in_flight")).toHaveLength(1);
      expect(stub.cancelCalls).toEqual(["run-1"]);
      expect([...server.ledger.rows.values()].map((r) => r.state)).toEqual(["completed"]);
    } finally {
      await server.close();
    }
  });

  it("the same takeover when the CANCEL FAILS: still suppressed, still nothing sent (cancel is best effort and never changes suppression)", async () => {
    stub.cancelStatus = 500;
    const ownership = new InMemoryOwnershipGate();
    stub.onPoll = (_issue, n) => {
      if (n === 2) ownership.seed(REF, "HUMAN_OWNED", 1);
    };
    const server = await startServer({
      ownership,
      runtime: new RoutingAgentRuntime(StubAgentRuntime.answering("legacy"), paperclipRuntime(5000), new Set(["agent-1"])),
    });
    try {
      await postWebhook(server.url, signRequest({ deliveryId: DELIVERY }));
      await server.gateway.drain();
      expect(stub.cancelCalls).toHaveLength(1);
      expect(server.chatwoot.customerMessages).toHaveLength(0);
    } finally {
      await server.close();
    }
  });

  it("a late answer after the takeover is still not sent (the Commit-1 recheck gates the reply after the poll)", async () => {
    const ownership = new InMemoryOwnershipGate();
    // The employee answers on the SAME poll the human acts on: the answer arrives, the recheck still gates it.
    stub.onPoll = (issue, n) => {
      if (n === 2) {
        ownership.seed(REF, "HUMAN_OWNED", 1);
        stub.postComment(issue.id, JSON.stringify(OK_ENVELOPE));
      }
    };
    const server = await startServer({
      ownership,
      runtime: new RoutingAgentRuntime(StubAgentRuntime.answering("legacy"), paperclipRuntime(5000), new Set(["agent-1"])),
    });
    try {
      await postWebhook(server.url, signRequest({ deliveryId: DELIVERY }));
      await server.gateway.drain();
      expect(server.chatwoot.customerMessages).toHaveLength(0);
    } finally {
      await server.close();
    }
  });
});

describe("fail closed over the route", () => {
  it("a 401 'Task bridge key cannot use this API action' -> NO customer message, a human is shown the conversation, the outcome names the config defect, ONE request", async () => {
    stub.createMode = "401_task_bridge";
    const capture = new CapturingLogger();
    const server = await startServer({
      logger: capture.logger,
      runtime: new RoutingAgentRuntime(StubAgentRuntime.answering("legacy"), paperclipRuntime(), new Set(["agent-1"])),
    });
    try {
      await postWebhook(server.url, signRequest({ deliveryId: DELIVERY }));
      await server.gateway.drain();
      expect(server.chatwoot.customerMessages).toHaveLength(0);
      expect(server.chatwoot.privateNotes.length).toBeGreaterThanOrEqual(1);
      expect(capture.withOutcome("paperclip_config_defect").length).toBeGreaterThanOrEqual(1);
      expect(stub.log).toHaveLength(1);
    } finally {
      await server.close();
    }
  });

  it("an employee that never produces a conforming result -> NO customer message, escalated (model_timeout at the poll deadline)", async () => {
    stub.onCreate = (issue) => stub.postComment(issue.id, "Looking into it, one moment");
    const capture = new CapturingLogger();
    const server = await startServer({
      logger: capture.logger,
      runtime: new RoutingAgentRuntime(StubAgentRuntime.answering("legacy"), paperclipRuntime(200), new Set(["agent-1"])),
    });
    try {
      await postWebhook(server.url, signRequest({ deliveryId: DELIVERY }));
      await server.gateway.drain();
      expect(server.chatwoot.customerMessages).toHaveLength(0);
      expect(server.chatwoot.privateNotes.length).toBeGreaterThanOrEqual(1);
      expect(capture.withOutcome("model_timeout").length).toBeGreaterThanOrEqual(1);
    } finally {
      await server.close();
    }
  });
});

describe("configuration: default OFF, and a poll deadline that must fit inside the lease and the runtime timeout", () => {
  const enabledEnv = {
    GATEWAY_PAPERCLIP_AGENT_IDS: "agent-1",
    GATEWAY_PAPERCLIP_BASE_URL: "https://paperclip.example.test",
    GATEWAY_PAPERCLIP_COMPANY_ID: "company-1",
    GATEWAY_PAPERCLIP_BEARER: BEARER,
  };
  const cfg = (extra: Record<string, string> = {}) => loadConfig({ ...BASE_ENV, ...enabledEnv, ...extra });

  it("DEFAULT: nothing enabled, no boot error, no Paperclip host in the egress allowlist", () => {
    const config = envConfig();
    expect(config.paperclip.agentIds).toEqual([]);
    expect(bootErrors(config)).toEqual([]);
    expect(config.egressAllowlist).not.toContain("paperclip.example.test");
  });

  it("CONTROL: a valid enabled configuration boots, and only then is the Paperclip host allowed out", () => {
    const config = cfg();
    expect(config.paperclip.agentIds).toEqual(["agent-1"]);
    expect(config.paperclip.pollDeadlineMs).toBeLessThanOrEqual(80_000);
    expect(bootErrors(config)).toEqual([]);
    expect(config.egressAllowlist).toContain("paperclip.example.test");
  });

  it.each([
    ["deadline above the 80 s ceiling", { GATEWAY_PAPERCLIP_POLL_DEADLINE_MS: "85000", GATEWAY_RUNTIME_TIMEOUT_MS: "120000" }, "GATEWAY_PAPERCLIP_POLL_DEADLINE_MS"],
    ["deadline not inside the runtime timeout", { GATEWAY_PAPERCLIP_POLL_DEADLINE_MS: "70000", GATEWAY_RUNTIME_TIMEOUT_MS: "60000" }, "GATEWAY_PAPERCLIP_POLL_DEADLINE_MS"],
    ["deadline not inside the ledger lease", { GATEWAY_PAPERCLIP_POLL_DEADLINE_MS: "75000", GATEWAY_RUNTIME_TIMEOUT_MS: "120000", GATEWAY_LEDGER_LEASE_MS: "70000" }, "GATEWAY_PAPERCLIP_POLL_DEADLINE_MS"],
  ])("%s -> REFUSES to boot", (_name, extra, mentions) => {
    const errors = bootErrors(cfg(extra));
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors.join(" ")).toContain(mentions);
  });

  it.each([
    ["base url", "GATEWAY_PAPERCLIP_BASE_URL"],
    ["company id", "GATEWAY_PAPERCLIP_COMPANY_ID"],
    ["credential", "GATEWAY_PAPERCLIP_BEARER"],
  ])("enabled with no %s -> REFUSES to boot, and the message never contains a credential value", (_name, variable) => {
    const env: Record<string, string> = { ...enabledEnv };
    delete env[variable];
    const errors = bootErrors(loadConfig({ ...BASE_ENV, ...env }));
    expect(errors.join(" ")).toContain(variable);
    expect(errors.join(" ")).not.toContain(BEARER);
  });
});
