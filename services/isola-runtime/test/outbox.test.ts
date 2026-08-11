/**
 * The cost-event outbox: retry with bounded backoff, reconcile on startup, and
 * an honest account of undelivered spend.
 */
import { describe, expect, it } from "vitest";

import { PaperclipApiError } from "../src/errors.js";
import {
  DEFAULT_BASE_BACKOFF_MS,
  DEFAULT_MAX_BACKOFF_MS,
  backoffMs,
  dueEntries,
  flushOutbox,
  outboxKey,
  pendingSpend,
  pruneDelivered,
  reconcileOutbox,
} from "../src/outbox.js";
import { InMemoryStateStore, type OutboxEntry, type RuntimeState } from "../src/state.js";
import { CapturingLogger, StubPaperclipApi } from "./harness.js";

function entry(overrides: Partial<OutboxEntry> = {}): OutboxEntry {
  const runId = overrides.runId ?? "run-1";
  const key = overrides.key ?? outboxKey("company-1", "agent-1", runId);
  return {
    key,
    companyId: "company-1",
    agentId: "agent-1",
    runId,
    exposure: "INTERNAL",
    event: {
      agentId: "agent-1",
      heartbeatRunId: runId,
      billingCode: "provider-rates@v1",
      provider: "deepseek",
      biller: "deepseek",
      billingType: "metered_api",
      model: "deepseek-chat",
      inputTokens: 1000,
      cachedInputTokens: 0,
      outputTokens: 300,
      costCents: 3,
      occurredAt: new Date(1000).toISOString(),
    },
    costKind: "actual",
    state: "pending",
    attempts: 0,
    createdAtMs: 1000,
    lastAttemptMs: null,
    nextAttemptMs: 1000,
    lastError: null,
    deliveredAtMs: null,
    ...overrides,
  };
}

async function seed(entries: OutboxEntry[]): Promise<InMemoryStateStore> {
  const store = new InMemoryStateStore();
  await store.transact((draft: RuntimeState) => {
    for (const e of entries) draft.outbox[e.key] = e;
  });
  return store;
}

const RETRYABLE = new PaperclipApiError("returned HTTP 503", 503, true);
const PERMANENT = new PaperclipApiError("returned HTTP 403", 403, false);

function harness(store: InMemoryStateStore, api: StubPaperclipApi, clock: { ms: number }) {
  const logger = new CapturingLogger();
  return {
    logger,
    flush: (reason = "test") =>
      flushOutbox({
        store,
        api,
        apiKeyFor: () => "agent-key",
        now: () => clock.ms,
        logger: logger.logger,
        reason,
      }),
  };
}

describe("backoff schedule", () => {
  it("is exponential and capped", () => {
    expect(backoffMs(0)).toBe(0);
    expect(backoffMs(1)).toBe(DEFAULT_BASE_BACKOFF_MS);
    expect(backoffMs(2)).toBe(500);
    expect(backoffMs(3)).toBe(1000);
    expect(backoffMs(30)).toBe(DEFAULT_MAX_BACKOFF_MS);
    expect(backoffMs(5, 100, 300)).toBe(300);
  });
});

describe("undelivered spend accounting", () => {
  it("counts pending and failed, never delivered", async () => {
    const store = await seed([
      entry({ runId: "a", createdAtMs: 1000 }),
      entry({ runId: "b", state: "failed", createdAtMs: 500 }),
      entry({ runId: "c", state: "delivered", deliveredAtMs: 900, createdAtMs: 100 }),
    ]);
    const spend = pendingSpend(await store.read(), 2000);
    expect(spend.entries).toBe(2);
    expect(spend.cents).toBe(6);
    expect(spend.failed).toBe(1);
    expect(spend.oldestAgeMs).toBe(1500);
  });

  it("is zero when everything is delivered", async () => {
    const store = await seed([entry({ state: "delivered", deliveredAtMs: 1 })]);
    const spend = pendingSpend(await store.read(), 2000);
    expect(spend).toEqual({ entries: 0, cents: 0, failed: 0, oldestAgeMs: 0 });
  });
});

describe("flushOutbox", () => {
  it("delivers a pending entry and marks it delivered exactly once", async () => {
    const store = await seed([entry()]);
    const api = new StubPaperclipApi();
    const clock = { ms: 2000 };
    const h = harness(store, api, clock);

    const first = await h.flush();
    expect(first).toEqual({ attempted: 1, delivered: 1, deferred: 0, failed: 0 });
    expect(api.costEvents).toHaveLength(1);
    expect(api.costEvents[0]!.costCents).toBe(3);
    // The employee's own agent key and the run-id header are both present.
    const call = api.calls.find((c) => c.kind === "cost_event")!;
    expect(call.apiKey).toBe("agent-key");
    expect(call.runId).toBe("run-1");

    // A second flush must not re-deliver.
    const second = await h.flush();
    expect(second.attempted).toBe(0);
    expect(api.costEvents).toHaveLength(1);
  });

  it("retries a transient failure on the next flush and then succeeds", async () => {
    const store = await seed([entry()]);
    const api = new StubPaperclipApi();
    api.costEventFailures = [RETRYABLE];
    const clock = { ms: 2000 };
    const h = harness(store, api, clock);

    const first = await h.flush();
    expect(first).toEqual({ attempted: 1, delivered: 0, deferred: 1, failed: 0 });
    let state = await store.read();
    expect(state.outbox[outboxKey("company-1", "agent-1", "run-1")]!.state).toBe("pending");
    expect(state.outbox[outboxKey("company-1", "agent-1", "run-1")]!.attempts).toBe(1);

    // Still inside the backoff window: not due, so nothing is attempted.
    clock.ms = 2000 + DEFAULT_BASE_BACKOFF_MS - 1;
    expect((await h.flush()).attempted).toBe(0);

    // Past the backoff: it retries and lands.
    clock.ms = 2000 + DEFAULT_BASE_BACKOFF_MS;
    const third = await h.flush();
    expect(third).toEqual({ attempted: 1, delivered: 1, deferred: 0, failed: 0 });
    state = await store.read();
    expect(state.outbox[outboxKey("company-1", "agent-1", "run-1")]!.state).toBe("delivered");
    expect(api.costEvents).toHaveLength(2); // two attempts, one accepted
  });

  it("gives up immediately on a permanent rejection rather than spinning", async () => {
    const store = await seed([entry()]);
    const api = new StubPaperclipApi();
    api.costEventFailures = [PERMANENT];
    const clock = { ms: 2000 };
    const h = harness(store, api, clock);

    const summary = await h.flush();
    expect(summary).toEqual({ attempted: 1, delivered: 0, deferred: 0, failed: 1 });
    const state = await store.read();
    const live = state.outbox[outboxKey("company-1", "agent-1", "run-1")]!;
    expect(live.state).toBe("failed");
    expect(live.lastError).toContain("403");
    // Failed spend is still undelivered spend — it must keep failing closed.
    expect(pendingSpend(state, clock.ms).cents).toBe(3);
  });

  it("stops retrying after the attempt ceiling", async () => {
    const store = await seed([entry()]);
    const api = new StubPaperclipApi();
    api.costEventFailures = [RETRYABLE, RETRYABLE, RETRYABLE];
    const clock = { ms: 2000 };
    const logger = new CapturingLogger();
    const flush = () =>
      flushOutbox({
        store,
        api,
        apiKeyFor: () => "agent-key",
        now: () => clock.ms,
        logger: logger.logger,
        maxAttempts: 2,
        reason: "test",
      });

    await flush();
    clock.ms += 10_000;
    const second = await flush();
    expect(second.failed).toBe(1);
    const state = await store.read();
    expect(state.outbox[outboxKey("company-1", "agent-1", "run-1")]!.state).toBe("failed");
  });

  it("fails an entry whose exposure has no agent key rather than dropping it", async () => {
    const store = await seed([entry({ exposure: "PUBLIC" })]);
    const api = new StubPaperclipApi();
    const logger = new CapturingLogger();
    const summary = await flushOutbox({
      store,
      api,
      apiKeyFor: () => null,
      now: () => 2000,
      logger: logger.logger,
      reason: "test",
    });
    expect(summary.failed).toBe(1);
    expect(api.costEvents).toHaveLength(0);
    expect(pendingSpend(await store.read(), 2000).cents).toBe(3);
  });

  it("does nothing at all when there is no Paperclip client", async () => {
    const store = await seed([entry()]);
    const logger = new CapturingLogger();
    const summary = await flushOutbox({
      store,
      api: null,
      apiKeyFor: () => "k",
      now: () => 2000,
      logger: logger.logger,
      reason: "test",
    });
    expect(summary.attempted).toBe(0);
    expect(pendingSpend(await store.read(), 2000).entries).toBe(1);
  });

  it("leases claimed entries so a concurrent flush cannot double-deliver", async () => {
    const store = await seed([entry({ runId: "a" }), entry({ runId: "b" })]);
    const api = new StubPaperclipApi();
    const clock = { ms: 2000 };
    const h = harness(store, api, clock);
    const [first, second] = await Promise.all([h.flush(), h.flush()]);
    expect(first.attempted + second.attempted).toBe(2);
    expect(api.costEvents).toHaveLength(2);
    const keys = api.costEvents.map((e) => e.heartbeatRunId).sort();
    expect(keys).toEqual(["a", "b"]);
  });

  it("prunes delivered entries once they are older than the retention window", async () => {
    const store = await seed([
      entry({ runId: "old", state: "delivered", deliveredAtMs: 1000 }),
      entry({ runId: "new", state: "delivered", deliveredAtMs: 9000 }),
    ]);
    await store.transact((draft) => {
      const removed = pruneDelivered(draft, 10_000, 5000);
      expect(removed).toBe(1);
    });
    const state = await store.read();
    expect(Object.keys(state.outbox)).toEqual([outboxKey("company-1", "agent-1", "new")]);
  });

  it("only picks up entries whose backoff has elapsed", async () => {
    const store = await seed([
      entry({ runId: "due", nextAttemptMs: 1000 }),
      entry({ runId: "later", nextAttemptMs: 9000 }),
    ]);
    const due = dueEntries(await store.read(), 2000, 10);
    expect(due.map((e) => e.runId)).toEqual(["due"]);
  });
});

describe("reconcileOutbox — the startup path", () => {
  it("re-delivers everything still pending, ignoring the stale backoff clock", async () => {
    const store = await seed([
      entry({ runId: "a", attempts: 3, nextAttemptMs: 10_000_000 }),
      entry({ runId: "b", state: "delivered", deliveredAtMs: 500 }),
    ]);
    const api = new StubPaperclipApi();
    const logger = new CapturingLogger();

    const summary = await reconcileOutbox({
      store,
      api,
      apiKeyFor: () => "agent-key",
      now: () => 2000,
      logger: logger.logger,
    });

    expect(summary.delivered).toBe(1);
    expect(api.costEvents.map((e) => e.heartbeatRunId)).toEqual(["a"]);
    expect(logger.withOutcome("reconcile_complete")).toHaveLength(1);
    const state = await store.read();
    expect(state.outbox[outboxKey("company-1", "agent-1", "a")]!.state).toBe("delivered");
  });

  it("clears stale in-flight claims and reservations but keeps completed records", async () => {
    const store = new InMemoryStateStore();
    await store.transact((draft) => {
      draft.idempotency["stale"] = {
        key: "stale",
        state: "in_flight",
        companyId: "c",
        agentId: "a",
        runId: "r1",
        issueId: null,
        createdAtMs: 1,
        completedAtMs: null,
        result: null,
      };
      draft.idempotency["done"] = {
        key: "done",
        state: "complete",
        companyId: "c",
        agentId: "a",
        runId: "r2",
        issueId: null,
        createdAtMs: 1,
        completedAtMs: 2,
        result: {
          httpStatus: 200,
          outcome: "ok",
          recorded: true,
          recorderError: null,
          transitioned: true,
          transitionStatus: "in_review",
          costEventKey: null,
          costKind: "actual",
          accruedMicrocents: 0,
          answerText: null,
          completionState: "completed",
          usage: null,
        },
      };
      draft.reservations["res"] = {
        id: "res",
        companyId: "c",
        agentId: "a",
        microcents: 1000,
        createdAtMs: 1,
        expiresAtMs: 999_999_999,
      };
    });

    const logger = new CapturingLogger();
    await reconcileOutbox({
      store,
      api: new StubPaperclipApi(),
      apiKeyFor: () => "k",
      now: () => 2000,
      logger: logger.logger,
    });

    const state = await store.read();
    // A run that died mid-flight must not block its own retry forever...
    expect(state.idempotency["stale"]).toBeUndefined();
    // ...but a completed run must still suppress a replay after a restart.
    expect(state.idempotency["done"]).toBeDefined();
    // Reservations belonged to a process that no longer exists.
    expect(state.reservations).toEqual({});
  });
});
