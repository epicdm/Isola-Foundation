/**
 * STEP A (direct Hermes path), commit 4b: THE ROUTE (Law 20). A SIGNED webhook goes through the
 * gateway's real handler -> binding -> ledger -> transcript -> pipeline -> HermesDirectRuntime ->
 * a FAKE Hermes service -> the reply, with NO socket anywhere: the handler is driven in-process
 * (test/hermes-inproc.ts) and Hermes is an injected SafeFetch behind the REAL egress guard.
 *
 * The fake follows lane 59's contract as VERIFIED by Step B; it is NOT evidence of installed
 * behaviour (Law 5). Every refusal has its positive twin in the same harness: the healthy turn is
 * answered over the same route, so every "nothing was sent" below is a property of the gateway and
 * not of a harness that refuses everything (Laws 11, 19, 23, 28).
 */
import { describe, expect, it } from "vitest";

import { createGateway, type Gateway } from "../src/app.js";
import { bootErrors } from "../src/config.js";
import { bindingIdentity } from "../src/deliveryref.js";
import { DISARMED } from "../src/failpoint.js";
import { createSafeFetch } from "../src/egress.js";
import { HermesDirectRuntime } from "../src/hermes-runtime.js";
import type { ConversationRef } from "../src/ownership.js";
import { createSweeper } from "../src/recovery.js";
import { processDelivery, type DeliveryJob, type PipelineDeps } from "../src/pipeline.js";
import { parseWebhookPayload } from "../src/webhook.js";
import {
  ACCOUNT_ID,
  BASE_ENV,
  CapturingLogger,
  CONVERSATION_DISPLAY_ID,
  CUSTOMER_MESSAGE,
  envConfig,
  FakeLedger,
  INBOX_ID,
  InMemoryOwnershipGate,
  makeBinding,
  messageCreatedPayload,
  signRequest,
  StubAgentRuntime,
  StubChatwootApi,
  TENANT_ID,
} from "./harness.js";
import { FakeHermes, type FakeRun } from "./hermes-fake.js";
import { callHandler, FakeTurnSql } from "./hermes-inproc.js";

const BEARER = "not-a-real-hermes-key-0000000000000000";
const REF: ConversationRef = { tenantId: TENANT_ID, chatwootAccountId: ACCOUNT_ID, chatwootConversationId: CONVERSATION_DISPLAY_ID };
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const answer = (text: string): string => JSON.stringify({ disposition: "answer", text });

function hermesEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    GATEWAY_LEDGER_URL: "postgres://ledger.test/db",
    GATEWAY_HERMES_AGENT_IDS: "agent-1",
    GATEWAY_HERMES_BASE_URL: "http://hermes.test:8642",
    GATEWAY_HERMES_BEARER: BEARER,
    GATEWAY_HERMES_POLL_INTERVAL_MS: "100",
    GATEWAY_HERMES_REQUEST_TIMEOUT_MS: "2000",
    GATEWAY_HERMES_RUN_DEADLINE_MS: "3000",
    ...extra,
  };
}

interface Rig {
  gateway: Gateway;
  fake: FakeHermes;
  chatwoot: StubChatwootApi;
  ledger: FakeLedger;
  ownership: InMemoryOwnershipGate;
  turns: FakeTurnSql;
  capture: CapturingLogger;
  post(over?: Parameters<typeof messageCreatedPayload>[0], deliveryId?: string): ReturnType<typeof callHandler>;
}

function rig(opts: { env?: Record<string, string>; fake?: FakeHermes; ownership?: InMemoryOwnershipGate } = {}): Rig {
  const fake = opts.fake ?? new FakeHermes();
  const config = envConfig(hermesEnv(opts.env));
  expect(bootErrors(config), "the rig's own configuration must boot").toEqual([]);
  const chatwoot = new StubChatwootApi();
  const ledger = new FakeLedger();
  const ownership = opts.ownership ?? new InMemoryOwnershipGate();
  const turns = new FakeTurnSql();
  const capture = new CapturingLogger();
  // The REAL egress guard over the fake transport: the derived allowlist must admit the Hermes host.
  const safeFetch = createSafeFetch({ allowlist: config.egressAllowlist, transport: fake.fetch });
  const gateway = createGateway({
    config,
    chatwoot,
    ledger,
    ownership,
    turnStore: turns,
    safeFetch,
    logger: capture.logger,
  });
  let n = 0;
  return {
    gateway,
    fake,
    chatwoot,
    ledger,
    ownership,
    turns,
    capture,
    post: (over = {}, deliveryId) => {
      n += 1;
      const id = deliveryId ?? `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
      // Message ids grow by 100 per post, so a staff reply (e.g. 9150) can sit between two customer messages.
      return callHandler(gateway.handler, signRequest({ body: messageCreatedPayload({ id: 9000 + n * 100, ...over }), deliveryId: id }));
    },
  };
}

function completeWith(fake: FakeHermes, output: string, delayMs = 15): void {
  fake.onRun = (run: FakeRun) => {
    run.running();
    setTimeout(() => run.complete(output), delayMs);
  };
}

describe("signed webhook -> pipeline -> HermesDirectRuntime -> fake Hermes -> reply (no socket)", () => {
  it("CONTROL: one customer message in, one reply out; one create; the reply is the envelope text; nothing else was written to the customer", async () => {
    const r = rig();
    completeWith(r.fake, answer("The 200 minute plan is $20."));
    const res = await r.post({ content: CUSTOMER_MESSAGE });
    expect(res.status).toBe(200);
    expect(res.json["outcome"]).toBe("accepted");
    await r.gateway.drain();

    expect(r.chatwoot.customerMessages).toHaveLength(1);
    expect(JSON.stringify(r.chatwoot.customerMessages[0])).toContain("The 200 minute plan is $20.");
    expect(r.fake.creates).toHaveLength(1);
    expect(String(r.fake.creates[0]!.body!["input"])).toContain(CUSTOMER_MESSAGE);
    // the whole ledger beneath the delivery is closed
    expect([...r.ledger.rows.values()].every((row) => row.state === "completed")).toBe(true);
    // the Hermes request carried the bearer ONLY in the header and the run was read to the end
    expect(r.fake.counted).toBe(0);
    const everything = r.capture.raw.join("\n");
    expect(everything).not.toContain(BEARER);
    expect(everything).not.toContain(CUSTOMER_MESSAGE);
  });

  it("ONE EXECUTION OWNER: an employee that is NOT enabled for Hermes keeps the old runtime and never touches Hermes (default OFF)", async () => {
    const fake = new FakeHermes();
    const legacy = StubAgentRuntime.answering("LEGACY RUNTIME ANSWER");
    const config = envConfig({});
    const chatwoot = new StubChatwootApi();
    const gateway = createGateway({
      config,
      chatwoot,
      ledger: new FakeLedger(),
      ownership: new InMemoryOwnershipGate(),
      runtime: legacy,
      safeFetch: fake.fetch,
    });
    const res = await callHandler(gateway.handler, signRequest({ body: messageCreatedPayload(), deliveryId: "00000000-0000-4000-8000-0000000000aa" }));
    expect(res.status).toBe(200);
    await gateway.drain();
    expect(legacy.requests).toHaveLength(1);
    expect(fake.log, "Hermes was contacted although it is not enabled").toHaveLength(0);
    expect(chatwoot.customerMessages).toHaveLength(1);
  });

  it("when Hermes IS enabled the legacy isola-runtime is not also called for the same message (the old URL is never contacted)", async () => {
    const r = rig();
    completeWith(r.fake, answer("only Hermes spoke"));
    await r.post();
    await r.gateway.drain();
    expect(r.fake.log.every((l) => new URL(l.url).hostname === "hermes.test")).toBe(true);
    expect(r.chatwoot.customerMessages).toHaveLength(1);
  });
});

describe("multi-turn: continuity is the gateway's own transcript, the SAME conversation only", () => {
  it("turn 2 carries turn 1 and the bot's own reply as history (user / assistant), and not the current message", async () => {
    const r = rig();
    completeWith(r.fake, answer("First answer."));
    await r.post({ content: "Do you sell calling plans?" });
    await r.gateway.drain();

    // Chatwoot echoes the bot's own reply as a message_created event: the gateway records it as a business turn.
    await callHandler(
      r.gateway.handler,
      signRequest({
        body: messageCreatedPayload({ id: 9150, content: "First answer.", message_type: "outgoing", sender: { type: "agent_bot", id: 3 } }),
        deliveryId: "00000000-0000-4000-8000-0000000000bb",
      }),
    );
    await r.gateway.drain();

    completeWith(r.fake, answer("Second answer."));
    await r.post({ content: "And does it work on WhatsApp?" });
    await r.gateway.drain();

    expect(r.fake.creates).toHaveLength(2);
    expect(r.fake.creates[1]!.body!["conversation_history"]).toEqual([
      { role: "user", content: "Do you sell calling plans?" },
      { role: "assistant", content: "First answer." },
    ]);
    expect(String(r.fake.creates[1]!.body!["input"])).toContain("And does it work on WhatsApp?");
    expect(JSON.stringify(r.fake.creates[1]!.body!["conversation_history"])).not.toContain("And does it work on WhatsApp?");
    // the label is the SAME for both turns of one conversation
    expect(r.fake.creates[1]!.body!["session_id"]).toBe(r.fake.creates[0]!.body!["session_id"]);
  });

  // KNOWN GAP, reported to the coordinator and Lane A (not fixed here: it is in the reviewed webhook
  // path). A signed HUMAN-AGENT reply takes the `human_reply` decision, which records the takeover in the
  // ownership ledger and returns BEFORE the transcript-recording block (which handles only the accept and
  // suppressed decisions). So what staff wrote is NOT in the transcript, although src/turns.ts says human
  // replies are recorded: after a handback the model would not see what the person told the customer.
  // THIS TEST PINS THE GAP SO IT STAYS VISIBLE; it does not endorse it (Law 28: a test around behaviour nobody
  // chose preserves the accident). The day the webhook path records human replies it turns RED: flip the final
  // expectation to include the staff line and delete this comment.
  it("KNOWN GAP (pinned, to be flipped when fixed): a human agent's reply is NOT in the next turn's history today", async () => {
    const r = rig();
    completeWith(r.fake, answer("First answer."));
    await r.post({ content: "Do you sell calling plans?" });
    await r.gateway.drain();
    const staff = await callHandler(
      r.gateway.handler,
      signRequest({
        body: messageCreatedPayload({ id: 9150, content: "Hi, this is Ann from EPIC: yes, plans start at $10.", message_type: "outgoing", sender: { type: "user", id: 9 } }),
        deliveryId: "00000000-0000-4000-8000-0000000000b1",
      }),
    );
    expect(staff.json["outcome"]).toBe("human_reply");
    completeWith(r.fake, answer("Second answer."));
    // (the human takeover is recorded in the ownership ledger by the executor in production; this rig has none,
    // so the bot still answers: the point here is only what the transcript holds)
    await r.post({ content: "And does it work on WhatsApp?" });
    await r.gateway.drain();
    expect(r.fake.creates).toHaveLength(2);
    // controls: the earlier customer turn IS there, so the transcript works; only the staff line is missing
    expect(r.fake.creates[1]!.body!["conversation_history"]).toEqual([{ role: "user", content: "Do you sell calling plans?" }]);
    expect(JSON.stringify(r.turns.rows)).not.toContain("yes, plans start at $10.");
  });

  it("ISOLATION: another conversation, the same conversation id under another account, private notes and activity lines never reach the history", async () => {
    const r = rig();
    // other material already recorded in the store
    const rec = (account: number, conversation: number, message: number, role: "customer" | "business", content: string): void =>
      void r.turns.rows.push({ tenant: TENANT_ID, account, conversation, message, role, author: "unknown", content });
    rec(ACCOUNT_ID, 99, 1, "customer", "OTHER CONVERSATION SECRET");
    rec(2, CONVERSATION_DISPLAY_ID, 2, "customer", "OTHER ACCOUNT SAME CONVERSATION ID SECRET");
    completeWith(r.fake, answer("ok"));

    // a private note and an activity line arrive in THIS conversation (never recorded)
    await callHandler(
      r.gateway.handler,
      signRequest({
        body: messageCreatedPayload({ id: 8000, content: "INTERNAL STAFF NOTE", message_type: "outgoing", private: true, sender: { type: "user", id: 9 } }),
        deliveryId: "00000000-0000-4000-8000-0000000000cc",
      }),
    );
    await callHandler(
      r.gateway.handler,
      signRequest({
        body: messageCreatedPayload({ id: 8001, content: "Conversation was marked open by system", message_type: "activity" }),
        deliveryId: "00000000-0000-4000-8000-0000000000dd",
      }),
    );
    await r.post({ content: "My own question" });
    await r.gateway.drain();

    expect(r.fake.creates).toHaveLength(1);
    const sent = JSON.stringify(r.fake.creates[0]!.body);
    expect(sent).not.toContain("OTHER CONVERSATION SECRET");
    expect(sent).not.toContain("OTHER ACCOUNT SAME CONVERSATION ID SECRET");
    expect(sent).not.toContain("INTERNAL STAFF NOTE");
    expect(sent).not.toContain("marked open by system");
    // control: the question itself IS there, and a first message has no history key at all
    expect(sent).toContain("My own question");
    expect("conversation_history" in r.fake.creates[0]!.body!).toBe(false);
  });

  it("no transcript store configured: the gateway answers NOTHING and escalates once (never an answer without history)", async () => {
    const fake = new FakeHermes();
    const config = envConfig(hermesEnv());
    const chatwoot = new StubChatwootApi();
    const gateway = createGateway({
      config,
      chatwoot,
      ledger: new FakeLedger(),
      ownership: new InMemoryOwnershipGate(),
      safeFetch: createSafeFetch({ allowlist: config.egressAllowlist, transport: fake.fetch }),
    });
    completeWith(fake, answer("must never be sent"));
    await callHandler(gateway.handler, signRequest({ body: messageCreatedPayload(), deliveryId: "00000000-0000-4000-8000-0000000000ee" }));
    await gateway.drain();
    expect(chatwoot.customerMessages).toHaveLength(0);
    expect(chatwoot.privateNotes).toHaveLength(1);
    expect(fake.log).toHaveLength(0);
  });
});

describe("takeover and fail-closed over the route", () => {
  it("a human takes the conversation while Hermes is 'working': the run is STOPPED, nothing is sent or written, the ledger row closes", async () => {
    const ownership = new InMemoryOwnershipGate();
    const r = rig({ ownership });
    r.fake.onRun = (run) => {
      run.running();
      setTimeout(() => ownership.seed(REF, "HUMAN_OWNED", 1), 40);
    };
    const res = await r.post();
    expect(res.status).toBe(200);
    await r.gateway.drain();

    expect((await ownership.read(REF)).state).toBe("HUMAN_OWNED");
    expect(r.chatwoot.customerMessages).toHaveLength(0);
    const writes = r.chatwoot.calls.filter((c) =>
      ["message", "toggle_status", "toggle_status_pending", "assignment", "labels_write", "attributes_write"].includes(c.kind),
    );
    expect(writes).toEqual([]);
    expect(r.capture.withOutcome("suppressed_in_flight")).toHaveLength(1);
    expect(r.fake.stops).toHaveLength(1);
    expect([...r.ledger.rows.values()].map((row) => row.state)).toEqual(["completed"]);
  });

  it("the same takeover when the run had ALREADY finished (stop answers 404): the finished text is still never sent", async () => {
    const ownership = new InMemoryOwnershipGate();
    const r = rig({ ownership });
    r.fake.stopStatus = 404;
    r.fake.onRun = (run) => {
      run.running();
      ownership.seed(REF, "HUMAN_OWNED", 1);
      run.complete(answer("this must never reach the customer"));
    };
    await r.post();
    await r.gateway.drain();
    expect(r.chatwoot.customerMessages).toHaveLength(0);
  });

  it("an unparseable envelope: NO customer message from the model output, and exactly ONE escalation to staff", async () => {
    const r = rig();
    completeWith(r.fake, "Sure! The plan costs twenty dollars. (no envelope)");
    await r.post();
    await r.gateway.drain();
    expect(r.chatwoot.customerMessages).toHaveLength(0);
    expect(r.chatwoot.privateNotes).toHaveLength(1);
    expect(r.chatwoot.statusToggles).toHaveLength(1);
    expect(r.capture.withOutcome("hermes_envelope_invalid").length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(r.chatwoot.privateNotes[0])).toContain("hermes_envelope_invalid");
  });

  it("a request_human envelope: the handover text is sent ONCE and the conversation is escalated ONCE", async () => {
    const r = rig();
    completeWith(r.fake, JSON.stringify({ disposition: "request_human", text: "I will bring in a colleague.", reason: "explicit_human_request" }));
    await r.post();
    await r.gateway.drain();
    expect(r.chatwoot.customerMessages).toHaveLength(1);
    expect(JSON.stringify(r.chatwoot.customerMessages[0])).toContain("I will bring in a colleague.");
    expect(r.chatwoot.statusToggles).toHaveLength(1);
  });

  it("a failed Hermes run: no customer message, one escalation, and the failure is named for the colleague", async () => {
    const r = rig();
    r.fake.onRun = (run) => {
      run.running();
      setTimeout(() => run.fail("provider returned 400"), 15);
    };
    await r.post();
    await r.gateway.drain();
    expect(r.chatwoot.customerMessages).toHaveLength(0);
    expect(r.chatwoot.privateNotes).toHaveLength(1);
    expect(JSON.stringify(r.chatwoot.privateNotes[0])).toContain("hermes_run_failed");
  });
});

describe("duplicates and restarts: Hermes /v1/runs ignores Idempotency-Key, so the ledger and the adapter are the only protection", () => {
  it("the SAME signed delivery posted twice: one run, one reply (the ledger refuses the twin before Hermes is reached)", async () => {
    const r = rig();
    completeWith(r.fake, answer("once"));
    const signed = signRequest({ body: messageCreatedPayload({ id: 9700 }), deliveryId: "00000000-0000-4000-8000-0000000000f1" });
    const a = await callHandler(r.gateway.handler, signed);
    const b = await callHandler(r.gateway.handler, signed); // the byte-identical redelivery Chatwoot retries
    await r.gateway.drain();
    expect(a.json["outcome"]).toBe("accepted");
    expect(b.status).toBe(200);
    expect(b.json["outcome"]).not.toBe("accepted");
    expect(r.fake.creates, "a replay must never start a second run").toHaveLength(1);
    expect(r.chatwoot.customerMessages).toHaveLength(1);
  });

  it("a turn interrupted mid-run (budget spent), then the lease expires: recovery ESCALATES ONCE and NEVER POSTs a second run or re-sends a reply", async () => {
    const fake = new FakeHermes();
    fake.onRun = (run) => run.running(); // the run never finishes
    const config = envConfig(hermesEnv({ GATEWAY_TURN_BUDGET_MS: "250", GATEWAY_HERMES_RUN_DEADLINE_MS: "4000" }));
    const chatwoot = new StubChatwootApi();
    const ledger = new FakeLedger();
    const ownership = new InMemoryOwnershipGate();
    const capture = new CapturingLogger();
    const safeFetch = createSafeFetch({ allowlist: config.egressAllowlist, transport: fake.fetch });
    const runtime = new HermesDirectRuntime({
      baseUrl: "http://hermes.test:8642",
      bearer: BEARER,
      safeFetch,
      runDeadlineMs: 4000,
      pollIntervalMs: 10,
      requestTimeoutMs: 1000,
      maxInflight: 4,
      streamDrainGraceMs: 100,
    });
    const binding = makeBinding();
    const payload = parseWebhookPayload(Buffer.from(JSON.stringify(messageCreatedPayload())))!;
    const turns = new FakeTurnSql();
    turns.rows.push({ tenant: TENANT_ID, account: ACCOUNT_ID, conversation: CONVERSATION_DISPLAY_ID, message: payload.messageId, role: "customer", author: "customer", content: CUSTOMER_MESSAGE });
    const deps: PipelineDeps = {
      config,
      chatwoot,
      runtime,
      logger: capture.logger,
      ledger,
      ownership,
      turnStore: turns,
      failpoint: DISARMED,
      now: () => Date.now(),
    };
    const job: DeliveryJob = {
      correlationId: "corr-restart",
      deliveryId: "delivery-restart",
      identity: { tenantId: TENANT_ID, bindingId: bindingIdentity(binding), chatwootAccountId: ACCOUNT_ID, chatwootInboxId: INBOX_ID, eventId: "delivery:restart" },
      digest: "digest-restart",
      binding,
      payload,
      conversationId: CONVERSATION_DISPLAY_ID,
      startedAtMs: Date.now(),
      mode: "answer",
      classification: null,
    };
    await ledger.reserve({ identity: job.identity, digest: job.digest, correlationId: job.correlationId, conversationId: job.conversationId, messageId: payload.messageId, mode: "answer", leaseMs: 300_000 });

    await processDelivery(deps, job);
    expect(fake.creates, "the first attempt started exactly one run").toHaveLength(1);
    expect(chatwoot.customerMessages).toHaveLength(0);

    // the process "restarts": the lease expires and the REAL sweeper takes the open delivery
    ledger.expireAllLeases();
    const sweeper = createSweeper({
      config,
      ledger,
      bindingStore: { list: () => [binding] },
      chatwoot,
      runtime,
      logger: capture.logger,
      ownership,
      failpoint: DISARMED,
      now: () => Date.now(),
    });
    await sweeper.sweep();
    await sweeper.sweep(); // a second sweep finds nothing left to do

    expect(fake.creates, "recovery must never re-POST a run").toHaveLength(1);
    expect(chatwoot.customerMessages, "nothing is sent to the customer by recovery").toHaveLength(0);
    expect(chatwoot.privateNotes, "ONE recorded escalation").toHaveLength(1);
    expect(chatwoot.statusToggles).toHaveLength(1);
    expect(sleep).toBeDefined();
  });
});
