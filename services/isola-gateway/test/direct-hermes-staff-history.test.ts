/**
 * STEP A+ (direct Hermes path), commit 1: STAFF REPLIES MUST REACH THE HISTORY (Lane A ruling).
 *
 * Gap found in Step A: a signed HUMAN-AGENT reply takes the `human_reply` decision in src/app.ts, which
 * records ownership and returns BEFORE the transcript-recording block (that block handled only the `accept`
 * and `suppressed` decisions). So after a handback the model never saw what the person told the customer,
 * although src/turns.ts says human replies are recorded.
 *
 * THE PATH, NOT THE PIECES (Law 20): every test drives a SIGNED webhook through the gateway's real handler
 * (binding -> decision -> transcript -> pipeline -> HermesDirectRuntime -> a FAKE Hermes -> the reply), with no
 * socket. Every "is not included" has its positive twin in the same run: the staff line IS in the history, so
 * "the private note / the other conversation is absent" is a property of the gateway and not of a harness that
 * records nothing (Laws 11, 19, 23, 28). The fake follows lane 59's Step-B-verified contract; it is not
 * evidence of installed behaviour (Law 5).
 *
 * LABEL: a staff turn is stored and sent as `[A teammate replied]: <text>` (the form lane 59's Step B isolation
 * script used: .checkpoint-out/public-hermes/step_b.sh), with role `assistant` in conversation_history (the
 * store collapses every business voice into `business`, and the model reads the label inside the content).
 */
import { describe, expect, it } from "vitest";

import { createGateway, type Gateway } from "../src/app.js";
import { bootErrors } from "../src/config.js";
import { createSafeFetch } from "../src/egress.js";
import type { ConversationRef } from "../src/ownership.js";
import {
  ACCOUNT_ID,
  CapturingLogger,
  CONVERSATION_DISPLAY_ID,
  envConfig,
  FakeLedger,
  InMemoryOwnershipGate,
  messageCreatedPayload,
  signRequest,
  StubChatwootApi,
  TENANT_ID,
} from "./harness.js";
import { FakeHermes, type FakeRun } from "./hermes-fake.js";
import { callHandler, FakeTurnSql } from "./hermes-inproc.js";

const BEARER = "not-a-real-hermes-key-0000000000000000";
const REF: ConversationRef = { tenantId: TENANT_ID, chatwootAccountId: ACCOUNT_ID, chatwootConversationId: CONVERSATION_DISPLAY_ID };
const LABEL = "[A teammate replied]: ";
const STAFF_TEXT = "Hi, this is Ann from EPIC: yes, plans start at $10.";
const answer = (text: string): string => JSON.stringify({ disposition: "answer", text });

function hermesEnv(): Record<string, string> {
  return {
    GATEWAY_LEDGER_URL: "postgres://ledger.test/db",
    GATEWAY_HERMES_AGENT_IDS: "agent-1",
    GATEWAY_HERMES_BASE_URL: "http://hermes.test:8642",
    GATEWAY_HERMES_BEARER: BEARER,
    GATEWAY_HERMES_POLL_INTERVAL_MS: "100",
    GATEWAY_HERMES_REQUEST_TIMEOUT_MS: "2000",
    GATEWAY_HERMES_RUN_DEADLINE_MS: "3000",
  };
}

interface Rig {
  gateway: Gateway;
  fake: FakeHermes;
  chatwoot: StubChatwootApi;
  ownership: InMemoryOwnershipGate;
  turns: FakeTurnSql;
  capture: CapturingLogger;
  /** A signed webhook with its own delivery id; `id` is the Chatwoot message id. */
  send(over: Parameters<typeof messageCreatedPayload>[0]): ReturnType<typeof callHandler>;
}

function rig(): Rig {
  const fake = new FakeHermes();
  const config = envConfig(hermesEnv());
  expect(bootErrors(config), "the rig's own configuration must boot").toEqual([]);
  const chatwoot = new StubChatwootApi();
  const ownership = new InMemoryOwnershipGate();
  const turns = new FakeTurnSql();
  const capture = new CapturingLogger();
  const gateway = createGateway({
    config,
    chatwoot,
    ledger: new FakeLedger(),
    ownership,
    turnStore: turns,
    safeFetch: createSafeFetch({ allowlist: config.egressAllowlist, transport: fake.fetch }),
    logger: capture.logger,
  });
  let n = 0;
  return {
    gateway,
    fake,
    chatwoot,
    ownership,
    turns,
    capture,
    send: (over) => {
      n += 1;
      return callHandler(
        gateway.handler,
        signRequest({ body: messageCreatedPayload(over), deliveryId: `00000000-0000-4000-8000-${String(n + 4000).padStart(12, "0")}` }),
      );
    },
  };
}

function completeWith(fake: FakeHermes, output: string, delayMs = 15): void {
  fake.onRun = (run: FakeRun) => {
    run.running();
    setTimeout(() => run.complete(output), delayMs);
  };
}

const customer = (id: number, content: string, conversation = CONVERSATION_DISPLAY_ID): Parameters<typeof messageCreatedPayload>[0] => ({
  id,
  content,
  conversation: { id: conversation, status: "pending", meta: { assignee: null }, custom_attributes: {} },
});
const staff = (id: number, content: string, extra: Record<string, unknown> = {}): Parameters<typeof messageCreatedPayload>[0] => ({
  id,
  content,
  message_type: "outgoing",
  sender: { type: "user", id: 9 },
  ...extra,
});
const botEcho = (id: number, content: string): Parameters<typeof messageCreatedPayload>[0] => ({
  id,
  content,
  message_type: "outgoing",
  sender: { type: "agent_bot", id: 3 },
});

describe("STAFF REPLIES REACH THE HISTORY (route-level, Law 20)", () => {
  it("HANDBACK: customer -> AI reply -> staff takes over and replies -> explicit handback -> next customer message: the model request carries all three, IN ORDER, staff labelled", async () => {
    const r = rig();
    completeWith(r.fake, answer("Yes, we sell calling plans."));
    await r.send(customer(9100, "Do you sell calling plans?"));
    await r.gateway.drain();
    // Chatwoot echoes the bot's own reply
    await r.send(botEcho(9150, "Yes, we sell calling plans."));
    // a person takes the conversation and replies
    r.ownership.seed(REF, "HUMAN_OWNED", 1);
    const res = await r.send(staff(9160, STAFF_TEXT));
    expect(res.json["outcome"]).toBe("human_reply");
    // explicit handback (the verified transition leaves the conversation AI-owned again)
    r.ownership.seed(REF, "AI_OWNED", 2);

    completeWith(r.fake, answer("Plans start at $10."));
    await r.send(customer(9200, "And what is the cheapest?"));
    await r.gateway.drain();

    expect(r.fake.creates).toHaveLength(2);
    expect(r.fake.creates[1]!.body!["conversation_history"]).toEqual([
      { role: "user", content: "Do you sell calling plans?" },
      { role: "assistant", content: "Yes, we sell calling plans." },
      { role: "assistant", content: `${LABEL}${STAFF_TEXT}` },
    ]);
    // the current message is the input, never also history
    expect(String(r.fake.creates[1]!.body!["input"])).toContain("And what is the cheapest?");
    expect(JSON.stringify(r.fake.creates[1]!.body!["conversation_history"])).not.toContain("And what is the cheapest?");
    // positive twin: the second answer was sent to the customer
    expect(r.chatwoot.customerMessages).toHaveLength(2);
  });

  it("the stored staff turn is a business turn attributed to a HUMAN, labelled once, and the AI's own echo is NOT labelled as a teammate", async () => {
    const r = rig();
    await r.send(botEcho(9100, "The bot said this."));
    await r.send(staff(9110, STAFF_TEXT));
    const ai = r.turns.rows.find((row) => row["message"] === 9100);
    const human = r.turns.rows.find((row) => row["message"] === 9110);
    expect(ai).toMatchObject({ role: "business", author: "ai", content: "The bot said this." });
    expect(human).toMatchObject({ role: "business", author: "human", content: `${LABEL}${STAFF_TEXT}` });
    expect(String(human!["content"]).split(LABEL).length - 1, "the label appears exactly once").toBe(1);
  });

  it("ISOLATION: another conversation's staff reply, another account's, and a PRIVATE staff note never reach this conversation's history", async () => {
    const r = rig();
    // other conversation, same account/inbox: a staff reply recorded under conversation 99
    await r.send(staff(8001, "OTHER CONVERSATION STAFF SECRET", { conversation: { id: 99, status: "open", meta: { assignee: null }, custom_attributes: {} } }));
    // this conversation: a PRIVATE staff note and an activity line, and a public staff reply (the positive twin)
    await r.send(staff(8002, "INTERNAL STAFF NOTE", { private: true }));
    await r.send({ id: 8003, content: "Conversation was marked open by system", message_type: "activity" });
    await r.send(staff(9110, STAFF_TEXT));
    completeWith(r.fake, answer("ok"));
    await r.send(customer(9200, "My own question"));
    await r.gateway.drain();

    expect(r.fake.creates).toHaveLength(1);
    const sent = JSON.stringify(r.fake.creates[0]!.body);
    expect(sent).not.toContain("OTHER CONVERSATION STAFF SECRET");
    expect(sent).not.toContain("INTERNAL STAFF NOTE");
    expect(sent).not.toContain("marked open by system");
    // control: this conversation's own staff reply IS there, so the recording works
    expect(sent).toContain(STAFF_TEXT);
    // control: the other conversation's reply WAS recorded (under its own conversation), so its absence above is isolation
    expect(r.turns.rows.some((row) => row["conversation"] === 99 && String(row["content"]).includes("OTHER CONVERSATION STAFF SECRET"))).toBe(true);
    // the private note was never recorded anywhere
    expect(JSON.stringify(r.turns.rows)).not.toContain("INTERNAL STAFF NOTE");
  });

  it("REDELIVERY: Chatwoot re-sends the same staff webhook (new delivery id, same message id): the turn is recorded ONCE", async () => {
    const r = rig();
    await r.send(staff(9110, STAFF_TEXT));
    await r.send(staff(9110, STAFF_TEXT));
    await r.send(staff(9110, STAFF_TEXT));
    expect(r.turns.rows.filter((row) => row["message"] === 9110)).toHaveLength(1);
    // control: a DIFFERENT staff message is a different turn
    await r.send(staff(9120, "A second thing from Ann."));
    expect(r.turns.rows.filter((row) => row["author"] === "human")).toHaveLength(2);
    completeWith(r.fake, answer("ok"));
    await r.send(customer(9200, "thanks"));
    await r.gateway.drain();
    const history = r.fake.creates[0]!.body!["conversation_history"] as Array<{ content: string }>;
    expect(history.filter((h) => h.content.includes(STAFF_TEXT))).toHaveLength(1);
  });

  it("REDELIVERY rests on the PRODUCTION statement: the staff-turn INSERT is keyed on (account, message) with ON CONFLICT ... DO NOTHING (the in-memory model alone is not proof)", async () => {
    const r = rig();
    await r.send(staff(9110, STAFF_TEXT));
    const staffInsert = r.turns.insertStatements.find((s) => s.includes("INSERT INTO conversation_turn"));
    expect(staffInsert).toBeDefined();
    expect(staffInsert).toContain("ON CONFLICT (chatwoot_account_id, chatwoot_message_id) DO NOTHING");
    // control: the model's dedupe is only the model of that statement; the statement itself is what production runs
    expect(r.turns.insertStatements).toHaveLength(1);
  });

  it("the staff reply is recorded even when NO ownership executor is configured (the early return no longer skips the transcript)", async () => {
    const r = rig(); // the rig has no ownershipExec: the human_reply branch logs and returns early
    await r.send(staff(9110, STAFF_TEXT));
    expect(r.capture.raw.join("\n")).toContain("ownership_exec_not_configured"); // control: that early-return branch really ran
    expect(r.turns.rows.some((row) => String(row["content"]) === `${LABEL}${STAFF_TEXT}`)).toBe(true);
  });
});

describe("FAIL CLOSED when the staff turn cannot be recorded (never answer from a history with a hole)", () => {
  it("the transcript write fails for the staff reply: the webhook still returns human_reply, an ALERT is logged, and the NEXT AI turn answers NOTHING and escalates ONCE", async () => {
    const r = rig();
    completeWith(r.fake, answer("First answer."));
    await r.send(customer(9100, "Do you sell calling plans?"));
    await r.gateway.drain();
    const customerMessagesBefore = r.chatwoot.customerMessages.length;

    r.turns.failNextInserts = 1;
    const res = await r.send(staff(9150, STAFF_TEXT));
    expect(res.status).toBe(200);
    expect(res.json["outcome"]).toBe("human_reply"); // the takeover acknowledgement is unaffected
    expect(r.turns.insertAttempts, "the write was TRIED").toBeGreaterThanOrEqual(2);
    expect(r.turns.rows.some((row) => String(row["content"]).includes(STAFF_TEXT))).toBe(false);
    expect(r.capture.raw.join("\n")).toContain("human_reply_turn_not_recorded");

    // explicit handback, then the customer writes again
    r.ownership.seed(REF, "AI_OWNED", 2);
    const createsBefore = r.fake.creates.length;
    completeWith(r.fake, answer("must never be sent: it would ignore what the teammate said"));
    await r.send(customer(9200, "And what is the cheapest?"));
    await r.gateway.drain();

    expect(r.fake.creates.length, "Hermes must NOT be called with a history that has a hole").toBe(createsBefore);
    expect(r.chatwoot.customerMessages).toHaveLength(customerMessagesBefore);
    expect(r.chatwoot.privateNotes.length, "exactly ONE escalation to staff").toBe(1);
  });

  it("POSITIVE TWIN: the same flow with a healthy store answers the next turn with the staff reply in history", async () => {
    const r = rig();
    completeWith(r.fake, answer("First answer."));
    await r.send(customer(9100, "Do you sell calling plans?"));
    await r.gateway.drain();
    await r.send(staff(9150, STAFF_TEXT));
    r.ownership.seed(REF, "AI_OWNED", 2);
    completeWith(r.fake, answer("Plans start at $10."));
    await r.send(customer(9200, "And what is the cheapest?"));
    await r.gateway.drain();
    expect(r.fake.creates).toHaveLength(2);
    expect(JSON.stringify(r.fake.creates[1]!.body!["conversation_history"])).toContain(STAFF_TEXT);
    expect(r.chatwoot.customerMessages).toHaveLength(2);
    expect(r.chatwoot.privateNotes).toHaveLength(0);
  });

  it("the gap is per CONVERSATION: another conversation in the same account still gets its answer", async () => {
    const r = rig();
    r.turns.failNextInserts = 1;
    await r.send(staff(9150, STAFF_TEXT)); // conversation CONVERSATION_DISPLAY_ID: hole
    completeWith(r.fake, answer("other conversation answered"));
    await r.send(customer(9200, "hello from elsewhere", 77));
    await r.gateway.drain();
    expect(r.fake.creates).toHaveLength(1);
    expect(r.chatwoot.customerMessages).toHaveLength(1);
  });
});
