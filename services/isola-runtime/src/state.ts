/**
 * THE ONLY MODULE IN THIS SERVICE ALLOWED TO TOUCH THE FILESYSTEM.
 *
 * `test/no-direct-network.test.ts` asserts by source scan that `node:fs` is
 * imported by this file and by no other file in `src/`. Do not add a filesystem
 * call anywhere else.
 *
 * WHY THERE IS A STORE AT ALL
 * ---------------------------
 * The runtime has to survive a process restart with three things intact:
 *   1. the idempotency records, so a duplicate webhook or an adapter retry does
 *      not produce a second comment, a second transition or a second charge;
 *   2. the cost-event outbox, so spend that has not reached Paperclip is
 *      re-delivered instead of silently lost;
 *   3. the sub-cent accumulator, so fractional cost is carried forward rather
 *      than reset to zero on every deploy.
 *
 * WHERE IT LIVES
 * --------------
 * The state goes to `RUNTIME_STATE_DIR`, default `/data/isola-runtime-state` —
 * a persistent volume mounted at `/data`. The app directory stays read-only and
 * the image still declares no `VOLUME`; the mount is supplied by the platform.
 *
 * A live test proved the previous `/tmp` default lost the idempotency records
 * and the sub-cent carry every time the container was replaced. With the volume
 * mounted, a redeploy, a reschedule and an OOM kill all keep the store, and the
 * startup reconciler re-delivers anything still pending.
 *
 * If the configured directory cannot be created, or exists but cannot be
 * written, the runtime does NOT stop: it degrades to an in-memory store, says
 * so loudly, and keeps serving. That degraded mode is exactly the old `/tmp`
 * behaviour — idempotency records and undelivered cost events do not survive a
 * restart — so `state_store_degraded` in the log means durability is off.
 *
 * CONTAINMENT
 * -----------
 * Every path is built by joining a fixed basename onto the configured
 * directory, and `resolveStateFile` refuses anything that would resolve outside
 * it. There is no code path that takes a path from a request.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";

import type { Accumulator, CostKind, TokenUsage } from "./money.js";
import { emptyAccumulator } from "./money.js";

export class StateStoreError extends Error {
  readonly detail: string;
  constructor(detail: string) {
    super(`state store: ${detail}`);
    this.name = "StateStoreError";
    this.detail = detail;
  }
}

/**
 * The persistent volume, not `/tmp`. Overridable with `RUNTIME_STATE_DIR`.
 * Unwritable ⇒ in-memory fallback with a loud warning, never a crash.
 */
export const DEFAULT_STATE_DIR = "/data/isola-runtime-state";
export const STATE_FILE_NAME = "state.json";
export const STATE_VERSION = 1;

// ---------------------------------------------------------------------------
// Persisted record shapes
// ---------------------------------------------------------------------------

/**
 * Safe usage metadata for a completed run, retained so a replayed inline
 * request can report the original run's figures without re-measuring anything.
 * Token counts are `null` when the provider reported none — never zero by
 * assumption.
 */
export interface RunUsageRecord {
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  model: string | null;
  provider: string;
  durationMs: number;
}

/** The result a replay must return instead of doing the work a second time. */
export interface RunResultRecord {
  httpStatus: number;
  outcome: string;
  recorded: boolean;
  recorderError: string | null;
  transitioned: boolean;
  transitionStatus: string | null;
  /** Outbox key of the cost event this run contributed to, when it emitted one. */
  costEventKey: string | null;
  costKind: CostKind | null;
  /** Microcents this run accrued. Kept for audit, not re-applied on replay. */
  accruedMicrocents: number;
  /**
   * The answer this run persisted to Paperclip, byte for byte.
   *
   * Retained for one reason only: a replayed `responseMode:"inline"` request
   * must return the SAME text, and calling the provider again to get it would
   * be a second model run and a second charge. Written only when the run
   * actually completed — a failed run stores `null`, and there is no path that
   * turns a stored answer into a response for a run that did not complete.
   *
   * This value is never logged. `redact()` also strips any log field named
   * `answerText` as a second line of defence.
   */
  answerText: string | null;
  /** The truthful end state, as `src/response.ts` defines it. */
  completionState: string | null;
  usage: RunUsageRecord | null;
  /**
   * The structured action this run produced, retained for the same reason as
   * `answerText`: a replayed duplicate must reproduce the ORIGINAL decision.
   *
   * Without this, a redelivered webhook would replay the stored answer with no
   * action, and an escalation the first delivery requested would silently
   * downgrade to an ordinary reply on the retry — the customer would have been
   * told a colleague is coming while the second delivery told the gateway
   * nothing was needed. Null for a run that emitted no action.
   */
  action?: string | null;
  actionReason?: string | null;
}

export interface IdempotencyRecord {
  key: string;
  state: "in_flight" | "complete";
  companyId: string | null;
  agentId: string | null;
  runId: string | null;
  issueId: string | null;
  createdAtMs: number;
  completedAtMs: number | null;
  result: RunResultRecord | null;
}

/** The Paperclip cost-event body, exactly as the schema defines it. */
export interface CostEventPayload {
  agentId: string;
  issueId?: string;
  heartbeatRunId?: string;
  billingCode: string;
  provider: string;
  biller: string;
  billingType: string;
  model: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  costCents: number;
  occurredAt: string;
}

export type OutboxState = "pending" | "delivered" | "failed";

export interface OutboxEntry {
  key: string;
  companyId: string;
  agentId: string;
  runId: string | null;
  /** Which exposure's agent key must be used to deliver it. */
  exposure: string;
  event: CostEventPayload;
  costKind: CostKind;
  state: OutboxState;
  attempts: number;
  createdAtMs: number;
  lastAttemptMs: number | null;
  nextAttemptMs: number;
  lastError: string | null;
  deliveredAtMs: number | null;
}

export interface Reservation {
  id: string;
  companyId: string;
  agentId: string;
  microcents: number;
  createdAtMs: number;
  expiresAtMs: number;
}

export interface BudgetSnapshot {
  agentId: string;
  budgetMonthlyCents: number | null;
  spentMonthlyCents: number;
  fetchedAtMs: number;
}

/**
 * Threshold memory, so the 80% alert fires once per crossing rather than on
 * every one of 53 runs. Keyed per agent; reset when the budget period rolls
 * over or the budget amount changes.
 */
export interface AlertRecord {
  agentId: string;
  period: string;
  budgetCents: number | null;
  /** Highest threshold percentage already alerted on in this period. */
  alertedPct: number;
  pausedInPeriod: boolean;
}

/**
 * The Paperclip issue that represents one customer conversation.
 *
 * Cached here so the second and every later message in the same conversation
 * reuses the same issue with no API round trip, and so a restart does not
 * produce a second issue for a conversation that already has one. The key is
 * the stable external reference (`chatwoot:<accountId>:<conversationId>`), never
 * anything derived from a customer's message.
 */
export interface ConversationIssueRecord {
  key: string;
  /** The company the issue belongs to. A different company never reuses it. */
  companyId: string;
  issueId: string;
  /** True when this runtime created the issue rather than finding an existing one. */
  created: boolean;
  createdAtMs: number;
}

export interface RuntimeState {
  version: number;
  idempotency: Record<string, IdempotencyRecord>;
  outbox: Record<string, OutboxEntry>;
  accumulators: Record<string, Accumulator>;
  reservations: Record<string, Reservation>;
  budgets: Record<string, BudgetSnapshot>;
  alerts: Record<string, AlertRecord>;
  /** Conversation key -> the issue that holds that conversation's work. */
  conversationIssues: Record<string, ConversationIssueRecord>;
}

export function emptyState(): RuntimeState {
  return {
    version: STATE_VERSION,
    idempotency: {},
    outbox: {},
    accumulators: {},
    reservations: {},
    budgets: {},
    alerts: {},
    conversationIssues: {},
  };
}

// ---------------------------------------------------------------------------
// Tolerant parsing — a corrupt file must never crash the runtime
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function objectOf<T>(value: unknown, keep: (v: unknown) => T | null): Record<string, T> {
  const out: Record<string, T> = {};
  if (!isRecord(value)) return out;
  for (const [k, v] of Object.entries(value)) {
    const kept = keep(v);
    if (kept !== null) out[k] = kept;
  }
  return out;
}

function num(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function usageOf(value: unknown): TokenUsage {
  const r = isRecord(value) ? value : {};
  return {
    inputTokens: Math.max(0, Math.floor(num(r["inputTokens"], 0))),
    cachedInputTokens: Math.max(0, Math.floor(num(r["cachedInputTokens"], 0))),
    outputTokens: Math.max(0, Math.floor(num(r["outputTokens"], 0))),
  };
}

function optString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function optNum(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Parse a persisted run result.
 *
 * Tolerant on purpose: a record written by an older build has no `answerText`,
 * no `completionState` and no `usage`, and dropping the whole record over that
 * would resurrect the duplicate-run defect. Missing fields become `null`, and
 * a `null` answer is handled explicitly at the replay site — it is never
 * papered over with a regenerated one.
 */
function resultOf(value: unknown): RunResultRecord | null {
  if (!isRecord(value)) return null;
  const usageRaw = value["usage"];
  const usage: RunUsageRecord | null = isRecord(usageRaw)
    ? {
        inputTokens: optNum(usageRaw["inputTokens"]),
        cachedInputTokens: optNum(usageRaw["cachedInputTokens"]),
        outputTokens: optNum(usageRaw["outputTokens"]),
        model: optString(usageRaw["model"]),
        provider: optString(usageRaw["provider"]) ?? "unknown",
        durationMs: Math.max(0, num(usageRaw["durationMs"], 0)),
      }
    : null;
  return {
    httpStatus: num(value["httpStatus"], 500),
    outcome: String(value["outcome"] ?? "internal_error"),
    recorded: value["recorded"] === true,
    recorderError: optString(value["recorderError"]),
    transitioned: value["transitioned"] === true,
    transitionStatus: optString(value["transitionStatus"]),
    costEventKey: optString(value["costEventKey"]),
    costKind: optString(value["costKind"]) as CostKind | null,
    accruedMicrocents: num(value["accruedMicrocents"], 0),
    answerText: optString(value["answerText"]),
    completionState: optString(value["completionState"]),
    usage,
  };
}

/**
 * Accept only what we can prove the shape of. A record we cannot read is
 * dropped rather than half-trusted — but a dropped *outbox* record would be
 * lost spend, so the parse for those is deliberately permissive about optional
 * fields and strict only about the ones delivery needs.
 */
export function sanitiseState(parsed: unknown): RuntimeState {
  if (!isRecord(parsed)) return emptyState();

  return {
    version: STATE_VERSION,
    idempotency: objectOf(parsed["idempotency"], (v): IdempotencyRecord | null => {
      if (!isRecord(v) || typeof v["key"] !== "string") return null;
      const state = v["state"] === "complete" ? "complete" : "in_flight";
      const result = resultOf(v["result"]);
      return {
        key: v["key"],
        state,
        companyId: typeof v["companyId"] === "string" ? v["companyId"] : null,
        agentId: typeof v["agentId"] === "string" ? v["agentId"] : null,
        runId: typeof v["runId"] === "string" ? v["runId"] : null,
        issueId: typeof v["issueId"] === "string" ? v["issueId"] : null,
        createdAtMs: num(v["createdAtMs"], 0),
        completedAtMs: typeof v["completedAtMs"] === "number" ? v["completedAtMs"] : null,
        result,
      };
    }),
    outbox: objectOf(parsed["outbox"], (v): OutboxEntry | null => {
      if (!isRecord(v) || typeof v["key"] !== "string") return null;
      const event = v["event"];
      if (!isRecord(event) || typeof event["agentId"] !== "string") return null;
      const state: OutboxState =
        v["state"] === "delivered" ? "delivered" : v["state"] === "failed" ? "failed" : "pending";
      return {
        key: v["key"],
        companyId: typeof v["companyId"] === "string" ? v["companyId"] : "",
        agentId: typeof v["agentId"] === "string" ? v["agentId"] : event["agentId"],
        runId: typeof v["runId"] === "string" ? v["runId"] : null,
        exposure: typeof v["exposure"] === "string" ? v["exposure"] : "INTERNAL",
        event: event as unknown as CostEventPayload,
        costKind: (typeof v["costKind"] === "string" ? v["costKind"] : "actual") as CostKind,
        state,
        attempts: Math.max(0, Math.floor(num(v["attempts"], 0))),
        createdAtMs: num(v["createdAtMs"], 0),
        lastAttemptMs: typeof v["lastAttemptMs"] === "number" ? v["lastAttemptMs"] : null,
        nextAttemptMs: num(v["nextAttemptMs"], 0),
        lastError: typeof v["lastError"] === "string" ? v["lastError"] : null,
        deliveredAtMs: typeof v["deliveredAtMs"] === "number" ? v["deliveredAtMs"] : null,
      };
    }),
    accumulators: objectOf(parsed["accumulators"], (v): Accumulator | null => {
      if (!isRecord(v)) return null;
      return {
        microcents: Math.max(0, Math.round(num(v["microcents"], 0))),
        usage: usageOf(v["usage"]),
        runs: Math.max(0, Math.floor(num(v["runs"], 0))),
      };
    }),
    reservations: objectOf(parsed["reservations"], (v): Reservation | null => {
      if (!isRecord(v) || typeof v["id"] !== "string") return null;
      return {
        id: v["id"],
        companyId: typeof v["companyId"] === "string" ? v["companyId"] : "",
        agentId: typeof v["agentId"] === "string" ? v["agentId"] : "",
        microcents: Math.max(0, Math.round(num(v["microcents"], 0))),
        createdAtMs: num(v["createdAtMs"], 0),
        expiresAtMs: num(v["expiresAtMs"], 0),
      };
    }),
    budgets: objectOf(parsed["budgets"], (v): BudgetSnapshot | null => {
      if (!isRecord(v) || typeof v["agentId"] !== "string") return null;
      return {
        agentId: v["agentId"],
        budgetMonthlyCents:
          typeof v["budgetMonthlyCents"] === "number" ? v["budgetMonthlyCents"] : null,
        spentMonthlyCents: Math.max(0, num(v["spentMonthlyCents"], 0)),
        fetchedAtMs: num(v["fetchedAtMs"], 0),
      };
    }),
    alerts: objectOf(parsed["alerts"], (v): AlertRecord | null => {
      if (!isRecord(v) || typeof v["agentId"] !== "string") return null;
      return {
        agentId: v["agentId"],
        period: typeof v["period"] === "string" ? v["period"] : "",
        budgetCents:
          typeof v["budgetCents"] === "number" ? v["budgetCents"] : null,
        alertedPct: Math.max(0, num(v["alertedPct"], 0)),
        pausedInPeriod: v["pausedInPeriod"] === true,
      };
    }),
    // Strict on purpose: a half-read record here would either resurrect the
    // duplicate-issue defect or point a conversation at somebody else's issue.
    // A record we cannot fully prove is dropped, and the next message simply
    // looks the issue up in Paperclip again.
    conversationIssues: objectOf(
      parsed["conversationIssues"],
      (v): ConversationIssueRecord | null => {
        if (!isRecord(v)) return null;
        if (typeof v["key"] !== "string" || v["key"].length === 0) return null;
        if (typeof v["issueId"] !== "string" || v["issueId"].length === 0) return null;
        if (typeof v["companyId"] !== "string" || v["companyId"].length === 0) return null;
        return {
          key: v["key"],
          companyId: v["companyId"],
          issueId: v["issueId"],
          created: v["created"] === true,
          createdAtMs: num(v["createdAtMs"], 0),
        };
      },
    ),
  };
}

// ---------------------------------------------------------------------------
// The store interface
// ---------------------------------------------------------------------------

export interface StateStore {
  readonly kind: "memory" | "file";
  /** A read-only snapshot. Callers must not mutate it. */
  read(): Promise<RuntimeState>;
  /**
   * Serialized read-modify-write. The mutator receives a private draft; the
   * draft is committed and persisted only if the mutator resolves. If it
   * throws, nothing is written.
   *
   * Every reservation, accumulator and outbox mutation goes through here, which
   * is what makes concurrent runs unable to collectively overspend: within one
   * process the transactions are strictly serialized.
   */
  transact<T>(mutate: (draft: RuntimeState) => T | Promise<T>): Promise<T>;
}

/** Serializes transactions onto a promise chain. Shared by both backends. */
abstract class BaseStateStore implements StateStore {
  abstract readonly kind: "memory" | "file";
  protected current: RuntimeState = emptyState();
  private tail: Promise<unknown> = Promise.resolve();

  async read(): Promise<RuntimeState> {
    // Reads join the same queue so a caller never observes a half-applied draft.
    return this.transact((draft) => structuredClone(draft));
  }

  transact<T>(mutate: (draft: RuntimeState) => T | Promise<T>): Promise<T> {
    const run = this.tail.then(async () => {
      const draft = structuredClone(this.current);
      const result = await mutate(draft);
      this.current = draft;
      await this.persist(draft);
      return result;
    });
    // Keep the chain alive even when a transaction rejects.
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  protected abstract persist(state: RuntimeState): Promise<void>;
}

export class InMemoryStateStore extends BaseStateStore {
  readonly kind = "memory" as const;

  constructor(initial?: RuntimeState) {
    super();
    this.current = initial ? sanitiseState(initial) : emptyState();
  }

  protected async persist(_state: RuntimeState): Promise<void> {
    // Nothing to do: the in-memory draft is the durable copy for this backend.
  }
}

/**
 * Build the state file path for a directory, refusing anything that would
 * escape it. Pure and exported so the containment rule is directly testable.
 */
export function resolveStateFile(dir: string, name: string = STATE_FILE_NAME): string {
  const trimmed = dir.trim();
  if (trimmed.length === 0) {
    throw new StateStoreError("RUNTIME_STATE_DIR is empty");
  }
  if (name.length === 0 || /[\\/]/.test(name) || name.includes("..")) {
    throw new StateStoreError("state file name must be a plain basename");
  }
  const base = resolve(trimmed);
  const file = resolve(join(base, name));
  if (file !== join(base, name) || !file.startsWith(base + sep)) {
    throw new StateStoreError("resolved state path escapes RUNTIME_STATE_DIR");
  }
  return file;
}

export interface FileStateStoreOptions {
  dir: string;
  /** Called with a category string when the store degrades. Never a value. */
  onWarn?: (detail: string) => void;
}

/**
 * File-backed store. Writes are whole-file and atomic: a temporary sibling is
 * written and then renamed over the target, so a crash mid-write leaves the
 * previous good state rather than a truncated file.
 */
export class FileStateStore extends BaseStateStore {
  readonly kind = "file" as const;
  private readonly file: string;
  private readonly tmpFile: string;
  private readonly warn: (detail: string) => void;
  private degraded = false;

  constructor(options: FileStateStoreOptions) {
    super();
    this.warn = options.onWarn ?? (() => undefined);
    this.file = resolveStateFile(options.dir);
    this.tmpFile = resolveStateFile(options.dir, `${STATE_FILE_NAME}.tmp`);
    this.current = this.loadFromDisk(options.dir);
    // Prove the path is writable NOW rather than discovering it on the first
    // settled cost event. A read-only or wrong-owner mount is the realistic
    // failure with a platform-supplied volume, and it must be loud at boot.
    if (!this.degraded) this.probeWritable();
  }

  /** Absolute path of the state file. Exposed for logging and tests only. */
  get path(): string {
    return this.file;
  }

  get isDegraded(): boolean {
    return this.degraded;
  }

  /**
   * Write the state we just loaded straight back, through the same atomic
   * temp-file-then-rename path every later write uses. Succeeding proves the
   * directory is writable; failing marks the store degraded at construction so
   * `createStateStore` can fall back to an honest in-memory store instead of
   * pretending to be durable.
   */
  private probeWritable(): void {
    try {
      writeFileSync(this.tmpFile, JSON.stringify(this.current), {
        encoding: "utf8",
        mode: 0o600,
      });
      renameSync(this.tmpFile, this.file);
    } catch {
      this.degraded = true;
      this.warn(
        "RUNTIME_STATE_DIR exists but is not writable; continuing in memory only — idempotency records, the cost-event outbox and the sub-cent carry will NOT survive a restart",
      );
    }
  }

  private loadFromDisk(dir: string): RuntimeState {
    try {
      // Create it if absent: a fresh volume is mounted empty.
      mkdirSync(resolve(dir.trim()), { recursive: true });
    } catch {
      this.degraded = true;
      this.warn(
        "could not create RUNTIME_STATE_DIR; continuing in memory only — idempotency records, the cost-event outbox and the sub-cent carry will NOT survive a restart",
      );
      return emptyState();
    }
    let raw: string;
    try {
      raw = readFileSync(this.file, "utf8");
    } catch {
      // No prior state is the normal first-boot case, not a failure.
      return emptyState();
    }
    try {
      return sanitiseState(JSON.parse(raw));
    } catch {
      this.warn("state file was unreadable JSON and was ignored; starting empty");
      return emptyState();
    }
  }

  protected async persist(state: RuntimeState): Promise<void> {
    try {
      writeFileSync(this.tmpFile, JSON.stringify(state), { encoding: "utf8", mode: 0o600 });
      renameSync(this.tmpFile, this.file);
      this.degraded = false;
    } catch {
      if (!this.degraded) {
        this.degraded = true;
        this.warn("state file is not writable; continuing in memory only");
      }
    }
  }
}

export interface CreateStateStoreArgs {
  backend: "file" | "memory";
  dir: string;
  onWarn?: (detail: string) => void;
}

/**
 * Choose a store.
 *
 * The file backend is durable when `RUNTIME_STATE_DIR` is a mounted volume. If
 * the path cannot be created or cannot be written, this falls back to a real
 * in-memory store — `kind` then reports `"memory"`, so nothing downstream and
 * no operator reading a log line is told the state is durable when it is not.
 * That degraded mode keeps the runtime serving; it only loses durability.
 */
export function createStateStore(args: CreateStateStoreArgs): StateStore {
  if (args.backend === "memory") return new InMemoryStateStore();
  let store: FileStateStore;
  try {
    store = new FileStateStore({ dir: args.dir, onWarn: args.onWarn });
  } catch (err) {
    args.onWarn?.(
      err instanceof StateStoreError
        ? err.detail
        : "state directory could not be initialised",
    );
    return new InMemoryStateStore();
  }
  if (store.isDegraded) return new InMemoryStateStore();
  return store;
}

/** Accumulator helper: read-or-create, so callers never handle `undefined`. */
export function accumulatorFor(state: RuntimeState, key: string): Accumulator {
  return state.accumulators[key] ?? emptyAccumulator();
}
