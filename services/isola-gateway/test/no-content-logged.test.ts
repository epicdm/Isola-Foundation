/**
 * Two things must never reach a log line: a secret, and customer message
 * content. This drives a full successful delivery and a full failed one, then
 * scans every emitted line.
 */
import { describe, expect, it } from "vitest";

import { redact } from "../src/log.js";
import {
  ADMIN_TOKEN,
  BOT_ACCESS_TOKEN,
  BOT_SECRET,
  CapturingLogger,
  CUSTOMER_MESSAGE,
  postWebhook,
  RUNTIME_SECRET,
  signRequest,
  startServer,
  StubAgentRuntime,
} from "./harness.js";

const ANSWER = "The DID costs USD 2.50 per month.";

async function drive(runtime: StubAgentRuntime): Promise<CapturingLogger> {
  const capture = new CapturingLogger();
  const server = await startServer({ logger: capture.logger, runtime });
  await postWebhook(server.url, signRequest());
  await server.gateway.drain();
  await server.close();
  return capture;
}

describe("logging discipline", () => {
  it("never logs the customer message or the answer on the happy path", async () => {
    const capture = await drive(StubAgentRuntime.answering(ANSWER));
    const all = capture.raw.join("\n");
    expect(all).not.toContain(CUSTOMER_MESSAGE);
    expect(all).not.toContain(ANSWER);
    // But it does log the identifiers an operator needs.
    const delivered = capture.withOutcome("replied")[0];
    expect(delivered).toBeDefined();
    expect(delivered?.["tenantId"]).toBe("tenant-acme");
    expect(delivered?.["conversationId"]).toBe(42);
    expect(delivered?.["accountId"]).toBe(1);
    expect(delivered?.["inboxId"]).toBe(7);
    expect(delivered?.["deliveryId"]).toBeTruthy();
    expect(delivered?.["correlationId"]).toBeTruthy();
    expect(typeof delivered?.["durationMs"]).toBe("number");
  });

  it("never logs content on the failure path either", async () => {
    const capture = await drive(StubAgentRuntime.failing("provider_error"));
    const all = capture.raw.join("\n");
    expect(all).not.toContain(CUSTOMER_MESSAGE);
    expect(capture.withOutcome("provider_error")).toHaveLength(1);
    expect(capture.withOutcome("escalated")).toHaveLength(1);
  });

  it("never logs a secret", async () => {
    const capture = await drive(StubAgentRuntime.answering(ANSWER));
    const all = capture.raw.join("\n");
    for (const secret of [BOT_SECRET, BOT_ACCESS_TOKEN, RUNTIME_SECRET, ADMIN_TOKEN]) {
      expect(all).not.toContain(secret);
    }
  });
});

describe("redact", () => {
  it("strips credential-shaped keys", () => {
    expect(
      redact({
        agentBotSecret: "x",
        agentBotAccessToken: "y",
        apiKey: "z",
        authorization: "w",
        signature: "s",
        tenantId: "tenant-acme",
      }),
    ).toEqual({
      agentBotSecret: "[redacted]",
      agentBotAccessToken: "[redacted]",
      apiKey: "[redacted]",
      authorization: "[redacted]",
      signature: "[redacted]",
      tenantId: "tenant-acme",
    });
  });

  it("strips bearer-shaped values wherever they appear", () => {
    expect(redact({ detail: "Bearer abc123" })).toEqual({ detail: "[redacted]" });
  });

  it("survives a cycle-free deep object without exploding", () => {
    expect(redact({ a: { b: { c: { d: { e: { f: { g: 1 } } } } } } })).toBeDefined();
  });
});
