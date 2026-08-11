/**
 * Configuration. Pure function of an environment record so tests can build a
 * config without touching process.env.
 */
import type { Exposure } from "./registry.js";
import { hostOf, parseAllowlist } from "./egress.js";
import type { RateOverrides } from "./money.js";
import { DEFAULT_HANDOFF, type HandoffPolicy } from "./callbacks.js";
import { isIssueStatus } from "./paperclip.js";
import { DEFAULT_STATE_DIR } from "./state.js";

export interface RuntimeConfig {
  port: number;
  /** Per-exposure bearer credentials. `null` means "not configured". */
  secrets: Readonly<Record<Exposure, string | null>>;
  modelBaseUrl: string;
  modelApiKey: string | null;
  /** Env override for the model name; `null` means "use the template's model". */
  modelNameOverride: string | null;
  modelTimeoutMs: number;
  paperclipBaseUrl: string | null;
  paperclipApiKey: string | null;
  /**
   * The employee's own agent API key per exposure class. Paperclip
   * authenticates callbacks as the agent and rejects a cost event whose
   * `agentId` is not the calling agent, so this — not a shared board key — is
   * the credential for every callback. Falls back to PAPERCLIP_API_KEY.
   */
  paperclipAgentKeys: Readonly<Record<Exposure, string | null>>;
  paperclipRecordPath: string;
  /** Company that owns the cost events. Metering is off without one. */
  paperclipCompanyId: string | null;
  egressAllowlist: string[];
  /** Hard ceiling on an inbound request body, in bytes. */
  maxRequestBytes: number;

  // ---- state -------------------------------------------------------------
  stateBackend: "file" | "memory";
  stateDir: string;

  // ---- callbacks and the loop fix ----------------------------------------
  handoff: HandoffPolicy;

  // ---- metering ----------------------------------------------------------
  /** Cost-event `provider`. Derived from MODEL_BASE_URL unless set. */
  modelProvider: string;
  rateOverrides: RateOverrides;
  syntheticPricing: boolean;

  // ---- budget ------------------------------------------------------------
  budgetEnforcement: boolean;
  budgetAlertPct: number;
  budgetRefreshMs: number;
  pauseOnExhausted: boolean;
  estimatedOutputTokens: number;
  reservationTtlMs: number;

  // ---- fail closed on undelivered spend ----------------------------------
  maxUndeliveredCostCents: number;
  maxUndeliveredAgeMs: number;

  // ---- idempotency and the outbox ----------------------------------------
  idempotencyTtlMs: number;
  outboxMaxAttempts: number;
  outboxBaseBackoffMs: number;
  outboxMaxBackoffMs: number;
  outboxRetentionMs: number;
  outboxFlushLimit: number;
  /** Background sweep interval. 0 disables the timer. */
  outboxSweepMs: number;
}

export const DEFAULT_MODEL_BASE_URL = "https://api.deepseek.com";
export const DEFAULT_MODEL_NAME = "deepseek-chat";
export const DEFAULT_MODEL_TIMEOUT_MS = 60_000;
export const DEFAULT_RECORD_PATH = "/api/issues/{issueId}/comments";
export const DEFAULT_MAX_REQUEST_BYTES = 1024 * 1024; // 1 MiB
export const DEFAULT_MAX_UNDELIVERED_COST_CENTS = 50;
export const DEFAULT_MAX_UNDELIVERED_AGE_MS = 60 * 60 * 1000;
export const DEFAULT_BUDGET_ALERT_PCT = 80;
export const DEFAULT_BUDGET_REFRESH_MS = 15_000;
export const DEFAULT_ESTIMATED_OUTPUT_TOKENS = 1000;
export const DEFAULT_RESERVATION_TTL_MS = 5 * 60 * 1000;
export const DEFAULT_IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_OUTBOX_SWEEP_MS = 60_000;

export type EnvRecord = Record<string, string | undefined>;

function str(env: EnvRecord, key: string): string | null {
  const raw = env[key];
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function int(env: EnvRecord, key: string, fallback: number): number {
  const raw = str(env, key);
  if (raw === null) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

/** Like `int`, but 0 is a meaningful setting (for example "block on any"). */
function intAllowZero(env: EnvRecord, key: string, fallback: number): number {
  const raw = str(env, key);
  if (raw === null) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return parsed;
}

/**
 * A price. `null` means "no rate configured", which is materially different
 * from zero: unset falls through to the built-in rate card, and an explicit 0
 * means the operator is asserting this token class is free.
 */
function price(env: EnvRecord, key: string): number | null {
  const raw = str(env, key);
  if (raw === null) return null;
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return parsed;
}

function bool(env: EnvRecord, key: string, fallback: boolean): boolean {
  const raw = str(env, key);
  if (raw === null) return fallback;
  const v = raw.toLowerCase();
  if (["1", "true", "on", "yes", "enabled"].includes(v)) return true;
  if (["0", "false", "off", "no", "disabled"].includes(v)) return false;
  return fallback;
}

function pct(env: EnvRecord, key: string, fallback: number): number {
  const raw = str(env, key);
  if (raw === null) return fallback;
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 100) return fallback;
  return parsed;
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

/**
 * Cost events need a `provider` string. Derive it from the model host — the
 * first label after any `api.`/`www.` prefix — so the common case needs no
 * configuration and the value still means something.
 */
export function deriveProvider(modelBaseUrl: string): string {
  const host = hostOf(modelBaseUrl);
  if (host === null) return "unknown";
  const labels = host.split(".").filter((l) => l.length > 0 && l !== "api" && l !== "www");
  return labels[0] ?? host;
}

export function loadConfig(env: EnvRecord): RuntimeConfig {
  const modelBaseUrl = stripTrailingSlash(
    str(env, "MODEL_BASE_URL") ?? DEFAULT_MODEL_BASE_URL,
  );
  const paperclipBaseUrlRaw = str(env, "PAPERCLIP_BASE_URL");
  const paperclipBaseUrl = paperclipBaseUrlRaw
    ? stripTrailingSlash(paperclipBaseUrlRaw)
    : null;

  const explicitAllowlist = parseAllowlist(env["EGRESS_ALLOWLIST"]);
  const derivedAllowlist = [hostOf(modelBaseUrl), hostOf(paperclipBaseUrl)].filter(
    (h): h is string => h !== null,
  );
  const egressAllowlist =
    explicitAllowlist.length > 0
      ? explicitAllowlist
      : Array.from(new Set(derivedAllowlist));

  const boardKey = str(env, "PAPERCLIP_API_KEY");
  const successStatusRaw = str(env, "PAPERCLIP_SUCCESS_STATUS");
  const failureStatusRaw = str(env, "PAPERCLIP_FAILURE_STATUS");

  return {
    port: int(env, "PORT", 3000),
    secrets: Object.freeze({
      INTERNAL: str(env, "RUNTIME_SECRET_INTERNAL"),
      PUBLIC: str(env, "RUNTIME_SECRET_PUBLIC"),
    }),
    modelBaseUrl,
    modelApiKey: str(env, "MODEL_API_KEY"),
    modelNameOverride: str(env, "MODEL_NAME"),
    modelTimeoutMs: int(env, "RUNTIME_MODEL_TIMEOUT_MS", DEFAULT_MODEL_TIMEOUT_MS),
    paperclipBaseUrl,
    paperclipApiKey: boardKey,
    paperclipAgentKeys: Object.freeze({
      INTERNAL: str(env, "PAPERCLIP_AGENT_KEY_INTERNAL") ?? boardKey,
      PUBLIC: str(env, "PAPERCLIP_AGENT_KEY_PUBLIC") ?? boardKey,
    }),
    paperclipRecordPath: str(env, "PAPERCLIP_RECORD_PATH") ?? DEFAULT_RECORD_PATH,
    paperclipCompanyId: str(env, "PAPERCLIP_COMPANY_ID"),
    egressAllowlist,
    maxRequestBytes: int(env, "RUNTIME_MAX_REQUEST_BYTES", DEFAULT_MAX_REQUEST_BYTES),

    stateBackend: str(env, "RUNTIME_STATE_BACKEND") === "memory" ? "memory" : "file",
    stateDir: str(env, "RUNTIME_STATE_DIR") ?? DEFAULT_STATE_DIR,

    handoff: Object.freeze({
      // An unrecognised status would be rejected by Paperclip, so fall back
      // rather than PATCH something the API will refuse.
      successStatus: isIssueStatus(successStatusRaw)
        ? successStatusRaw
        : DEFAULT_HANDOFF.successStatus,
      failureStatus: isIssueStatus(failureStatusRaw)
        ? failureStatusRaw
        : DEFAULT_HANDOFF.failureStatus,
      owner: str(env, "PAPERCLIP_FAILURE_OWNER") ?? DEFAULT_HANDOFF.owner,
    }),

    modelProvider: str(env, "MODEL_PROVIDER") ?? deriveProvider(modelBaseUrl),
    rateOverrides: Object.freeze({
      inputPerMtokCents: price(env, "MODEL_PRICE_INPUT_PER_MTOK_CENTS"),
      cachedInputPerMtokCents: price(env, "MODEL_PRICE_CACHED_INPUT_PER_MTOK_CENTS"),
      outputPerMtokCents: price(env, "MODEL_PRICE_OUTPUT_PER_MTOK_CENTS"),
    }),
    syntheticPricing: bool(env, "RUNTIME_SYNTHETIC_PRICING", false),

    budgetEnforcement: bool(env, "RUNTIME_BUDGET_ENFORCEMENT", true),
    budgetAlertPct: pct(env, "RUNTIME_BUDGET_ALERT_THRESHOLD_PCT", DEFAULT_BUDGET_ALERT_PCT),
    budgetRefreshMs: intAllowZero(env, "RUNTIME_BUDGET_REFRESH_MS", DEFAULT_BUDGET_REFRESH_MS),
    pauseOnExhausted: bool(env, "RUNTIME_PAUSE_ON_EXHAUSTED", true),
    estimatedOutputTokens: intAllowZero(
      env,
      "RUNTIME_ESTIMATED_OUTPUT_TOKENS",
      DEFAULT_ESTIMATED_OUTPUT_TOKENS,
    ),
    reservationTtlMs: int(env, "RUNTIME_RESERVATION_TTL_MS", DEFAULT_RESERVATION_TTL_MS),

    maxUndeliveredCostCents: intAllowZero(
      env,
      "RUNTIME_MAX_UNDELIVERED_COST_CENTS",
      DEFAULT_MAX_UNDELIVERED_COST_CENTS,
    ),
    maxUndeliveredAgeMs: int(
      env,
      "RUNTIME_MAX_UNDELIVERED_AGE_MS",
      DEFAULT_MAX_UNDELIVERED_AGE_MS,
    ),

    idempotencyTtlMs: int(env, "RUNTIME_IDEMPOTENCY_TTL_MS", DEFAULT_IDEMPOTENCY_TTL_MS),
    outboxMaxAttempts: int(env, "RUNTIME_OUTBOX_MAX_ATTEMPTS", 8),
    outboxBaseBackoffMs: int(env, "RUNTIME_OUTBOX_BASE_BACKOFF_MS", 250),
    outboxMaxBackoffMs: int(env, "RUNTIME_OUTBOX_MAX_BACKOFF_MS", 30_000),
    outboxRetentionMs: int(env, "RUNTIME_OUTBOX_RETENTION_MS", 24 * 60 * 60 * 1000),
    outboxFlushLimit: int(env, "RUNTIME_OUTBOX_FLUSH_LIMIT", 10),
    outboxSweepMs: intAllowZero(env, "RUNTIME_OUTBOX_SWEEP_MS", DEFAULT_OUTBOX_SWEEP_MS),
  };
}

/** True when at least one exposure credential is configured. */
export function hasAnyCredential(config: RuntimeConfig): boolean {
  return config.secrets.INTERNAL !== null || config.secrets.PUBLIC !== null;
}

/**
 * Boot-time warnings. Returns a list of category strings — never a value.
 * Callers log these once at boot.
 */
export function bootWarnings(config: RuntimeConfig): string[] {
  const warnings: string[] = [];
  if (config.secrets.INTERNAL === null) {
    warnings.push(
      "RUNTIME_SECRET_INTERNAL is unset: INTERNAL templates will return 503 (fail closed).",
    );
  }
  if (config.secrets.PUBLIC === null) {
    warnings.push(
      "RUNTIME_SECRET_PUBLIC is unset: PUBLIC templates will return 503 (fail closed).",
    );
  }
  if (
    config.secrets.INTERNAL !== null &&
    config.secrets.INTERNAL === config.secrets.PUBLIC
  ) {
    warnings.push(
      "RUNTIME_SECRET_INTERNAL and RUNTIME_SECRET_PUBLIC are identical: the exposure boundary is not enforceable. Set two distinct values.",
    );
  }
  if (config.modelApiKey === null) {
    warnings.push("MODEL_API_KEY is unset: every model call will fail with 502.");
  }
  if (config.paperclipApiKey === null) {
    warnings.push(
      "PAPERCLIP_API_KEY is unset: using NullRunRecorder, outcomes are not written back to Paperclip.",
    );
  }
  if (config.egressAllowlist.length === 0) {
    warnings.push("EGRESS_ALLOWLIST resolved empty: every outbound call will be blocked.");
  }
  if (config.paperclipCompanyId === null) {
    warnings.push(
      "PAPERCLIP_COMPANY_ID is unset and no run context supplies one: cost events cannot be addressed, so spend will not reach the Paperclip ledger.",
    );
  }
  if (
    config.paperclipAgentKeys.INTERNAL === null &&
    config.paperclipAgentKeys.PUBLIC === null
  ) {
    warnings.push(
      "No employee agent API key is configured (PAPERCLIP_AGENT_KEY_INTERNAL / PAPERCLIP_AGENT_KEY_PUBLIC / PAPERCLIP_API_KEY): comments, issue transitions and cost events will all be skipped, and the run loop will not be broken.",
    );
  }
  if (!config.budgetEnforcement) {
    warnings.push(
      "RUNTIME_BUDGET_ENFORCEMENT is off: the 80% alert and the 100% hard stop will not fire. Usage is still metered.",
    );
  }
  if (config.syntheticPricing) {
    warnings.push(
      "RUNTIME_SYNTHETIC_PRICING is on: models with no real rate are priced from the synthetic-pricing@v1 profile. Those cost events are marked synthetic and are NOT real expenditure.",
    );
  }
  if (config.stateBackend === "memory") {
    warnings.push(
      "RUNTIME_STATE_BACKEND is memory: idempotency records, the cost-event outbox and the sub-cent accumulator are lost on restart.",
    );
  }
  return warnings;
}
