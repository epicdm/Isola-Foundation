/**
 * Configuration. Pure function of an environment record so tests can build a
 * config without touching process.env.
 */
import type { Exposure } from "./registry.js";
import { hostOf, parseAllowlist } from "./egress.js";
import { allTemplates, templateModelHosts } from "./registry.js";

/** Floor for PRINCIPAL_SIGNING_KEY / PRINCIPAL_USER_KEY: a 128-bit hex string. */
export const MIN_PRINCIPAL_KEY_CHARS = 32;
import type { RateOverrides } from "./money.js";
import { DEFAULT_HANDOFF, type HandoffPolicy } from "./callbacks.js";
import { isIssueStatus } from "./paperclip.js";
import { parseInstructionsMap } from "./instructions.js";
import { DEFAULT_STATE_DIR } from "./state.js";

export interface RuntimeConfig {
  port: number;
  /** Per-exposure bearer credentials. `null` means "not configured". */
  secrets: Readonly<Record<Exposure, string | null>>;
  /**
   * ROTATION GRACE — a SECOND accepted value per exposure class.
   *
   * It exists because the gateway and this service live in DIFFERENT STACKS and
   * cannot be rolled atomically. Without an overlap, replacing a shared secret
   * means an interval where the caller presents the new value and the callee
   * still expects the old one — and on the public path that is every customer
   * message failing closed.
   *
   * It grants NOTHING a class did not already have: a NEXT value resolves to the
   * SAME exposure as the CURRENT value beside it. Absent means absent — with no
   * NEXT configured the resolver behaves exactly as it did before.
   */
  secretsNext: Readonly<Record<Exposure, string | null>>;
  modelBaseUrl: string;
  modelApiKey: string | null;
  /**
   * `PRINCIPAL_SIGNING_KEY` — the HMAC key the internal gateway signs a verified
   * principal with (src/principal.ts). Held ONLY by that gateway and this
   * service; deliberately NOT a runtime credential, so holding
   * RUNTIME_SECRET_INTERNAL does not let a caller mint an owner principal.
   * Required at boot while any template `requiresPrincipal` (see bootErrors).
   * Never logged, never returned.
   */
  principalSigningKey: string | null;
  /**
   * `PRINCIPAL_USER_KEY` — optional dedicated key for the brain-facing `user`
   * id. Absent: a key is derived from the signing key by HKDF with a distinct
   * info string. Never logged, never returned.
   */
  principalUserKey: string | null;
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
  /**
   * Behaviour lives in Paperclip. `PAPERCLIP_INSTRUCTIONS_MAP` binds a template id
   * to the Paperclip agent whose instructions bundle supplies its system prompt.
   * A template absent from this map keeps its compiled-in prompt.
   */
  paperclipInstructionsMap: Readonly<Record<string, string>>;
  /**
   * Board-scoped token used ONLY to read instruction bundles. Deliberately not the
   * agent keys above: reading company configuration is a different authority from
   * recording a cost event, and a customer-facing path should hold the smaller one.
   */
  paperclipBoardToken: string | null;
  /** How long a fetched prompt may be reused before re-reading Paperclip. */
  paperclipInstructionsTtlMs: number;
  paperclipInstructionsTimeoutMs: number;
  egressAllowlist: string[];
  /** Hard ceiling on an inbound request body, in bytes. */
  maxRequestBytes: number;

  // ---- state -------------------------------------------------------------
  stateBackend: "file" | "memory";
  stateDir: string;

  // ---- callbacks and the loop fix ----------------------------------------
  handoff: HandoffPolicy;

  /**
   * RUNTIME_CONVERSATION_ISSUES. When a run carries a conversation reference but
   * no issue id, create-or-get a Paperclip issue for that conversation so the
   * output has somewhere to be persisted. Off restores the previous behaviour
   * exactly: such a run cannot persist and is reported `persistence_failed`.
   */
  conversationIssues: boolean;

  // ---- metering ----------------------------------------------------------
  /** Cost-event `provider`. Derived from MODEL_BASE_URL unless set. */
  modelProvider: string;
  rateOverrides: RateOverrides;
  syntheticPricing: boolean;

  // ---- budget ------------------------------------------------------------
  budgetEnforcement: boolean;
  /**
   * Ceiling applied when Paperclip supplies none. `null` means the operator did
   * not set it, which is a BOOT FAILURE rather than a default — see bootErrors.
   */
  budgetFallbackCents: number | null;
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
/**
 * Short by design. This is the delay between the owner editing AGENTS.md in Paperclip
 * and a customer seeing the change — the acceptance test for the whole feature — and
 * it also bounds how long a withdrawn instruction can still be spoken.
 */
export const DEFAULT_INSTRUCTIONS_TTL_MS = 60_000;
/** A reply is already waiting on this; it must not become the slow path. */
export const DEFAULT_INSTRUCTIONS_TIMEOUT_MS = 5_000;
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
/**
 * A positive integer with NO fallback. Returns null when absent or unusable so
 * the caller can refuse to boot, rather than substituting a value. Used for
 * settings where an invented number would itself be the defect.
 */
function positiveIntOrNull(env: EnvRecord, key: string): number | null {
  const raw = str(env, key);
  if (raw === null) return null;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

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
  // A template that declares its own brain must be reachable, or the call fails
  // closed at safeFetch — which is exactly what the FIRST reachability probe of
  // the Hermes tunnel missed: a raw fetch() from inside the container returned
  // 200 while the real call path, which goes through safeFetch, would have been
  // refused. A GREEN PROBE AGAINST THE WRONG CODE PATH IS NOT REACHABILITY.
  //
  // Derived from the templates themselves, so the allowlist is exactly the hosts
  // in declared use — never a pattern, never a wildcard. Adding a template adds
  // its host and nothing else.
  const templateHosts = templateModelHosts();
  const derivedAllowlist = [
    hostOf(modelBaseUrl),
    hostOf(paperclipBaseUrl),
    ...templateHosts,
  ].filter((h): h is string => h !== null);
  // EXPLICIT STAYS AUTHORITATIVE. An operator who sets EGRESS_ALLOWLIST means
  // that list and no other — silently unioning a template's host into it would
  // widen a security control behind their back. A template whose host is absent
  // simply fails closed at safeFetch, which is the correct and visible outcome.
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
    secretsNext: Object.freeze({
      INTERNAL: str(env, "RUNTIME_SECRET_INTERNAL_NEXT"),
      PUBLIC: str(env, "RUNTIME_SECRET_PUBLIC_NEXT"),
    }),
    modelBaseUrl,
    modelApiKey: str(env, "MODEL_API_KEY"),
    principalSigningKey: str(env, "PRINCIPAL_SIGNING_KEY"),
    principalUserKey: str(env, "PRINCIPAL_USER_KEY"),
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
    paperclipInstructionsMap: parseInstructionsMap(str(env, "PAPERCLIP_INSTRUCTIONS_MAP")),
    paperclipBoardToken: str(env, "PAPERCLIP_BOARD_TOKEN"),
    paperclipInstructionsTtlMs: int(
      env,
      "PAPERCLIP_INSTRUCTIONS_TTL_MS",
      DEFAULT_INSTRUCTIONS_TTL_MS,
    ),
    paperclipInstructionsTimeoutMs: int(
      env,
      "PAPERCLIP_INSTRUCTIONS_TIMEOUT_MS",
      DEFAULT_INSTRUCTIONS_TIMEOUT_MS,
    ),
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
      // Paperclip refuses an agent-driven `in_review` unless a review path exists
      // (routes/issues.ts:872). Assigning a named human satisfies
      // `human_assignee_user_id`. Unset means the transition will 422 and the issue
      // will stay actionable — so this is effectively required in production.
      reviewAssigneeUserId: str(env, "PAPERCLIP_REVIEW_ASSIGNEE_USER_ID") ?? null,
    }),

    conversationIssues: bool(env, "RUNTIME_CONVERSATION_ISSUES", true),

    modelProvider: str(env, "MODEL_PROVIDER") ?? deriveProvider(modelBaseUrl),
    rateOverrides: Object.freeze({
      inputPerMtokCents: price(env, "MODEL_PRICE_INPUT_PER_MTOK_CENTS"),
      cachedInputPerMtokCents: price(env, "MODEL_PRICE_CACHED_INPUT_PER_MTOK_CENTS"),
      outputPerMtokCents: price(env, "MODEL_PRICE_OUTPUT_PER_MTOK_CENTS"),
    }),
    syntheticPricing: bool(env, "RUNTIME_SYNTHETIC_PRICING", false),

    budgetEnforcement: bool(env, "RUNTIME_BUDGET_ENFORCEMENT", true),
    // NO DEFAULT, deliberately. This is the ceiling applied to any agent
    // Paperclip has no budget for, which is every newly created agent. A number
    // this file invented would be a money figure nobody decided — the same
    // fall-through that made "no budget" mean "no limit" until 2026-08-19.
    // Missing or unparseable => boot refuses (see the fatal check below).
    budgetFallbackCents: positiveIntOrNull(env, "RUNTIME_BUDGET_FALLBACK_CENTS"),
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
/**
 * FATAL configuration problems. Non-empty means the process must not start.
 *
 * Distinct from `bootWarnings` on purpose: a warning describes a service that
 * runs in a degraded but understood state, and this list describes one that
 * would run while silently deciding something it has no right to decide.
 *
 * The first entry is the budget fallback. Until 2026-08-19 an agent with no
 * Paperclip budget was treated as unlimited, so the absence of a number WAS a
 * policy — one nobody chose. Booting with an invented ceiling would repeat that
 * with a different value; booting without one would restore the hole. Refusing
 * is the only option that neither invents nor permits.
 */
export function bootErrors(config: RuntimeConfig): string[] {
  const errors: string[] = [];
  if (config.budgetEnforcement && config.budgetFallbackCents === null) {
    errors.push(
      "RUNTIME_BUDGET_FALLBACK_CENTS is unset or not a positive integer. It is the monthly ceiling applied to any agent Paperclip has no budget for — which is every newly created agent. This service will not invent a money figure: set it explicitly (owner-owned value) or disable enforcement deliberately with RUNTIME_BUDGET_ENFORCEMENT=false.",
    );
  }

  // ── ROTATION GRACE VALIDATION ─────────────────────────────────────────────
  //
  // Every way grace can be mis-configured is a BOOT REFUSAL, never a warning. A
  // half-configured overlap does not announce itself: the service starts, serves
  // normally, and fails only on the day the old credential is withdrawn — which
  // is the worst possible moment to find out.
  for (const cls of ["INTERNAL", "PUBLIC"] as Exposure[]) {
    const current = config.secrets[cls];
    const next = config.secretsNext[cls];
    if (next === null) continue;

    if (current === null) {
      errors.push(
        `RUNTIME_SECRET_${cls}_NEXT is set but RUNTIME_SECRET_${cls} is not. A grace value alone must never bring an exposure class to life: that would make the rotation credential the ONLY credential, which is the opposite of an overlap.`,
      );
    } else if (current === next) {
      errors.push(
        `RUNTIME_SECRET_${cls}_NEXT is identical to RUNTIME_SECRET_${cls}. That is not an overlap, and it hides a copy-paste mistake behind a service that still starts.`,
      );
    }

    // The boundary this service exists to enforce must survive rotation: a NEXT
    // value for one class may never also satisfy the other.
    const other: Exposure = cls === "INTERNAL" ? "PUBLIC" : "INTERNAL";
    if (next === config.secrets[other] || next === config.secretsNext[other]) {
      errors.push(
        `RUNTIME_SECRET_${cls}_NEXT collides with a ${other} credential. One token would satisfy both exposure classes and the boundary would not exist.`,
      );
    }
  }

  // ── PRINCIPAL SIGNING ────────────────────────────────────────────────────
  //
  // A template that `requiresPrincipal` can only ever be served a principal the
  // gateway SIGNED. Without the key there is no way to verify one, so the rule
  // "refuse an unverified principal" would have no mechanism behind it — and a
  // rule with no mechanism is a wish. Refuse to boot instead.
  const needsPrincipal = allTemplates().filter((t) => t.requiresPrincipal === true);
  if (needsPrincipal.length > 0) {
    const key = config.principalSigningKey;
    if (key === null) {
      errors.push(
        `PRINCIPAL_SIGNING_KEY is unset, but ${needsPrincipal.map((t) => t.id).join(", ")} requires a signed principal. Without the key no principal can be verified; refusing to start rather than serve that template unauthenticated.`,
      );
    } else {
      if (key.length < MIN_PRINCIPAL_KEY_CHARS) {
        errors.push(
          `PRINCIPAL_SIGNING_KEY is shorter than ${MIN_PRINCIPAL_KEY_CHARS} characters.`,
        );
      }
      const credentials = [
        config.secrets.INTERNAL,
        config.secrets.PUBLIC,
        config.secretsNext.INTERNAL,
        config.secretsNext.PUBLIC,
      ];
      if (credentials.includes(key)) {
        errors.push(
          "PRINCIPAL_SIGNING_KEY equals a RUNTIME_SECRET_* credential. Then every holder of that credential could sign an owner principal, which is exactly what the key exists to prevent.",
        );
      }
    }
  }
  if (config.principalUserKey !== null && config.principalUserKey.length < MIN_PRINCIPAL_KEY_CHARS) {
    errors.push(`PRINCIPAL_USER_KEY is shorter than ${MIN_PRINCIPAL_KEY_CHARS} characters.`);
  }

  return errors;
}

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
  if (!config.conversationIssues) {
    warnings.push(
      "RUNTIME_CONVERSATION_ISSUES is off: a run that carries a conversation reference but no issue id has nowhere to persist its output, so it will be reported persistence_failed and no answer will be returned.",
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
  if (config.stateBackend === "file" && config.stateDir.startsWith("/tmp")) {
    warnings.push(
      "RUNTIME_STATE_DIR points at /tmp: that path does not survive a container replacement, so idempotency records, undelivered cost events and the sub-cent carry are lost on every redeploy. Point it at the persistent volume (/data/isola-runtime-state).",
    );
  }
  return warnings;
}
