/**
 * The state store. Both backends are driven by the same tests wherever the
 * behaviour should be identical, because the whole point of the interface is
 * that the runtime cannot tell them apart.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { emptyAccumulator } from "../src/money.js";
import {
  DEFAULT_STATE_DIR,
  FileStateStore,
  InMemoryStateStore,
  STATE_FILE_NAME,
  StateStoreError,
  createStateStore,
  emptyState,
  resolveStateFile,
  sanitiseState,
  type StateStore,
} from "../src/state.js";

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "isola-runtime-state-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

describe("path containment", () => {
  it("builds the state file inside the configured directory", () => {
    const dir = tempDir();
    expect(resolveStateFile(dir)).toBe(join(dir, STATE_FILE_NAME));
  });

  it("refuses a file name that would escape the directory", () => {
    const dir = tempDir();
    for (const name of ["../escape.json", "..", "sub/state.json", "a\\b.json", "..\\x"]) {
      expect(() => resolveStateFile(dir, name)).toThrow(StateStoreError);
    }
  });

  it("refuses an empty directory", () => {
    expect(() => resolveStateFile("   ")).toThrow(StateStoreError);
  });

  it("the documented default is the persistent volume, not /tmp", () => {
    // A live test proved /tmp loses the idempotency records and the sub-cent
    // carry whenever the container is replaced. The default now points at the
    // mounted volume; RUNTIME_STATE_DIR still overrides it.
    expect(DEFAULT_STATE_DIR).toBe("/data/isola-runtime-state");
    expect(DEFAULT_STATE_DIR.startsWith("/tmp")).toBe(false);
  });
});

describe.each([
  ["memory", (): StateStore => new InMemoryStateStore()],
  ["file", (): StateStore => new FileStateStore({ dir: tempDir() })],
] as const)("%s store", (_kind, build) => {
  it("starts empty", async () => {
    const store = build();
    const state = await store.read();
    expect(state).toEqual(emptyState());
  });

  it("commits a transaction and makes it visible to the next read", async () => {
    const store = build();
    await store.transact((draft) => {
      draft.accumulators["a"] = { ...emptyAccumulator(), microcents: 42 };
    });
    const state = await store.read();
    expect(state.accumulators["a"]!.microcents).toBe(42);
  });

  it("discards a transaction that throws", async () => {
    const store = build();
    await store.transact((draft) => {
      draft.accumulators["a"] = { ...emptyAccumulator(), microcents: 1 };
    });
    await expect(
      store.transact((draft) => {
        draft.accumulators["a"] = { ...emptyAccumulator(), microcents: 999 };
        throw new Error("nope");
      }),
    ).rejects.toThrow("nope");
    const state = await store.read();
    expect(state.accumulators["a"]!.microcents).toBe(1);
  });

  it("serializes concurrent read-modify-write so no increment is lost", async () => {
    // This is the property the reservation ledger depends on: an interleaving
    // that read the same value twice would let two runs claim one slot.
    const store = build();
    await Promise.all(
      Array.from({ length: 50 }, () =>
        store.transact(async (draft) => {
          const current = draft.accumulators["counter"] ?? emptyAccumulator();
          // Yield inside the transaction: a non-serialized store would now
          // interleave and lose writes.
          await Promise.resolve();
          draft.accumulators["counter"] = { ...current, microcents: current.microcents + 1 };
        }),
      ),
    );
    const state = await store.read();
    expect(state.accumulators["counter"]!.microcents).toBe(50);
  });

  it("hands out snapshots, not the live draft", async () => {
    const store = build();
    await store.transact((draft) => {
      draft.accumulators["a"] = { ...emptyAccumulator(), microcents: 5 };
    });
    const snapshot = await store.read();
    snapshot.accumulators["a"]!.microcents = 1_000_000;
    const again = await store.read();
    expect(again.accumulators["a"]!.microcents).toBe(5);
  });
});

describe("file store durability", () => {
  it("persists across a fresh store on the same directory — the restart case", async () => {
    const dir = tempDir();
    const first = new FileStateStore({ dir });
    await first.transact((draft) => {
      draft.accumulators["company|agent|actual"] = {
        ...emptyAccumulator(),
        microcents: 777_777,
      };
      draft.idempotency["k"] = {
        key: "k",
        state: "complete",
        companyId: "c",
        agentId: "a",
        runId: "r",
        issueId: "i",
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
          accruedMicrocents: 10,
          answerText: "the persisted answer",
          completionState: "completed",
          usage: {
            inputTokens: 12,
            cachedInputTokens: 0,
            outputTokens: 34,
            model: "deepseek-chat",
            provider: "deepseek",
            durationMs: 55,
          },
        },
      };
    });

    const second = new FileStateStore({ dir });
    const state = await second.read();
    expect(state.accumulators["company|agent|actual"]!.microcents).toBe(777_777);
    expect(state.idempotency["k"]!.result!.transitionStatus).toBe("in_review");
    // The answer survives the restart: without it a replayed inline request
    // would have to call the provider again to answer the same question.
    expect(state.idempotency["k"]!.result!.answerText).toBe("the persisted answer");
    expect(state.idempotency["k"]!.result!.completionState).toBe("completed");
    expect(state.idempotency["k"]!.result!.usage!.outputTokens).toBe(34);
  });

  it("writes only inside the configured directory, and nothing else", async () => {
    const dir = tempDir();
    const store = new FileStateStore({ dir });
    await store.transact((draft) => {
      draft.accumulators["a"] = emptyAccumulator();
    });
    expect(store.path).toBe(join(dir, STATE_FILE_NAME));
    expect(store.path.startsWith(dir + sep)).toBe(true);
    // The atomic temp file is renamed away, so exactly one file is left.
    expect(readdirSync(dir).sort()).toEqual([STATE_FILE_NAME]);
    expect(existsSync(join(dir, `${STATE_FILE_NAME}.tmp`))).toBe(false);
  });

  it("survives a corrupt state file rather than crashing the runtime", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, STATE_FILE_NAME), "{ this is not json", "utf8");
    const warnings: string[] = [];
    const store = new FileStateStore({ dir, onWarn: (d) => warnings.push(d) });
    const state = await store.read();
    expect(state).toEqual(emptyState());
    expect(warnings.join(" ")).toContain("unreadable JSON");
    // And it is usable afterwards.
    await store.transact((draft) => {
      draft.accumulators["a"] = { ...emptyAccumulator(), microcents: 3 };
    });
    expect(JSON.parse(readFileSync(store.path, "utf8"))).toMatchObject({
      accumulators: { a: { microcents: 3 } },
    });
  });

  it("drops records it cannot read without dropping the ones it can", () => {
    const state = sanitiseState({
      version: 1,
      idempotency: { good: { key: "good", state: "complete" }, bad: 42 },
      outbox: {
        good: { key: "good", event: { agentId: "a", costCents: 3 }, state: "pending" },
        noEvent: { key: "noEvent" },
      },
      accumulators: { a: { microcents: -5 } },
      reservations: { r: { id: "r", microcents: 10 } },
      budgets: { b: { agentId: "b", budgetMonthlyCents: 100, spentMonthlyCents: 4 } },
      alerts: { z: { agentId: "z", alertedPct: 80 } },
    });
    expect(Object.keys(state.idempotency)).toEqual(["good"]);
    expect(Object.keys(state.outbox)).toEqual(["good"]);
    // A negative accumulator would silently credit spend back; clamp it.
    expect(state.accumulators["a"]!.microcents).toBe(0);
    expect(state.reservations["r"]!.microcents).toBe(10);
    expect(state.budgets["b"]!.budgetMonthlyCents).toBe(100);
    // A stored row from before `status` existed reads back as null, not a crash.
    expect(state.budgets["b"]!.status).toBeNull();
    expect(state.alerts["z"]!.alertedPct).toBe(80);
  });

  it("createStateStore falls back to memory when the directory is unusable", () => {
    const warnings: string[] = [];
    const store = createStateStore({
      backend: "file",
      dir: "   ",
      onWarn: (d) => warnings.push(d),
    });
    expect(store.kind).toBe("memory");
    expect(warnings.length).toBeGreaterThan(0);
  });

  it("createStateStore honours the memory backend without touching disk", () => {
    const store = createStateStore({ backend: "memory", dir: "/nonexistent/never/used" });
    expect(store.kind).toBe("memory");
    expect(existsSync("/nonexistent/never/used")).toBe(false);
  });
});

/**
 * The volume is now the durability story, so the failure modes of a mount are
 * the ones that matter: absent, and present-but-unwritable. Neither may take
 * the runtime down, and neither may be reported as durable.
 */
describe("the mounted volume, and what happens when it is not usable", () => {
  it("creates the state directory when it does not exist yet — a fresh volume", () => {
    const dir = join(tempDir(), "isola-runtime-state");
    expect(existsSync(dir)).toBe(false);

    const warnings: string[] = [];
    const store = createStateStore({ backend: "file", dir, onWarn: (d) => warnings.push(d) });

    expect(store.kind).toBe("file");
    expect(existsSync(dir)).toBe(true);
    // The writability probe has already proved the mount takes a write, at boot,
    // rather than discovering it on the first settled cost event.
    expect(existsSync(join(dir, STATE_FILE_NAME))).toBe(true);
    expect(warnings).toEqual([]);
  });

  it("creates a nested path in one go", () => {
    const dir = join(tempDir(), "data", "isola-runtime-state");
    const store = createStateStore({ backend: "file", dir });
    expect(store.kind).toBe("file");
    expect(existsSync(join(dir, STATE_FILE_NAME))).toBe(true);
  });

  it("falls back to memory, loudly, when the directory cannot be created", () => {
    // A file where the directory should be: exactly what a mis-specified mount
    // looks like from inside the container.
    const parent = tempDir();
    const dir = join(parent, "not-a-directory");
    writeFileSync(dir, "in the way", "utf8");

    const warnings: string[] = [];
    const store = createStateStore({ backend: "file", dir, onWarn: (d) => warnings.push(d) });

    // Honest: it reports memory, so nothing downstream believes it is durable.
    expect(store.kind).toBe("memory");
    expect(warnings.join(" ")).toContain("in memory only");
    expect(warnings.join(" ")).toContain("NOT survive a restart");
  });

  it("falls back to memory when the directory exists but cannot be written", () => {
    // A read-only mount is the realistic version of this; a directory sitting
    // where the state file belongs reproduces the same failed rename portably.
    const dir = tempDir();
    mkdirSync(join(dir, STATE_FILE_NAME), { recursive: true });

    const warnings: string[] = [];
    const store = createStateStore({ backend: "file", dir, onWarn: (d) => warnings.push(d) });

    expect(store.kind).toBe("memory");
    expect(warnings.join(" ")).toContain("not writable");
  });

  it("degrading keeps the runtime serving — the store still works, it just forgets", async () => {
    const parent = tempDir();
    const dir = join(parent, "not-a-directory");
    writeFileSync(dir, "in the way", "utf8");
    const store = createStateStore({ backend: "file", dir });

    await store.transact((draft) => {
      draft.accumulators["a"] = { ...emptyAccumulator(), microcents: 9 };
    });
    expect((await store.read()).accumulators["a"]!.microcents).toBe(9);
  });

  it("a healthy directory is not degraded", () => {
    const store = new FileStateStore({ dir: tempDir() });
    expect(store.isDegraded).toBe(false);
    expect(store.kind).toBe("file");
  });
});
