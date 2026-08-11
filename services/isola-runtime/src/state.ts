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
 * The container has no volume and a read-only app directory, and that is not
 * being changed — the absence of a mount is part of the security argument. So
 * the state goes to `RUNTIME_STATE_DIR` (default `/tmp/isola-runtime-state`),
 * the one writable path a read-only image still has.
 *
 * **`/tmp` does not survive a container replacement.** A redeploy, a
 * rescheduling or an OOM kill starts with an empty store: idempotency records
 * are gone (a replayed webhook could produce a second comment) and any
 * undelivered cost event is lost. A restart *of the same container* keeps it,
 * and the startup reconciler re-reads what is there and re-delivers anything
 * still pending. This is a deliberate, documented trade — see the README.
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

export const DEFAULT_STATE_DIR = "/tmp/isola-runtime-state";
export const STATE_FILE_NAME = "state.json";
export const STATE_VERSION = 1;

// ---------------------------------------------------------------------------
// Persisted record shapes
// ---------------------------------------------------------------------------

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

export interface RuntimeState {
  version: number;
  idempotency: Record<string, IdempotencyRecord>;
  outbox: Record<string, OutboxEntry>;
  accumulators: Record<string, Accumulator>;
  reservations: Record<string, Reservation>;
  budgets: Record<string, BudgetSnapshot>;
  alerts: Record<string, AlertRecord>;
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
      const result = isRecord(v["result"])
        ? {
            httpStatus: num((v["result"] as Record<string, unknown>)["httpStatus"], 500),
            outcome: String((v["result"] as Record<string, unknown>)["outcome"] ?? "internal_error"),
            recorded: (v["result"] as Record<string, unknown>)["recorded"] === true,
            recorderError:
              typeof (v["result"] as Record<string, unknown>)["recorderError"] === "string"
                ? ((v["result"] as Record<string, unknown>)["recorderError"] as string)
                : null,
            transitioned: (v["result"] as Record<string, unknown>)["transitioned"] === true,
            transitionStatus:
              typeof (v["result"] as Record<string, unknown>)["transitionStatus"] === "string"
                ? ((v["result"] as Record<string, unknown>)["transitionStatus"] as string)
                : null,
            costEventKey:
              typeof (v["result"] as Record<string, unknown>)["costEventKey"] === "string"
                ? ((v["result"] as Record<string, unknown>)["costEventKey"] as string)
                : null,
            costKind:
              typeof (v["result"] as Record<string, unknown>)["costKind"] === "string"
                ? ((v["result"] as Record<string, unknown>)["costKind"] as CostKind)
                : null,
            accruedMicrocents: num(
              (v["result"] as Record<string, unknown>)["accruedMicrocents"],
              0,
            ),
          }
        : null;
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
  }

  /** Absolute path of the state file. Exposed for logging and tests only. */
  get path(): string {
    return this.file;
  }

  get isDegraded(): boolean {
    return this.degraded;
  }

  private loadFromDisk(dir: string): RuntimeState {
    try {
      mkdirSync(resolve(dir.trim()), { recursive: true });
    } catch {
      this.degraded = true;
      this.warn("could not create RUNTIME_STATE_DIR; continuing in memory only");
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
 * Choose a store. The file backend degrades to in-memory behaviour if the path
 * is unusable — the runtime must keep serving, it just loses durability, and it
 * says so loudly.
 */
export function createStateStore(args: CreateStateStoreArgs): StateStore {
  if (args.backend === "memory") return new InMemoryStateStore();
  try {
    return new FileStateStore({ dir: args.dir, onWarn: args.onWarn });
  } catch (err) {
    args.onWarn?.(
      err instanceof StateStoreError
        ? err.detail
        : "state directory could not be initialised",
    );
    return new InMemoryStateStore();
  }
}

/** Accumulator helper: read-or-create, so callers never handle `undefined`. */
export function accumulatorFor(state: RuntimeState, key: string): Accumulator {
  return state.accumulators[key] ?? emptyAccumulator();
}
