/**
 * STEP A+ (direct Hermes path): WEBHOOK RETRY SEMANTICS, over the route with the direct Hermes path wired.
 *
 * FACT (lane 59, relayed): Chatwoot retries an agent-bot webhook ONLY on HTTP 429 and 500 (v4.16.1,
 * `RETRYABLE_AGENT_BOT_STATUSES = [429, 500]`; src/app.ts:137 says the same). So the gateway must NEVER
 * answer 429/500 to a duplicate delivery it has ALREADY ACCEPTED (that would invite a retry of work that
 * is done or running), and 500 must be reserved for the one case where a retry is wanted: the delivery
 * could not be durably recorded.
 *
 * STATUSES THE WEBHOOK ROUTE CAN RETURN TODAY (read from src/app.ts, handleWebhook):
 *   200  accepted / duplicate_suppressed / suppressed / human_reply / ... (nothing for Chatwoot to retry)
 *   400  bad_request, 401 unauthorized, 405 wrong method, 413 payload too large, 422 unroutable_event
 *   409  ledger_conflict (same delivery id, different signed body)
 *   500  ledger_unavailable (reserve() threw: the ONE intended retry case) and the outer catch around
 *        handleWebhook (an UNEXPECTED exception; it is not reachable for a duplicate: a duplicate takes
 *        reserve() -> `duplicate` -> finish(200) with only pure steps before it)
 *   429  NEVER from this route (the only 429 in app.ts is the separate voice route, finish(429, "rate_limited"))
 *
 * Every refusal here has its positive twin in the same harness: the SAME rig answers a correctly signed,
 * first-time delivery with a run and a reply, so "no second run" is a property of the gateway and not of a
 * rig that refuses everything (Laws 11, 19, 23, 28). The fake Hermes follows lane 59's Step-B-verified
 * contract and is NOT evidence of installed behaviour (Law 5). Socket-free.
 */
import { describe, expect, it } from "vitest";

import { createGateway, type Gateway } from "../src/app.js";
import { bootErrors } from "../src/config.js";
import { createSafeFetch } from "../src/egress.js";
import {
  CapturingLogger,
  envConfig,
  FakeLedger,
  InMemoryOwnershipGate,
  messageCreatedPayload,
  signRequest,
  StubChatwootApi,
} from "./harness.js";
import { FakeHermes, type FakeRun } from "./hermes-fake.js";
import { callHandler, FakeTurnSql } from "./hermes-inproc.js";

const BEARER = `fake-hermes-${"0".repeat(32)}`; // a made-up value, built so no credential-looking literal is committed
const answer = (text: string): string => JSON.stringify({ disposition: "answer", text });
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

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
  ledger: FakeLedger;
  capture: CapturingLogger;
  /** Every HTTP status the webhook route returned in this rig, in order. */
  statuses: number[];
  call(signed: ReturnType<typeof signRequest>): ReturnType<typeof callHandler>;
}

function rig(): Rig {
  const fake = new FakeHermes();
  fake.bearer = BEARER; // the fake checks the Authorization header against this value
  const config = envConfig(hermesEnv());
  expect(bootErrors(config), "the rig's own configuration must boot").toEqual([]);
  const chatwoot = new StubChatwootApi();
  const ledger = new FakeLedger();
  const capture = new CapturingLogger();
  const gateway = createGateway({
    config,
    chatwoot,
    ledger,
    ownership: new InMemoryOwnershipGate(),
    turnStore: new FakeTurnSql(),
    safeFetch: createSafeFetch({ allowlist: config.egressAllowlist, transport: fake.fetch }),
    logger: capture.logger,
  });
  const statuses: number[] = [];
  return {
    gateway,
    fake,
    chatwoot,
    ledger,
    capture,
    statuses,
    call: async (signed) => {
      const res = await callHandler(gateway.handler, signed);
      statuses.push(res.status);
      return res;
    },
  };
}

function completeWith(fake: FakeHermes, output: string, delayMs = 15): void {
  fake.onRun = (run: FakeRun) => {
    run.running();
    setTimeout(() => run.complete(output), delayMs);
  };
}

const DELIVERY = "00000000-0000-4000-8000-00000000d001";
const body = (content = "Do you sell calling plans?"): Record<string, unknown> => messageCreatedPayload({ id: 9100, content });

describe("(a) a REDELIVERY of an already-accepted delivery is a 2xx and does nothing", () => {
  it("after the first one COMPLETED: 200 duplicate_suppressed, NO second Hermes run, NO second reply, no new ledger row", async () => {
    const r = rig();
    completeWith(r.fake, answer("Yes, we do."));
    const signed = signRequest({ body: body(), deliveryId: DELIVERY });
    const first = await r.call(signed);
    expect(first.status).toBe(200);
    expect(first.json["outcome"]).toBe("accepted");
    await r.gateway.drain();
    // positive control: the first delivery really ran and replied
    expect(r.fake.creates).toHaveLength(1);
    expect(r.chatwoot.customerMessages).toHaveLength(1);
    const rowsBefore = r.ledger.rows.size;

    const again = await r.call(signed); // Chatwoot re-sends the very same signed request
    await r.gateway.drain();
    expect(again.status).toBe(200);
    expect(again.json["outcome"]).toBe("duplicate_suppressed");
    expect(r.fake.creates, "a second Hermes run was started for an accepted delivery").toHaveLength(1);
    expect(r.chatwoot.customerMessages, "a second reply was sent").toHaveLength(1);
    expect(r.ledger.rows.size).toBe(rowsBefore);
  });

  it("while the first is STILL RUNNING (live lease): 200 duplicate_suppressed, still ONE run and, once it finishes, ONE reply", async () => {
    const r = rig();
    let release: (() => void) | undefined;
    r.fake.onRun = (run: FakeRun) => {
      run.running();
      release = () => run.complete(answer("Yes, we do."));
    };
    const signed = signRequest({ body: body(), deliveryId: DELIVERY });
    expect((await r.call(signed)).status).toBe(200);
    // wait until the run exists and is running
    for (let i = 0; i < 50 && r.fake.creates.length === 0; i += 1) await sleep(10);
    expect(r.fake.creates).toHaveLength(1);

    const again = await r.call(signed);
    expect(again.status).toBe(200);
    expect(again.json["outcome"]).toBe("duplicate_suppressed");
    expect(r.fake.creates).toHaveLength(1);

    release?.();
    await r.gateway.drain();
    expect(r.chatwoot.customerMessages).toHaveLength(1);
    expect(r.fake.creates).toHaveLength(1);
  });

  it("after the first one FAILED terminally: still 200 duplicate_suppressed and no run (a retry of finished work is never invited)", async () => {
    const r = rig();
    completeWith(r.fake, answer("Yes, we do."));
    const signed = signRequest({ body: body(), deliveryId: DELIVERY });
    await r.call(signed);
    await r.gateway.drain();
    for (const row of r.ledger.rows.values()) row.state = "failed"; // the terminal failed state
    const createsBefore = r.fake.creates.length;
    const again = await r.call(signed);
    await r.gateway.drain();
    expect(again.status).toBe(200);
    expect(again.json["outcome"]).toBe("duplicate_suppressed");
    expect(r.fake.creates).toHaveLength(createsBefore);
  });
});

describe("(b) the same delivery id with a DIFFERENT signed body is a 409 and runs nothing", () => {
  it("409 ledger_conflict, no second run, no second reply; the first delivery is untouched", async () => {
    const r = rig();
    completeWith(r.fake, answer("Yes, we do."));
    const first = await r.call(signRequest({ body: body("Do you sell calling plans?"), deliveryId: DELIVERY }));
    expect(first.json["outcome"]).toBe("accepted"); // positive control
    await r.gateway.drain();

    const second = await r.call(signRequest({ body: body("A completely different question"), deliveryId: DELIVERY }));
    await r.gateway.drain();
    expect(second.status).toBe(409);
    expect(second.json["outcome"]).toBe("ledger_conflict");
    expect(r.fake.creates).toHaveLength(1);
    expect(r.chatwoot.customerMessages).toHaveLength(1);
    expect(JSON.stringify(r.fake.creates)).not.toContain("A completely different question");
  });
});

describe("(c) unsigned and badly signed requests are a 401 with no ledger row and no Hermes call", () => {
  it("positive control first: a correctly signed delivery is accepted (one ledger row, one run) in the SAME rig", async () => {
    const r = rig();
    completeWith(r.fake, answer("ok"));
    const res = await r.call(signRequest({ body: body(), deliveryId: DELIVERY }));
    expect(res.status).toBe(200);
    expect(res.json["outcome"]).toBe("accepted");
    await r.gateway.drain();
    expect(r.ledger.rows.size).toBeGreaterThan(0);
    expect(r.fake.creates).toHaveLength(1);
  });

  it.each([
    ["no signature header at all", { signatureHeader: null }],
    ["a wrong signature", { signatureHeader: `sha256=${"0".repeat(64)}` }],
    ["a signature made with another secret", { secret: "x".repeat(32) }],
    ["a stale timestamp (outside the replay window)", { timestamp: Math.floor(Date.now() / 1000) - 3600 }],
  ] as const)("%s: 401, NO ledger row, NO Hermes call, NO reply", async (_name, over) => {
    const r = rig();
    completeWith(r.fake, answer("must never run"));
    const res = await r.call(signRequest({ body: body(), deliveryId: DELIVERY, ...over }));
    await r.gateway.drain();
    expect(res.status).toBe(401);
    expect(res.json["outcome"]).toBe("unauthorized");
    expect(r.ledger.rows.size).toBe(0);
    expect(r.fake.log).toHaveLength(0);
    expect(r.chatwoot.calls).toHaveLength(0);
  });
});

describe("(d) the ONE case where Chatwoot will retry: the delivery could not be durably recorded", () => {
  it("ledger down: 500 ledger_unavailable, NO Hermes call, NO ledger row, NO reply; the retry (same delivery id) is then accepted and runs exactly ONCE", async () => {
    const r = rig();
    completeWith(r.fake, answer("Yes, we do."));
    r.ledger.unavailable = true;
    const signed = signRequest({ body: body(), deliveryId: DELIVERY });
    const down = await r.call(signed);
    await r.gateway.drain();
    expect(down.status).toBe(500);
    expect(down.json["outcome"]).toBe("ledger_unavailable");
    expect(r.fake.log).toHaveLength(0);
    expect(r.chatwoot.calls).toHaveLength(0);
    expect(r.ledger.rows.size).toBe(0);
    expect(r.capture.raw.join("\n")).toContain("ledger_unavailable_on_ack");

    // Chatwoot retries on 500: the store is back
    r.ledger.unavailable = false;
    const retry = await r.call(signed);
    await r.gateway.drain();
    expect(retry.status).toBe(200);
    expect(retry.json["outcome"]).toBe("accepted");
    expect(r.fake.creates).toHaveLength(1);
    expect(r.chatwoot.customerMessages).toHaveLength(1);
  });

  it("STATUS TABLE: across every scenario above the route never answers 429, and 500 appears ONLY for the ledger-down case", async () => {
    const r = rig();
    completeWith(r.fake, answer("ok"));
    const accepted = signRequest({ body: body(), deliveryId: DELIVERY });
    await r.call(accepted); // 200 accepted
    await r.gateway.drain();
    await r.call(accepted); // 200 duplicate
    await r.call(signRequest({ body: body("different"), deliveryId: DELIVERY })); // 409
    await r.call(signRequest({ body: body(), deliveryId: DELIVERY, signatureHeader: null })); // 401
    await r.call(signRequest({ rawBody: "not json", deliveryId: DELIVERY })); // 400 / 401 / 422 family, never 429/500
    // the accepted delivery's duplicates are all 2xx
    expect(r.statuses.slice(0, 2)).toEqual([200, 200]);
    expect(r.statuses[2]).toBe(409);
    expect(r.statuses[3]).toBe(401);
    expect(r.statuses).not.toContain(429);
    expect(r.statuses).not.toContain(500);
    // control: the ONE intended 500 does exist (the harness can produce a 500, so its absence above means something)
    r.ledger.unavailable = true;
    const down = await r.call(signRequest({ body: messageCreatedPayload({ id: 9300, content: "another" }), deliveryId: "00000000-0000-4000-8000-00000000d002" }));
    expect(down.status).toBe(500);
    expect(r.statuses.filter((s) => s === 500)).toHaveLength(1);
  });
});

describe("(a, edge) a redelivery that arrives AFTER the lease expired on an UNFINISHED delivery", () => {
  it("answers 200 (resumed), starts NO second Hermes run (the adapter's own duplicate-invoke guard) and hands the conversation to staff; the first run's late answer is discarded", async () => {
    const r = rig();
    // the first run never finishes on its own: the handler is still waiting on Hermes
    let release: (() => void) | undefined;
    r.fake.onRun = (run: FakeRun) => {
      run.running();
      release = () => run.complete(answer("a late answer that must never reach the customer"));
    };
    const signed = signRequest({ body: body(), deliveryId: DELIVERY });
    expect((await r.call(signed)).status).toBe(200);
    for (let i = 0; i < 50 && r.fake.creates.length === 0; i += 1) await sleep(10);
    expect(r.fake.creates).toHaveLength(1);
    // the lease expires (the owning worker is considered dead) while the row is still unfinished
    for (const row of r.ledger.rows.values()) row.leaseExpiresAt = Date.now() - 1000;

    const again = await r.call(signed);
    // reserve() reports `resumed`, so the webhook route says "accepted" (200) and processes it again...
    expect(again.status).toBe(200);
    expect(again.json["outcome"]).toBe("accepted");
    for (let i = 0; i < 100 && r.capture.withOutcome("hermes_duplicate_invoke").length === 0; i += 1) await sleep(10);
    // ...but the adapter refuses to POST /v1/runs a second time for the same ledger key
    expect(r.capture.withOutcome("hermes_duplicate_invoke").length).toBeGreaterThan(0);
    expect(r.fake.creates, "an expired-lease redelivery started a SECOND Hermes run").toHaveLength(1);

    // the first run now finishes late: its answer is discarded (ownership changed) and nobody is told twice
    release?.();
    await r.gateway.drain();
    expect(r.fake.creates).toHaveLength(1);
    expect(r.chatwoot.customerMessages, "the late answer reached the customer").toHaveLength(0);
    expect(r.chatwoot.privateNotes.length, "exactly ONE escalation to staff").toBe(1);
  });

  it("CONTROL: with the lease still LIVE the same redelivery is the plain duplicate (200 duplicate_suppressed) and nobody is escalated", async () => {
    const r = rig();
    let release: (() => void) | undefined;
    r.fake.onRun = (run: FakeRun) => {
      run.running();
      release = () => run.complete(answer("Yes, we do."));
    };
    const signed = signRequest({ body: body(), deliveryId: DELIVERY });
    await r.call(signed);
    for (let i = 0; i < 50 && r.fake.creates.length === 0; i += 1) await sleep(10);
    const again = await r.call(signed);
    expect(again.json["outcome"]).toBe("duplicate_suppressed");
    release?.();
    await r.gateway.drain();
    expect(r.fake.creates).toHaveLength(1);
    expect(r.chatwoot.customerMessages).toHaveLength(1);
    expect(r.chatwoot.privateNotes).toHaveLength(0);
  });
});