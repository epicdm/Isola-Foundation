/**
 * STEP A (direct Hermes path), commit 3: the HermesDirectRuntime, tested against a FAKE
 * Hermes `/v1/runs` service (test/hermes-fake.ts): an in-process SafeFetch, NO SOCKET.
 *
 * The fake follows lane 59's contract file as VERIFIED by Step B (2026-10-03 06:10-06:12Z):
 * create 202 {run_id}; status running/completed(output)/failed/cancelled; SSE message.delta,
 * reasoning.available, run.completed, then the stream closes itself; /v1/runs IGNORES
 * Idempotency-Key (two keys = two runs); /stop halts model execution (404 on a finished run);
 * a run counts against the cap of 10 until its stream is read to the end.
 * THE FAKE IS NOT EVIDENCE OF INSTALLED BEHAVIOUR (Law 5).
 *
 * Every refusal has its positive twin in the same file (Laws 11, 19, 23, 28).
 */
import { describe, expect, it } from "vitest";

import { createSafeFetch } from "../src/egress.js";
import { hermesSessionLabel } from "../src/hermes-input.js";
import {
  HERMES_OUTCOMES,
  HermesDirectRuntime,
  type HermesAssertionProvider,
  type HermesRuntimeOptions,
} from "../src/hermes-runtime.js";
import type { AgentRuntimeRequest, AgentRuntimeResult } from "../src/runtime.js";
import { CapturingLogger } from "./harness.js";
import { FakeHermes, type FakeRun } from "./hermes-fake.js";

const BEARER = "not-a-real-hermes-key-0000000000000000";
const TENANT = "tenant-acme";
const ACCOUNT = 1;
const INBOX = 7;
const CONVERSATION = 42;
const MESSAGE = "What does the 200 minute plan cost?";
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

let keyCounter = 0;
const nextKey = (): string => `isolagw:${TENANT}|b1|${ACCOUNT}|${INBOX}|delivery:${(keyCounter += 1)}|answer`;

interface CtxOver {
  content?: string;
  history?: unknown;
  scope?: "verified" | "anonymous" | "unresolved" | null;
  conversation?: number;
  omitChatwoot?: boolean;
}

function context(over: CtxOver = {}): Record<string, unknown> {
  const content = over.content ?? MESSAGE;
  const scope = over.scope ?? null;
  return {
    source: "chatwoot",
    ...(scope === null
      ? {}
      : { customerScope: scope === "verified" ? { kind: "verified", customerId: "cust-1", serviceIds: ["svc-1"] } : { kind: scope } }),
    tenantId: TENANT,
    companyId: "company-1",
    ...(over.omitChatwoot === true
      ? {}
      : {
          chatwoot: {
            accountId: ACCOUNT,
            inboxId: INBOX,
            conversationDisplayId: over.conversation ?? CONVERSATION,
            conversationStatus: "pending",
            messageId: 9001,
            customAttributes: {},
          },
        }),
    ...(over.history === null ? {} : { history: over.history === undefined ? [{ role: "customer", content }] : over.history, historyTruncated: false }),
    message: { role: "customer", content },
  };
}

/**
 * The Chatwoot message ids of the history the helper above builds (Codex DH3: the current message is
 * found by ID). The LAST customer turn whose text is the current message gets the webhook's id (9001),
 * its neighbours the ids around it; a history that does not contain the current message gets ids that
 * do not include 9001.
 */
function historyIdsOf(history: unknown, content: string): number[] | undefined {
  if (!Array.isArray(history)) return undefined;
  const turns = history as Array<{ role?: unknown; content?: unknown }>;
  let at = -1;
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    if (turns[i]!.role === "customer" && typeof turns[i]!.content === "string" && (turns[i]!.content as string).trim() === content.trim()) {
      at = i;
      break;
    }
  }
  return turns.map((_t, i) => (at === -1 ? 7000 + i : 9001 + (i - at)));
}

function req(over: CtxOver & { key?: string | null; signal?: AbortSignal; isStillOwned?: () => Promise<boolean> } = {}): AgentRuntimeRequest {
  const built = context(over);
  const ids = historyIdsOf(built["history"], over.content ?? MESSAGE);
  return {
    templateId: "tpl@v1",
    exposure: "PUBLIC",
    agentId: "agent-1",
    runId: "delivery-1",
    context: built,
    ...(ids === undefined ? {} : { historyMessageIds: ids }),
    ...(over.key === null ? {} : { idempotencyKey: over.key ?? nextKey() }),
    ...(over.signal === undefined ? {} : { signal: over.signal }),
    ...(over.isStillOwned === undefined ? {} : { isStillOwned: over.isStillOwned }),
  };
}

function runtimeFor(fake: FakeHermes, over: Partial<HermesRuntimeOptions> = {}): HermesDirectRuntime {
  return new HermesDirectRuntime({
    baseUrl: "http://hermes.test:8642",
    bearer: BEARER,
    safeFetch: fake.fetch,
    runDeadlineMs: 1500,
    pollIntervalMs: 10,
    requestTimeoutMs: 400,
    maxInflight: 4,
    rateLimitBackoffMs: 20,
    streamDrainGraceMs: 200,
    ...over,
  });
}

const answer = (text: string): string => JSON.stringify({ disposition: "answer", text });

/** The "employee": completes shortly after the run starts with `output`. */
function completeWith(fake: FakeHermes, output: string, delayMs = 15): void {
  fake.onRun = (run: FakeRun) => {
    run.running();
    setTimeout(() => {
      run.delta(output.slice(0, 10));
      run.complete(output);
    }, delayMs);
  };
}

async function settle<T>(promise: Promise<T>, guardMs = 5000): Promise<T> {
  const timeout = new Promise<never>((_resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`HUNG: no result within ${guardMs} ms`)), guardMs);
    if (typeof t.unref === "function") t.unref();
  });
  return Promise.race([promise, timeout]);
}

function noText(r: AgentRuntimeResult, outcome: string): void {
  expect(r.outcome).toBe(outcome);
  expect(r.text).toBeNull();
  expect(r.action).toBeNull();
}

// ===========================================================================
// A. The success path and the exact request
// ===========================================================================

describe("a conforming turn", () => {
  it("answer: ONE create with the exact documented request, the envelope's text is the reply, and the stream is read to the end", async () => {
    const fake = new FakeHermes();
    completeWith(fake, `Let me check.\n${answer("The 200 minute plan costs $20.")}`);
    const history = [
      { role: "customer", content: "Hi, do you sell calling plans?" },
      { role: "business", content: "Yes! Ask me about any plan." },
      { role: "customer", content: MESSAGE },
    ];
    const r = await settle(runtimeFor(fake).invoke(req({ history })));
    expect(r).toMatchObject({
      text: "The 200 minute plan costs $20.",
      action: "reply",
      actionUnrecognised: false,
      actionReason: null,
      outcome: "ok",
      completionState: "completed",
    });
    expect(r.correlationId).toBe(`hermes:${[...fake.runs.keys()][0]}`);

    expect(fake.creates).toHaveLength(1);
    const c = fake.creates[0]!;
    expect(c.headers["authorization"]).toBe(`Bearer ${BEARER}`);
    expect(c.headers["content-type"]).toContain("application/json");
    // NOT sent: X-Hermes-Session-Key gives no memory on /v1/runs, and /v1/runs ignores Idempotency-Key.
    expect(c.headers["x-hermes-session-key"]).toBeUndefined();
    expect(c.headers["idempotency-key"]).toBeUndefined();
    const label = hermesSessionLabel({ tenantId: TENANT, accountId: ACCOUNT, inboxId: INBOX, conversationId: CONVERSATION });
    expect(Object.keys(c.body!).sort()).toEqual(["conversation_history", "input", "instructions", "session_id"]);
    expect(c.body!["session_id"]).toBe(label);
    expect(c.body!["input"]).toBe(`Conversation id: ${label}\nIsola assertion: none\n\n${MESSAGE}`);
    expect(c.body!["conversation_history"]).toEqual([
      { role: "user", content: "Hi, do you sell calling plans?" },
      { role: "assistant", content: "Yes! Ask me about any plan." },
    ]);
    expect(String(c.body!["instructions"])).toContain('"disposition"');
    // the current message is in `input` and NOT duplicated in the history
    expect(JSON.stringify(c.body!["conversation_history"])).not.toContain(MESSAGE);

    // the stream was attached once and read to the very end: the run no longer counts against the cap
    expect(fake.streams).toHaveLength(1);
    expect([...fake.runs.values()][0]!.drained).toBe(true);
    expect(fake.counted).toBe(0);
  });

  it("request_human: action request_human, the reason is kept only when it is in the closed set", async () => {
    const fake = new FakeHermes();
    completeWith(fake, JSON.stringify({ disposition: "request_human", text: "I will bring in a colleague.", reason: "explicit_human_request" }));
    const r = await settle(runtimeFor(fake).invoke(req()));
    expect(r).toMatchObject({ text: "I will bring in a colleague.", action: "request_human", actionReason: "explicit_human_request", outcome: "ok" });

    const fake2 = new FakeHermes();
    completeWith(fake2, JSON.stringify({ disposition: "request_human", text: "One moment.", reason: "card_4111111111111111" }));
    const r2 = await settle(runtimeFor(fake2).invoke(req()));
    expect(r2).toMatchObject({ action: "request_human", actionReason: null });
  });

  it("a FIRST message has no history: `conversation_history` is omitted from the body", async () => {
    const fake = new FakeHermes();
    completeWith(fake, answer("Hello!"));
    await settle(runtimeFor(fake).invoke(req()));
    expect("conversation_history" in fake.creates[0]!.body!).toBe(false);
  });

  it("the final text is the status `output`, else the run.completed event's `output`, else the concatenated message.delta chunks", async () => {
    // status output
    let fake = new FakeHermes();
    completeWith(fake, answer("from status"));
    expect((await settle(runtimeFor(fake).invoke(req()))).text).toBe("from status");

    // status output EMPTY, event output present
    fake = new FakeHermes();
    fake.onRun = (run) => {
      run.running();
      setTimeout(() => run.complete(answer("from event"), { statusOutput: false }), 15);
    };
    expect((await settle(runtimeFor(fake).invoke(req()))).text).toBe("from event");

    // both empty: the deltas are concatenated
    fake = new FakeHermes();
    fake.onRun = (run) => {
      run.running();
      setTimeout(() => {
        run.delta('{"disposition":"answer",');
        run.delta('"text":"from deltas"}');
        run.complete("", { statusOutput: false, eventOutput: "" });
      }, 15);
    };
    expect((await settle(runtimeFor(fake).invoke(req()))).text).toBe("from deltas");
  });
});

describe("the Isola assertion line", () => {
  const provider = (calls: unknown[], value: string | null | Error): HermesAssertionProvider => ({
    assertionFor: async (input) => {
      calls.push(input);
      if (value instanceof Error) throw value;
      return value;
    },
  });

  it("by default there is NO assertion: the line says none and nothing is invented", async () => {
    const fake = new FakeHermes();
    completeWith(fake, answer("ok"));
    await settle(runtimeFor(fake).invoke(req({ scope: "verified" })));
    expect(String(fake.creates[0]!.body!["input"])).toContain("Isola assertion: none");
  });

  it("CONTROL: a provider's assertion is carried verbatim, but ONLY for a verified customer scope", async () => {
    const calls: unknown[] = [];
    const fake = new FakeHermes();
    completeWith(fake, answer("ok"));
    await settle(runtimeFor(fake, { assertions: provider(calls, "v1.payload.sig") }).invoke(req({ scope: "verified" })));
    expect(String(fake.creates[0]!.body!["input"])).toContain("Isola assertion: v1.payload.sig");
    expect(calls).toEqual([{ tenantId: TENANT, accountId: ACCOUNT, inboxId: INBOX, conversationId: CONVERSATION, messageId: 9001 }]);

    for (const scope of ["anonymous", "unresolved", null] as const) {
      const calls2: unknown[] = [];
      const fake2 = new FakeHermes();
      completeWith(fake2, answer("ok"));
      await settle(runtimeFor(fake2, { assertions: provider(calls2, "v1.payload.sig") }).invoke(req({ scope })));
      expect(calls2, `the provider was consulted for scope ${String(scope)}`).toEqual([]);
      expect(String(fake2.creates[0]!.body!["input"])).toContain("Isola assertion: none");
    }
  });

  it.each([
    ["throws", new Error("minter down")],
    ["returns a value containing a newline", "v1.a\nb.c"],
    ["returns an over-long value", "v".repeat(3000)],
  ])("a provider that %s is a config defect: nothing is sent", async (_name, value) => {
    const fake = new FakeHermes();
    completeWith(fake, answer("ok"));
    const r = await settle(runtimeFor(fake, { assertions: provider([], value) }).invoke(req({ scope: "verified" })));
    noText(r, HERMES_OUTCOMES.configDefect);
    expect(fake.log).toHaveLength(0);
  });
});

// ===========================================================================
// B. Fail closed: no model text is ever sent
// ===========================================================================

describe("fail closed: any non-conforming end is NO text and exactly one outcome", () => {
  it("a FAILED run", async () => {
    const fake = new FakeHermes();
    fake.onRun = (run) => {
      run.running();
      setTimeout(() => run.fail("provider returned 400"), 15);
    };
    const r = await settle(runtimeFor(fake).invoke(req()));
    noText(r, HERMES_OUTCOMES.runFailed);
    expect(fake.creates).toHaveLength(1);
  });

  it("a run CANCELLED by someone else", async () => {
    const fake = new FakeHermes();
    fake.onRun = (run) => {
      run.running();
      setTimeout(() => run.cancel(), 15);
    };
    noText(await settle(runtimeFor(fake).invoke(req())), HERMES_OUTCOMES.runCancelled);
  });

  it("a run that has vanished (404 on the poll: state lost on a restart) is NOT re-created", async () => {
    const fake = new FakeHermes();
    fake.onRun = (run) => {
      run.running();
      run.lost = true; // the service forgot it
    };
    const r = await settle(runtimeFor(fake).invoke(req()));
    noText(r, HERMES_OUTCOMES.runLost);
    expect(fake.creates, "a lost run must never be re-POSTed").toHaveLength(1);
  });

  it("a stream that closes cleanly WITHOUT a terminal event is an anomaly: no text, no re-POST", async () => {
    const fake = new FakeHermes();
    fake.onRun = (run) => {
      run.running();
      setTimeout(() => run.closeWithoutTerminal(), 15);
    };
    const r = await settle(runtimeFor(fake).invoke(req()));
    noText(r, HERMES_OUTCOMES.streamClosedEarly);
    expect(fake.creates).toHaveLength(1);
  });

  it.each([
    ["plain prose with no envelope", "Sure! The plan costs twenty dollars.", "no_envelope_line"],
    ["an envelope that is not the last line", `${answer("x")}\nThanks!`, "no_envelope_line"],
    ["an unknown disposition", JSON.stringify({ disposition: "reply", text: "x" }), "bad_disposition"],
    ["an empty text", JSON.stringify({ disposition: "answer", text: "  " }), "missing_text"],
  ])("an unparseable envelope (%s): no customer text from the model output, and the parse failure is counted and logged WITHOUT content", async (_name, output, reason) => {
    const fake = new FakeHermes();
    completeWith(fake, output);
    const capture = new CapturingLogger();
    const runtime = runtimeFor(fake, { logger: capture.logger });
    const r = await settle(runtime.invoke(req()));
    noText(r, HERMES_OUTCOMES.envelopeInvalid);
    expect(runtime.stats().envelopeParseFailures).toBe(1);
    const events = capture.lines.filter((l) => l["event"] === "hermes_envelope_parse_failure");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ reason });
    // nothing the model or the customer wrote reaches a log line
    for (const raw of capture.raw) {
      expect(raw).not.toContain(MESSAGE);
      expect(raw).not.toContain("twenty dollars");
      expect(raw).not.toContain(BEARER);
    }
  });

  it("a text over the 2000-unit cap is refused, never truncated", async () => {
    const fake = new FakeHermes();
    completeWith(fake, answer("a".repeat(2001)));
    noText(await settle(runtimeFor(fake).invoke(req())), HERMES_OUTCOMES.envelopeTextTooLong);
    const ok = new FakeHermes();
    completeWith(ok, answer("a".repeat(2000)));
    expect((await settle(runtimeFor(ok).invoke(req()))).text).toBe("a".repeat(2000));
  });

  it("a completed run with EMPTY output everywhere", async () => {
    const fake = new FakeHermes();
    fake.onRun = (run) => {
      run.running();
      setTimeout(() => run.complete("", { statusOutput: false }), 15);
    };
    noText(await settle(runtimeFor(fake).invoke(req())), HERMES_OUTCOMES.envelopeInvalid);
  });
});

describe("the create call: what is a config defect and what is an uncertain create", () => {
  it.each([400, 401, 403, 404])("HTTP %s on the create is a CONFIG DEFECT: exactly one request, no retry, no stream", async (status) => {
    const fake = new FakeHermes();
    fake.createPlan = [status];
    completeWith(fake, answer("never"));
    noText(await settle(runtimeFor(fake).invoke(req())), HERMES_OUTCOMES.configDefect);
    expect(fake.log).toHaveLength(1);
  });

  it("CONTROL: a wrong key really is a 401 from the fake (the defect above is not a harness artefact)", async () => {
    const fake = new FakeHermes();
    completeWith(fake, answer("ok"));
    const wrong = runtimeFor(fake, { bearer: "wrong-key" });
    noText(await settle(wrong.invoke(req())), HERMES_OUTCOMES.configDefect);
    expect(fake.creates).toHaveLength(1);
    expect(fake.runs.size).toBe(0);
  });

  it.each([
    ["a 500", 500],
    ["a connection that dies after the run was created", "drop"],
    ["a 2xx with no run_id", "no_run_id"],
    ["a response body over the byte cap", "big"],
  ] as const)("%s is an UNCERTAIN create: no text, and it is NEVER re-created", async (_name, plan) => {
    const fake = new FakeHermes();
    fake.createPlan = [plan];
    completeWith(fake, answer("never"));
    const r = await settle(runtimeFor(fake).invoke(req()));
    noText(r, HERMES_OUTCOMES.createUncertain);
    expect(fake.creates).toHaveLength(1);
    expect(fake.streams).toHaveLength(0);
  });

  it("a create that never answers ends at the request timeout as an uncertain create (one POST)", async () => {
    const fake = new FakeHermes();
    fake.createPlan = ["hang"];
    const r = await settle(runtimeFor(fake, { requestTimeoutMs: 60 }).invoke(req()));
    noText(r, HERMES_OUTCOMES.createUncertain);
    expect(fake.creates).toHaveLength(1);
  });

  it("a 307 redirect is NEVER followed: the body is not re-sent anywhere (the egress guard refuses it)", async () => {
    const fake = new FakeHermes();
    fake.createPlan = ["redirect"];
    const guarded = createSafeFetch({ allowlist: ["hermes.test"], transport: fake.fetch });
    const r = await settle(runtimeFor(fake, { safeFetch: guarded }).invoke(req()));
    noText(r, HERMES_OUTCOMES.configDefect);
    expect(fake.log).toHaveLength(1);
    expect(fake.log.every((l) => new URL(l.url).hostname === "hermes.test")).toBe(true);
  });

  it("a host that is not on the allowlist is refused before anything is sent", async () => {
    const fake = new FakeHermes();
    const guarded = createSafeFetch({ allowlist: ["somewhere-else.test"], transport: fake.fetch });
    noText(await settle(runtimeFor(fake, { safeFetch: guarded }).invoke(req())), HERMES_OUTCOMES.configDefect);
    expect(fake.log).toHaveLength(0);
  });
});

describe("nothing is sent unless the turn is fully formed", () => {
  it("history ABSENT (no store, or the read failed): no request, no text, escalate", async () => {
    const fake = new FakeHermes();
    completeWith(fake, answer("never"));
    noText(await settle(runtimeFor(fake).invoke(req({ history: null }))), HERMES_OUTCOMES.historyUnavailable);
    expect(fake.log).toHaveLength(0);
  });

  it("history that does not contain the current message: no request; with it present the same call goes out (control)", async () => {
    const fake = new FakeHermes();
    completeWith(fake, answer("ok"));
    noText(
      await settle(runtimeFor(fake).invoke(req({ history: [{ role: "customer", content: "something older" }] }))),
      HERMES_OUTCOMES.historyUnavailable,
    );
    expect(fake.log).toHaveLength(0);
    expect((await settle(runtimeFor(fake).invoke(req()))).outcome).toBe("ok");
  });

  it("a missing conversation identity or a missing ledger key: config defect, no request", async () => {
    const fake = new FakeHermes();
    noText(await settle(runtimeFor(fake).invoke(req({ omitChatwoot: true }))), HERMES_OUTCOMES.configDefect);
    noText(await settle(runtimeFor(fake).invoke(req({ key: null }))), HERMES_OUTCOMES.configDefect);
    expect(fake.log).toHaveLength(0);
  });

  it.each([
    ["userinfo", "http://user:pw@hermes.test:8642"],
    ["a query", "http://hermes.test:8642?x=1"],
    ["a fragment", "http://hermes.test:8642#x"],
    ["an ftp scheme", "ftp://hermes.test:8642"],
    ["no URL at all", "not a url"],
  ])("a base URL with %s is a config defect and nothing is sent", async (_name, baseUrl) => {
    const fake = new FakeHermes();
    noText(await settle(runtimeFor(fake, { baseUrl }).invoke(req())), HERMES_OUTCOMES.configDefect);
    expect(fake.log).toHaveLength(0);
  });
});

// ===========================================================================
// C. NEVER POST /v1/runs twice for one ledger key
// ===========================================================================

describe("duplicate protection: Hermes' /v1/runs ignores Idempotency-Key, so the adapter itself never POSTs twice per ledger key", () => {
  it("the same ledger key invoked twice (a replay): ONE create; the second is refused with no request", async () => {
    const fake = new FakeHermes();
    completeWith(fake, answer("first"));
    const runtime = runtimeFor(fake);
    const key = nextKey();
    const first = await settle(runtime.invoke(req({ key })));
    const second = await settle(runtime.invoke(req({ key })));
    expect(first.text).toBe("first");
    noText(second, HERMES_OUTCOMES.duplicateInvoke);
    expect(fake.creates).toHaveLength(1);
  });

  it("the same key invoked CONCURRENTLY: still one create", async () => {
    const fake = new FakeHermes();
    completeWith(fake, answer("only"), 40);
    const runtime = runtimeFor(fake);
    const key = nextKey();
    const [a, b] = await settle(Promise.all([runtime.invoke(req({ key })), runtime.invoke(req({ key }))]));
    expect([a.outcome, b.outcome].sort()).toEqual([HERMES_OUTCOMES.duplicateInvoke, "ok"].sort());
    expect(fake.creates).toHaveLength(1);
  });

  it("a key whose FIRST attempt failed is still never re-created (a retry that changes the request is a different request)", async () => {
    const fake = new FakeHermes();
    fake.createPlan = [500];
    completeWith(fake, answer("never"));
    const runtime = runtimeFor(fake);
    const key = nextKey();
    noText(await settle(runtime.invoke(req({ key }))), HERMES_OUTCOMES.createUncertain);
    noText(await settle(runtime.invoke(req({ key }))), HERMES_OUTCOMES.duplicateInvoke);
    expect(fake.creates).toHaveLength(1);
  });

  it("CONTROL: two DIFFERENT keys are two runs (the guard is per ledger key, not a global mute)", async () => {
    const fake = new FakeHermes();
    completeWith(fake, answer("x"));
    const runtime = runtimeFor(fake);
    await settle(runtime.invoke(req()));
    await settle(runtime.invoke(req()));
    expect(fake.creates).toHaveLength(2);
  });
});

describe("429 Too many concurrent runs: back off ONCE inside the deadline with the IDENTICAL request, then escalate", () => {
  it("429 then 202: exactly two POSTs with byte-identical bodies, and the turn succeeds", async () => {
    const fake = new FakeHermes();
    fake.createPlan = [429];
    completeWith(fake, answer("after backoff"));
    const r = await settle(runtimeFor(fake).invoke(req()));
    expect(r.text).toBe("after backoff");
    expect(fake.creates).toHaveLength(2);
    expect(JSON.stringify(fake.creates[1]!.body)).toBe(JSON.stringify(fake.creates[0]!.body));
  });

  it("429 twice: rate limited, no text, exactly two POSTs", async () => {
    const fake = new FakeHermes();
    fake.createPlan = [429, 429];
    completeWith(fake, answer("never"));
    noText(await settle(runtimeFor(fake).invoke(req())), HERMES_OUTCOMES.rateLimited);
    expect(fake.creates).toHaveLength(2);
  });

  it("a backoff that would not fit inside the deadline is not slept and not retried", async () => {
    const fake = new FakeHermes();
    fake.createPlan = [429];
    completeWith(fake, answer("never"));
    const r = await settle(runtimeFor(fake, { runDeadlineMs: 80, rateLimitBackoffMs: 5000 }).invoke(req()));
    noText(r, HERMES_OUTCOMES.rateLimited);
    expect(fake.creates).toHaveLength(1);
  });
});

// ===========================================================================
// D. Every run's event stream is read to the end (the cap of 10)
// ===========================================================================

describe("the concurrency cap: a run counts until its stream is READ TO THE END", () => {
  it("SANITY OF THE FAKE: creating runs without reading their streams hits the cap (so the next test is not vacuous)", async () => {
    const fake = new FakeHermes();
    fake.cap = 2;
    const post = (): Promise<Response> =>
      fake.fetch("http://hermes.test:8642/v1/runs", {
        method: "POST",
        headers: { authorization: `Bearer ${fake.bearer}`, "content-type": "application/json" },
        body: JSON.stringify({ input: "x" }),
      });
    expect((await post()).status).toBe(202);
    expect((await post()).status).toBe(202);
    expect((await post()).status).toBe(429);
  });

  it("five sequential turns against a cap of 2 never see a 429, and every run ends drained", async () => {
    const fake = new FakeHermes();
    fake.cap = 2;
    completeWith(fake, answer("ok"));
    const runtime = runtimeFor(fake);
    for (let i = 0; i < 5; i += 1) {
      const r = await settle(runtime.invoke(req({ conversation: 100 + i })));
      expect(r.outcome).toBe("ok");
    }
    expect(fake.creates).toHaveLength(5);
    expect(fake.counted).toBe(0);
    expect(runtime.inflight()).toBe(0);
  });

  it("a stream that BREAKS mid-run falls back to polling and still completes", async () => {
    const fake = new FakeHermes();
    fake.onRun = (run) => {
      run.running();
      setTimeout(() => run.breakStream(), 10);
      setTimeout(() => run.complete(answer("via polling"), { closeStream: false }), 60);
    };
    const r = await settle(runtimeFor(fake).invoke(req()));
    expect(r.text).toBe("via polling");
    expect(runtimeStatsOk(r)).toBe(true);
  });

  it("a stream that never closes after the run finished does not hold the TURN (bounded drain grace); its slot is held only for the service's own sweep window (Codex DH4)", async () => {
    const fake = new FakeHermes();
    fake.onRun = (run) => {
      run.running();
      setTimeout(() => run.complete(answer("done"), { closeStream: false }), 15);
    };
    const capture = new CapturingLogger();
    // changed in the DH4 round: the service still counts an undrained run until its sweep, so the slot is held
    // for `remoteSweepMs` (small here) instead of being released at once; the TURN is still not held.
    const runtime = runtimeFor(fake, { logger: capture.logger, streamDrainGraceMs: 80, remoteSweepMs: 400 });
    const started = Date.now();
    const r = await settle(runtime.invoke(req()));
    expect(r.text).toBe("done");
    expect(Date.now() - started).toBeLessThan(1000);
    expect(runtime.inflight(), "an undrained run's slot is held while the service still counts it").toBe(1);
    await sleep(450);
    expect(runtime.inflight()).toBe(0);
    expect(capture.lines.some((l) => l["event"] === "hermes_stream_not_drained")).toBe(true);
    // the abandoned stream is actually closed (not left open for the rest of the process)
    expect([...fake.runs.values()][0]!.streamCancelled).toBe(true);
  });

  it("an event stream over the byte cap ends the turn: the run is stopped and no text is returned", async () => {
    const fake = new FakeHermes();
    fake.onRun = (run) => {
      run.running();
      setTimeout(() => run.delta("x".repeat(1024 * 1024 + 10)), 10);
    };
    const r = await settle(runtimeFor(fake, { runDeadlineMs: 1000 }).invoke(req()));
    noText(r, HERMES_OUTCOMES.responseTooLarge);
    expect(fake.stops).toHaveLength(1);
  });

  it("a status poll that hangs does not delay a turn whose stream already delivered the end (the stream is primary)", async () => {
    const fake = new FakeHermes();
    fake.pollPlan = ["hang"];
    completeWith(fake, answer("stream first"), 20);
    const started = Date.now();
    const r = await settle(runtimeFor(fake, { requestTimeoutMs: 1500, runDeadlineMs: 4000 }).invoke(req()));
    expect(r.text).toBe("stream first");
    expect(Date.now() - started).toBeLessThan(800);
  });
});

function runtimeStatsOk(r: AgentRuntimeResult): boolean {
  return r.outcome === "ok";
}

// ===========================================================================
// E. Takeover: stop the run AND never send its output
// ===========================================================================

describe("takeover: POST /stop, the run id is remembered as cancelled, and its output is NEVER sent", () => {
  it("ownership lost mid-run: exactly one /stop on that run, no text, outcome ownership_lost", async () => {
    const fake = new FakeHermes();
    fake.onRun = (run) => run.running(); // never finishes on its own
    let polls = 0;
    const r = await settle(
      runtimeFor(fake).invoke(
        req({
          isStillOwned: async () => {
            polls += 1;
            return polls < 3;
          },
        }),
      ),
    );
    noText(r, HERMES_OUTCOMES.ownershipLost);
    const runId = [...fake.runs.keys()][0]!;
    expect(fake.stops).toHaveLength(1);
    expect(fake.stops[0]!.path).toBe(`/v1/runs/${runId}/stop`);
    expect(fake.creates).toHaveLength(1);
  });

  it("the stopped run id is remembered as CANCELLED in the adapter's own state; a run that completed normally is not (control)", async () => {
    const fake = new FakeHermes();
    fake.onRun = (run) => run.running();
    const runtime = runtimeFor(fake);
    await settle(runtime.invoke(req({ isStillOwned: async () => false })));
    const stopped = [...fake.runs.keys()][0]!;
    expect(runtime.isCancelled(stopped)).toBe(true);

    const fake2 = new FakeHermes();
    completeWith(fake2, answer("fine"));
    const runtime2 = runtimeFor(fake2);
    await settle(runtime2.invoke(req()));
    expect(runtime2.isCancelled([...fake2.runs.keys()][0]!)).toBe(false);
    expect(fake2.stops).toHaveLength(0);
  });

  it("CONTROL: while the conversation stays ours the same run is answered and /stop is never called", async () => {
    const fake = new FakeHermes();
    completeWith(fake, answer("fine"), 40);
    const r = await settle(runtimeFor(fake).invoke(req({ isStillOwned: async () => true })));
    expect(r.text).toBe("fine");
    expect(fake.stops).toHaveLength(0);
  });

  it("a run that FINISHED just before the takeover (stop answers 404) is still discarded", async () => {
    const fake = new FakeHermes();
    fake.stopStatus = 404;
    fake.onRun = (run) => {
      run.running();
      run.complete(answer("this must never reach the customer"));
    };
    const r = await settle(runtimeFor(fake).invoke(req({ isStillOwned: async () => false })));
    noText(r, HERMES_OUTCOMES.ownershipLost);
    expect(fake.stops).toHaveLength(1);
  });

  it("ownership flips at the very moment the run completes: the finished output is still discarded (the last look before text leaves the adapter)", async () => {
    const fake = new FakeHermes();
    completeWith(fake, answer("a late answer for a conversation a person now holds"), 25);
    let looks = 0;
    const r = await settle(
      runtimeFor(fake).invoke(
        req({
          isStillOwned: async () => {
            looks += 1;
            return looks === 1; // ours at the first look only
          },
        }),
      ),
    );
    noText(r, HERMES_OUTCOMES.ownershipLost);
    expect(looks).toBeGreaterThanOrEqual(2);
    expect(fake.stops).toHaveLength(1);
  });

  it("ownership flips WHILE the adapter waits for the stream to finish: the last look before text leaves still discards the output", async () => {
    const fake = new FakeHermes();
    let held = true;
    fake.onRun = (run) => {
      run.running();
      setTimeout(() => {
        run.delta(answer("late text from the deltas"));
        run.complete("", { statusOutput: false, eventOutput: "", closeStream: false });
      }, 20);
      setTimeout(() => {
        held = false; // a person takes the conversation just as the stream ends
        run.finishStream();
      }, 140);
    };
    const r = await settle(runtimeFor(fake, { streamDrainGraceMs: 600 }).invoke(req({ isStillOwned: async () => held })));
    noText(r, HERMES_OUTCOMES.ownershipLost);
    expect(fake.stops).toHaveLength(1);
  });

  it("a stop that FAILS (500) changes nothing: still no text, still ownership_lost", async () => {
    const fake = new FakeHermes();
    fake.stopStatus = 500;
    fake.onRun = (run) => run.running();
    const r = await settle(runtimeFor(fake).invoke(req({ isStillOwned: async () => false })));
    noText(r, HERMES_OUTCOMES.ownershipLost);
    expect(fake.stops).toHaveLength(1);
  });

  it("an ownership read that REJECTS means 'could not find out', which is never 'ours': stop and no text", async () => {
    const fake = new FakeHermes();
    fake.onRun = (run) => run.running();
    const r = await settle(
      runtimeFor(fake).invoke(
        req({
          isStillOwned: async () => {
            throw new Error("ownership store down");
          },
        }),
      ),
    );
    noText(r, HERMES_OUTCOMES.ownershipLost);
    expect(fake.stops).toHaveLength(1);
  });

  it("a status object for a DIFFERENT run id is never accepted (the result is only for the run THIS turn created)", async () => {
    const fake = new FakeHermes();
    fake.statusRunIdOverride = "run_ffffffffffffffffffffffffffffffff";
    completeWith(fake, answer("someone else's answer"));
    noText(await settle(runtimeFor(fake).invoke(req())), HERMES_OUTCOMES.runMismatch);
  });

  it("events carrying another run id are ignored: only this run's terminal event counts", async () => {
    const fake = new FakeHermes();
    fake.onRun = (run) => {
      run.running();
      setTimeout(() => {
        run.push(`data: ${JSON.stringify({ event: "run.completed", run_id: "run_other", timestamp: 1, output: answer("WRONG RUN") })}\n\n`);
        run.complete(answer("right run"));
      }, 15);
    };
    const r = await settle(runtimeFor(fake).invoke(req()));
    expect(r.text).toBe("right run");
  });
});

// ===========================================================================
// F. Deadline, abort and byte caps
// ===========================================================================

describe("one absolute deadline for the whole turn", () => {
  it("a run that never finishes: at the deadline the run is stopped and the turn ends with model_timeout and no text", async () => {
    const fake = new FakeHermes();
    fake.onRun = (run) => run.running();
    const started = Date.now();
    const r = await settle(runtimeFor(fake, { runDeadlineMs: 150 }).invoke(req()));
    noText(r, HERMES_OUTCOMES.timeout);
    expect(Date.now() - started).toBeLessThan(1500);
    expect(fake.stops).toHaveLength(1);
  });

  it("the turn signal aborting mid-run ends the turn promptly: no further polls or streams are started after it", async () => {
    const fake = new FakeHermes();
    fake.onRun = (run) => run.running();
    const turn = new AbortController();
    const pending = runtimeFor(fake, { runDeadlineMs: 5000 }).invoke(req({ signal: turn.signal }));
    await sleep(80);
    const abortedAt = Date.now();
    turn.abort();
    const r = await settle(pending);
    noText(r, HERMES_OUTCOMES.timeout);
    expect(fake.polls.filter((p) => p.at > abortedAt + 5)).toHaveLength(0);
    expect(fake.streams.filter((p) => p.at > abortedAt + 5)).toHaveLength(0);
    expect(fake.creates).toHaveLength(1);
    // the one best-effort stop (a cancellation, not a dispatch) still goes out: a spent turn must not leave a model call running
    expect(fake.stops).toHaveLength(1);
  });

  it("a signal that is ALREADY aborted sends nothing at all", async () => {
    const fake = new FakeHermes();
    const turn = new AbortController();
    turn.abort();
    noText(await settle(runtimeFor(fake).invoke(req({ signal: turn.signal }))), HERMES_OUTCOMES.timeout);
    expect(fake.log).toHaveLength(0);
  });

  it("a status poll that hangs ends at the request timeout and is retried as weather", async () => {
    const fake = new FakeHermes();
    fake.pollPlan = ["hang"];
    // the stream closes WITHOUT a terminal event, so only a poll can finish this turn
    fake.onRun = (run) => {
      run.running();
      setTimeout(() => {
        run.status = "completed";
        run.output = answer("after a hung poll");
      }, 20);
    };
    const r = await settle(runtimeFor(fake, { requestTimeoutMs: 60 }).invoke(req()));
    expect(r.text).toBe("after a hung poll");
    expect(fake.polls.length).toBeGreaterThanOrEqual(2);
  });

  it("a status body over the byte cap is a config defect: the run is stopped and no text is returned", async () => {
    const fake = new FakeHermes();
    fake.pollPlan = ["big"];
    fake.onRun = (run) => run.running();
    const r = await settle(runtimeFor(fake, { runDeadlineMs: 400 }).invoke(req()));
    noText(r, HERMES_OUTCOMES.responseTooLarge);
    expect(fake.stops).toHaveLength(1);
  });

  it("a poll 4xx other than 404 is a config defect: one poll, no retry loop", async () => {
    const fake = new FakeHermes();
    fake.pollPlan = [403];
    fake.onRun = (run) => run.running();
    const r = await settle(runtimeFor(fake, { runDeadlineMs: 400 }).invoke(req()));
    noText(r, HERMES_OUTCOMES.configDefect);
    expect(fake.polls).toHaveLength(1);
  });
});

// ===========================================================================
// G. Concurrency limits
// ===========================================================================

describe("concurrency: one run at a time per conversation, a global cap below Hermes' 10", () => {
  it("two turns for the SAME conversation are serialised: the second run is created only after the first finished", async () => {
    const fake = new FakeHermes();
    completeWith(fake, answer("ok"), 90);
    const runtime = runtimeFor(fake);
    const [a, b] = await settle(Promise.all([runtime.invoke(req()), runtime.invoke(req())]));
    expect(a.outcome).toBe("ok");
    expect(b.outcome).toBe("ok");
    expect(fake.creates).toHaveLength(2);
    expect(fake.creates[1]!.at - fake.creates[0]!.at).toBeGreaterThanOrEqual(80);
  });

  it("CONTROL: turns for DIFFERENT conversations run in parallel", async () => {
    const fake = new FakeHermes();
    completeWith(fake, answer("ok"), 90);
    const runtime = runtimeFor(fake);
    await settle(Promise.all([runtime.invoke(req({ conversation: 1 })), runtime.invoke(req({ conversation: 2 }))]));
    expect(fake.creates).toHaveLength(2);
    expect(Math.abs(fake.creates[1]!.at - fake.creates[0]!.at)).toBeLessThan(60);
  });

  it("the global cap: with maxInflight 2, a third concurrent turn waits for a free slot", async () => {
    const fake = new FakeHermes();
    completeWith(fake, answer("ok"), 90);
    const runtime = runtimeFor(fake, { maxInflight: 2 });
    const rs = await settle(Promise.all([1, 2, 3].map((c) => runtime.invoke(req({ conversation: c })))));
    expect(rs.map((r) => r.outcome)).toEqual(["ok", "ok", "ok"]);
    const at = fake.creates.map((c) => c.at).sort((x, y) => x - y);
    expect(at[2]! - at[0]!).toBeGreaterThanOrEqual(80);
  });

  it("a wait for a slot or for the conversation that outlasts the deadline is 'busy': no text and NO POST", async () => {
    const fake = new FakeHermes();
    fake.onRun = (run) => run.running(); // the first turn holds its slot until the deadline
    const runtime = runtimeFor(fake, { maxInflight: 1, runDeadlineMs: 120 });
    const [a, b] = await settle(Promise.all([runtime.invoke(req({ conversation: 1 })), runtime.invoke(req({ conversation: 2 }))]));
    noText(a, HERMES_OUTCOMES.timeout);
    noText(b, HERMES_OUTCOMES.busy);
    expect(fake.creates).toHaveLength(1);

    const fake2 = new FakeHermes();
    fake2.onRun = (run) => run.running();
    const runtime2 = runtimeFor(fake2, { runDeadlineMs: 120 });
    const [c, d] = await settle(Promise.all([runtime2.invoke(req()), runtime2.invoke(req())]));
    noText(c, HERMES_OUTCOMES.timeout);
    noText(d, HERMES_OUTCOMES.busy);
    expect(fake2.creates).toHaveLength(1);
  });
});

// ===========================================================================
// H. Observability and secrets
// ===========================================================================

describe("instrumentation: the demo can report the parse-failure rate, and no secret or content is ever logged", () => {
  it("stats count turns, answers, handovers, parse failures and failures by outcome", async () => {
    const fake = new FakeHermes();
    const runtime = runtimeFor(fake);
    completeWith(fake, answer("a"));
    await settle(runtime.invoke(req()));
    completeWith(fake, JSON.stringify({ disposition: "request_human", text: "h" }));
    await settle(runtime.invoke(req()));
    completeWith(fake, "prose only");
    await settle(runtime.invoke(req()));
    fake.createPlan = [500];
    await settle(runtime.invoke(req()));
    expect(runtime.stats()).toEqual({
      turns: 4,
      answers: 1,
      requestHuman: 1,
      envelopeParseFailures: 1,
      failuresByOutcome: { [HERMES_OUTCOMES.envelopeInvalid]: 1, [HERMES_OUTCOMES.createUncertain]: 1 },
    });
  });

  it("one hermes_turn line per turn with the outcome, and the bearer, the message and the model output appear in NO line", async () => {
    const fake = new FakeHermes();
    completeWith(fake, answer("SECRET-MODEL-OUTPUT-TEXT"));
    const capture = new CapturingLogger();
    await settle(runtimeFor(fake, { logger: capture.logger }).invoke(req()));
    const turns = capture.lines.filter((l) => l["event"] === "hermes_turn");
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ outcome: "ok" });
    const everything = capture.raw.join("\n");
    expect(everything).not.toContain(BEARER);
    expect(everything).not.toContain(MESSAGE);
    expect(everything).not.toContain("SECRET-MODEL-OUTPUT-TEXT");
  });

  it("a logger that THROWS never costs the customer their turn", async () => {
    const fake = new FakeHermes();
    completeWith(fake, answer("still answered"));
    const throwing = {
      log: () => {
        throw new Error("sink down");
      },
      info: () => {
        throw new Error("sink down");
      },
      warn: () => {
        throw new Error("sink down");
      },
      error: () => {
        throw new Error("sink down");
      },
    };
    const r = await settle(runtimeFor(fake, { logger: throwing }).invoke(req()));
    expect(r.text).toBe("still answered");
  });

  it("the bearer travels only in the Authorization header: never in a URL or a body", async () => {
    const fake = new FakeHermes();
    completeWith(fake, answer("ok"));
    await settle(runtimeFor(fake).invoke(req()));
    for (const l of fake.log) {
      expect(l.url).not.toContain(BEARER);
      expect(JSON.stringify(l.body)).not.toContain(BEARER);
      expect(l.headers["authorization"]).toBe(`Bearer ${BEARER}`);
    }
  });
});
