/**
 * Configuration. A pure function of an environment record, so tests build a
 * config without touching process.env.
 *
 * Nothing here throws. Binding validation returns its errors as data;
 * `server.ts` is the only place that decides to refuse to boot.
 */
import { hostOf, parseAllowlist } from "./egress.js";
import {
  envSecretResolver,
  mergeBindingSources,
  parseBindings,
  parseOverlayBindings,
  type Binding,
  type BindingParseResult,
} from "./bindings.js";
import { isFailpointName, type FailpointName } from "./failpoint.js";
import { parseVoiceSeats, type SeatParseResult } from "./voice.js";

export interface GatewayConfig {
  port: number;

  /** Chatwoot base URL, e.g. https://isola-chat.saas00.epic.dm */
  chatwootBaseUrl: string;
  chatwootTimeoutMs: number;

  /** isola-runtime base URL on the private container network. */
  runtimeBaseUrl: string;
  runtimeInvokePath: string;
  /** Bearer presented to isola-runtime. `null` means every invocation fails closed. */
  runtimeSecret: string | null;
  runtimeTimeoutMs: number;

  /** Bearer required by `GET /v1/bindings`. `null` means that endpoint is 503. */
  adminToken: string | null;
  /**
   * ROTATION GRACE for the admin token — a SECOND accepted value.
   *
   * The admin token has more than one holder (the portal API calls this
   * service), and they are deployed independently. Without an overlap, rotating
   * it means an interval where a legitimate client is refused. Absent means
   * absent: with no NEXT configured the check behaves exactly as before.
   */
  adminTokenNext: string | null;

  egressAllowlist: string[];

  /** Hard ceiling on an inbound webhook body, in bytes. */
  maxRequestBytes: number;
  /** Replay window in seconds, applied to past AND future skew. */
  replayWindowSec: number;

  idempotencyTtlMs: number;
  idempotencyMaxEntries: number;

  /**
   * Connection string for the private durable delivery ledger. `null` means the
   * ledger is not configured, and the service refuses to boot — an ACK that is
   * not durably recorded is the exact failure this store exists to remove.
   */
  ledgerUrl: string | null;
  /**
   * How long a delivery's lease is held before the recovery sweeper may take it
   * over. Must comfortably exceed the runtime timeout, or a slow-but-healthy
   * run gets picked up twice.
   */
  ledgerLeaseMs: number;
  /** How often the recovery sweeper looks for expired leases. */
  ledgerRecoveryIntervalMs: number;
  /** Maximum deliveries recovered per sweep. */
  ledgerRecoveryBatch: number;
  /**
   * HANDBACK — how long a conversation must be IDLE before the AI takes it back.
   *
   * Measured from the LAST BUSINESS MESSAGE, never from the moment of takeover:
   * a human who is still replying keeps resetting it and is never interrupted.
   *
   * CORRECTED 2026-08-17. This previously said "the LAST MESSAGE", and the code
   * matched — it read Chatwoot's `last_activity_at`, which moves on ANY message.
   * That meant a customer asking "are you still there?" reset their own handback
   * clock: the more they chased, the longer they were ignored. Idleness is a
   * property of the side that owes a reply, so only BUSINESS turns count.
   *
   * 10 minutes matches the previous bff-v2 behaviour exactly. Restoring parity,
   * not seeking an optimum — do not tune it in the same change that ships it.
   */
  handbackIdleMs: number;
  /**
   * Whether the IDLE trigger may hand a conversation back. DEFAULT FALSE: the
   * ratified contract is explicit-only handback (a human presses "Mark as
   * pending"); idleness is not consent. `handbackIdleMs` above only matters when
   * this is true. Set GATEWAY_HANDBACK_IDLE_ENABLED=true only as a deliberate,
   * recorded decision to depart from that contract.
   */
  handbackIdleEnabled: boolean;
  handbackSweepIntervalMs: number;
  handbackSweepBatch: number;
  /** Set false ONLY for a deliberate, temporary, in-memory-only fallback. */
  ledgerRequired: boolean;

  /**
   * A named, test-only failpoint (see `src/failpoint.ts`). `null` in every
   * production deployment. `unrecognised` when the variable was set to
   * something that is not a known failpoint — refused at boot rather than
   * silently ignored, so a typo can never look like "disarmed".
   */
  failpoint: FailpointName | null | "unrecognised";

  /**
   * THE LEGACY PHRASE HEURISTIC — the fallback, and the rollback.
   *
   * `true` (the default, and every existing deployment) keeps today's behaviour
   * exactly: when a runtime returns no structured action, the agent's reply is
   * matched against `ESCALATION_PHRASES` and a match escalates.
   *
   * `false` means only a structured `action: "request_human"` can escalate.
   *
   * Note what this flag CANNOT do: it cannot cause both mechanisms to run. The
   * precedence rule in `pipeline.ts` consults the heuristic only when the
   * runtime supplied no action at all, so a structured turn is never
   * second-guessed by wording — with the flag on or off. The flag exists so a
   * staging deployment can prove the heuristic is inert rather than merely
   * unreachable, and so production can keep it until the same proof is run
   * there.
   */
  escalationPhraseHeuristic: boolean;

  applyLabels: boolean;
  applyCustomAttributes: boolean;
  answeredLabel: string | null;
  escalatedLabel: string | null;

  /** Parsed bindings, or the validation errors that must stop the boot. */
  bindings: BindingParseResult;

  /**
   * THE PAPERCLIP-GOVERNED EXECUTION PATH. DEFAULT OFF: with no agent id listed,
   * every message keeps the isola-runtime path and the host is not allowed out.
   * Enabled PER EMPLOYEE (a binding's paperclipAgentId), never globally.
   */
  paperclip: PaperclipConfig;

  // -- Personal-line voice read (read-only projection) ----------------------
  /**
   * KILL SWITCH. Defaults to FALSE, so the endpoint deploys inert and is
   * indistinguishable from an unknown route until deliberately enabled.
   */
  voiceReadEnabled: boolean;
  /** Bearer required by the personal-line read. `null` means the route is 503. */
  voiceReadToken: string | null;
  voiceRateLimit: number;
  voiceRateWindowMs: number;
  /** Magnus, the telephony authority. Never rebuilt — only read. */
  magnusBaseUrl: string | null;
  magnusApiKey: string | null;
  magnusApiSecret: string | null;
  magnusTimeoutMs: number;
  /** Parsed (tenant, member) → Magnus seat mapping. */
  voiceSeats: SeatParseResult;
}

export interface PaperclipConfig {
  /** paperclipAgentIds whose turns run through Paperclip. Empty = the path is OFF. */
  agentIds: string[];
  baseUrl: string | null;
  companyId: string | null;
  /** The credential presented to Paperclip. Its KIND is not assumed here: this is only the bearer transport. */
  bearer: string | null;
  /** Hard ceiling on the poll. Must fit inside the runtime timeout AND the ledger lease. */
  pollDeadlineMs: number;
  pollIntervalMs: number;
  requestTimeoutMs: number;
}

/** The poll ceiling, agreed with Lane A (2026-10-02): <= 80 s. */
export const MAX_PAPERCLIP_POLL_DEADLINE_MS = 80_000;
export const DEFAULT_PAPERCLIP_POLL_DEADLINE_MS = 75_000;
export const DEFAULT_PAPERCLIP_POLL_INTERVAL_MS = 1_500;
export const DEFAULT_PAPERCLIP_REQUEST_TIMEOUT_MS = 10_000;

export const DEFAULT_CHATWOOT_BASE_URL = "https://isola-chat.saas00.epic.dm";
export const DEFAULT_RUNTIME_BASE_URL = "http://isola_isola-runtime:3000";
export const DEFAULT_RUNTIME_INVOKE_PATH = "/v1/invoke";
/** Chatwoot's own webhook deadline is 5s; this is the ASYNC leg, so it may be long. */
export const DEFAULT_RUNTIME_TIMEOUT_MS = 90_000;
export const DEFAULT_CHATWOOT_TIMEOUT_MS = 15_000;
export const DEFAULT_MAX_REQUEST_BYTES = 1024 * 1024; // 1 MiB
export const DEFAULT_REPLAY_WINDOW_SEC = 300;
export const DEFAULT_IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_IDEMPOTENCY_MAX_ENTRIES = 50_000;
export const DEFAULT_ANSWERED_LABEL = "isola-ai-answered";
export const DEFAULT_ESCALATED_LABEL = "isola-ai-escalated";
/** Comfortably longer than DEFAULT_RUNTIME_TIMEOUT_MS, or a slow run is stolen. */
export const DEFAULT_LEDGER_LEASE_MS = 5 * 60 * 1000;
export const DEFAULT_LEDGER_RECOVERY_INTERVAL_MS = 60 * 1000;
export const DEFAULT_LEDGER_RECOVERY_BATCH = 20;
/** 10 minutes — the value the previous implementation used and staff behaviour
 *  was shaped around. Parity first; tune later with evidence. */
export const DEFAULT_HANDBACK_IDLE_MS = 10 * 60 * 1000;
export const DEFAULT_HANDBACK_SWEEP_INTERVAL_MS = 60 * 1000;
export const DEFAULT_HANDBACK_SWEEP_BATCH = 50;
export const DEFAULT_VOICE_RATE_LIMIT = 30;
export const DEFAULT_VOICE_RATE_WINDOW_MS = 60_000;
export const DEFAULT_MAGNUS_TIMEOUT_MS = 15_000;

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

function bool(env: EnvRecord, key: string, fallback: boolean): boolean {
  const raw = str(env, key);
  if (raw === null) return fallback;
  const v = raw.toLowerCase();
  if (["1", "true", "on", "yes", "enabled"].includes(v)) return true;
  if (["0", "false", "off", "no", "disabled"].includes(v)) return false;
  return fallback;
}

/** An explicit empty string disables the label; an unset variable takes the default. */
function label(env: EnvRecord, key: string, fallback: string): string | null {
  const raw = env[key];
  if (typeof raw !== "string") return fallback;
  const trimmed = raw.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

/**
 * An unset or empty `GATEWAY_FAILPOINT` is the only thing that means "off".
 * Anything set but unrecognised is reported as `unrecognised` so `server.ts`
 * can refuse to boot: a typo must never be indistinguishable from disarmed.
 */
function readFailpoint(env: EnvRecord): FailpointName | null | "unrecognised" {
  const raw = str(env, "GATEWAY_FAILPOINT");
  if (raw === null) return null;
  return isFailpointName(raw) ? raw : "unrecognised";
}

export function loadConfig(env: EnvRecord): GatewayConfig {
  const chatwootBaseUrl = stripTrailingSlash(
    str(env, "CHATWOOT_BASE_URL") ?? DEFAULT_CHATWOOT_BASE_URL,
  );
  const runtimeBaseUrl = stripTrailingSlash(
    str(env, "RUNTIME_BASE_URL") ?? DEFAULT_RUNTIME_BASE_URL,
  );

  // Accept MAGNUS_URL, the name actually set in the deployed environments, with
  // MAGNUS_BASE_URL as the legacy fallback — matching engines/magnus.ts.
  const magnusRaw = str(env, "MAGNUS_URL") ?? str(env, "MAGNUS_BASE_URL");
  const magnusBaseUrl = magnusRaw === null ? null : stripTrailingSlash(magnusRaw);

  // Read the kill switch BEFORE the allowlist is derived: the allowlist depends
  // on it, and the same parsed boolean is returned in the config below so the
  // two decisions cannot drift apart.
  const voiceReadEnabled = bool(env, "GATEWAY_VOICE_READ_ENABLED", false);

  const paperclipBaseRaw = str(env, "GATEWAY_PAPERCLIP_BASE_URL");
  const paperclip: PaperclipConfig = {
    agentIds: (str(env, "GATEWAY_PAPERCLIP_AGENT_IDS") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
    baseUrl: paperclipBaseRaw === null ? null : stripTrailingSlash(paperclipBaseRaw),
    companyId: str(env, "GATEWAY_PAPERCLIP_COMPANY_ID"),
    bearer: str(env, "GATEWAY_PAPERCLIP_BEARER"),
    pollDeadlineMs: int(env, "GATEWAY_PAPERCLIP_POLL_DEADLINE_MS", DEFAULT_PAPERCLIP_POLL_DEADLINE_MS),
    pollIntervalMs: int(env, "GATEWAY_PAPERCLIP_POLL_INTERVAL_MS", DEFAULT_PAPERCLIP_POLL_INTERVAL_MS),
    requestTimeoutMs: int(env, "GATEWAY_PAPERCLIP_REQUEST_TIMEOUT_MS", DEFAULT_PAPERCLIP_REQUEST_TIMEOUT_MS),
  };

  const explicitAllowlist = parseAllowlist(env["EGRESS_ALLOWLIST"]);
  const derivedAllowlist = [
    hostOf(chatwootBaseUrl),
    hostOf(runtimeBaseUrl),
    // Magnus is derived into the allowlist ONLY while the personal-line read is
    // enabled. Adding it unconditionally meant that merely LANDING this
    // disabled feature widened the gateway's permitted outbound destinations
    // wherever MAGNUS_URL was already set and EGRESS_ALLOWLIST was not — which
    // contradicts "inert if landed". A disabled feature must expand no
    // capability, egress included.
    voiceReadEnabled ? hostOf(magnusBaseUrl) : null,
    // The same stance as Magnus: a disabled path expands no capability, egress
    // included. The Paperclip host is allowed out ONLY once an employee is enabled.
    paperclip.agentIds.length > 0 ? hostOf(paperclip.baseUrl) : null,
  ].filter((h): h is string => h !== null);
  const egressAllowlist =
    explicitAllowlist.length > 0
      ? explicitAllowlist
      : Array.from(new Set(derivedAllowlist));

  return {
    port: int(env, "PORT", 3000),

    chatwootBaseUrl,
    chatwootTimeoutMs: int(env, "GATEWAY_CHATWOOT_TIMEOUT_MS", DEFAULT_CHATWOOT_TIMEOUT_MS),

    runtimeBaseUrl,
    runtimeInvokePath: str(env, "RUNTIME_INVOKE_PATH") ?? DEFAULT_RUNTIME_INVOKE_PATH,
    // THE CREDENTIAL THIS GATEWAY PRESENTS, and it decides what it may invoke.
    //
    // The runtime treats the credential as the authority on exposure class:
    // "the credential remains the thing that actually decides; the body can only
    // narrow, never widen". A gateway holding the PUBLIC secret can invoke only
    // PUBLIC templates, and one holding the INTERNAL secret only INTERNAL ones.
    //
    // `RUNTIME_SECRET` is the neutral name and wins. `RUNTIME_SECRET_PUBLIC`
    // remains for the existing public deployment. The rename exists because the
    // internal gateway would otherwise be configured through a variable called
    // PUBLIC while presenting the internal credential — a name that lies to the
    // next reader about which side of the boundary the service is on.
    runtimeSecret: str(env, "RUNTIME_SECRET") ?? str(env, "RUNTIME_SECRET_PUBLIC"),
    runtimeTimeoutMs: int(env, "GATEWAY_RUNTIME_TIMEOUT_MS", DEFAULT_RUNTIME_TIMEOUT_MS),

    adminToken: str(env, "GATEWAY_ADMIN_TOKEN"),
    adminTokenNext: str(env, "GATEWAY_ADMIN_TOKEN_NEXT"),

    egressAllowlist,

    maxRequestBytes: int(env, "GATEWAY_MAX_REQUEST_BYTES", DEFAULT_MAX_REQUEST_BYTES),
    replayWindowSec: int(env, "GATEWAY_REPLAY_WINDOW_SEC", DEFAULT_REPLAY_WINDOW_SEC),

    idempotencyTtlMs: int(env, "GATEWAY_IDEMPOTENCY_TTL_MS", DEFAULT_IDEMPOTENCY_TTL_MS),
    idempotencyMaxEntries: int(
      env,
      "GATEWAY_IDEMPOTENCY_MAX_ENTRIES",
      DEFAULT_IDEMPOTENCY_MAX_ENTRIES,
    ),

    ledgerUrl: str(env, "GATEWAY_LEDGER_URL"),
    ledgerLeaseMs: int(env, "GATEWAY_LEDGER_LEASE_MS", DEFAULT_LEDGER_LEASE_MS),
    ledgerRecoveryIntervalMs: int(
      env,
      "GATEWAY_LEDGER_RECOVERY_INTERVAL_MS",
      DEFAULT_LEDGER_RECOVERY_INTERVAL_MS,
    ),
    handbackIdleMs: int(
      env,
      "GATEWAY_HANDBACK_IDLE_MS",
      DEFAULT_HANDBACK_IDLE_MS,
    ),
    handbackIdleEnabled: bool(env, "GATEWAY_HANDBACK_IDLE_ENABLED", false),
    handbackSweepIntervalMs: int(
      env,
      "GATEWAY_HANDBACK_SWEEP_INTERVAL_MS",
      DEFAULT_HANDBACK_SWEEP_INTERVAL_MS,
    ),
    handbackSweepBatch: int(
      env,
      "GATEWAY_HANDBACK_SWEEP_BATCH",
      DEFAULT_HANDBACK_SWEEP_BATCH,
    ),
    ledgerRecoveryBatch: int(
      env,
      "GATEWAY_LEDGER_RECOVERY_BATCH",
      DEFAULT_LEDGER_RECOVERY_BATCH,
    ),
    ledgerRequired: bool(env, "GATEWAY_LEDGER_REQUIRED", true),

    failpoint: readFailpoint(env),

    // Defaults TRUE so no existing deployment changes behaviour on upgrade.
    escalationPhraseHeuristic: bool(env, "GATEWAY_ESCALATION_PHRASE_HEURISTIC", true),
    applyLabels: bool(env, "GATEWAY_APPLY_LABELS", true),
    applyCustomAttributes: bool(env, "GATEWAY_APPLY_CUSTOM_ATTRIBUTES", true),
    answeredLabel: label(env, "GATEWAY_LABEL_ANSWERED", DEFAULT_ANSWERED_LABEL),
    escalatedLabel: label(env, "GATEWAY_LABEL_ESCALATED", DEFAULT_ESCALATED_LABEL),

    // The boot bundle first, then the OPTIONAL additive overlay. With no
    // overlay configured this is byte-for-byte the previous behaviour: the
    // overlay parses to zero bindings and the merge returns the base list.
    // An overlay record may only ADD — colliding on tenantId or on the
    // (account, inbox) routing key refuses startup rather than replacing a
    // live binding.
    bindings: mergeBindingSources(
      parseBindings(env["GATEWAY_BINDINGS_JSON"]),
      parseOverlayBindings(env["GATEWAY_BINDINGS_OVERLAY_JSON"], envSecretResolver(env)),
    ),

    paperclip,

    // The SAME boolean the egress derivation above used. Do not re-read it.
    voiceReadEnabled,
    voiceReadToken: str(env, "GATEWAY_VOICE_READ_TOKEN"),
    voiceRateLimit: int(env, "GATEWAY_VOICE_RATE_LIMIT", DEFAULT_VOICE_RATE_LIMIT),
    voiceRateWindowMs: int(env, "GATEWAY_VOICE_RATE_WINDOW_MS", DEFAULT_VOICE_RATE_WINDOW_MS),
    magnusBaseUrl: magnusBaseUrl,
    magnusApiKey: str(env, "MAGNUS_API_KEY"),
    magnusApiSecret: str(env, "MAGNUS_API_SECRET"),
    magnusTimeoutMs: int(env, "GATEWAY_MAGNUS_TIMEOUT_MS", DEFAULT_MAGNUS_TIMEOUT_MS),
    voiceSeats: parseVoiceSeats(env["GATEWAY_VOICE_SEATS_JSON"]),
  };
}

/** The bindings, or an empty list when validation failed. */
export function configuredBindings(config: GatewayConfig): Binding[] {
  return config.bindings.ok ? config.bindings.bindings : [];
}

/** Every label this gateway is approved to apply. */
export function approvedLabels(config: GatewayConfig, binding?: Binding): string[] {
  const out = [config.answeredLabel, config.escalatedLabel].filter(
    (l): l is string => l !== null,
  );
  if (binding?.labels !== undefined) out.push(...binding.labels);
  return out;
}

/**
 * Boot-time warnings. Category strings only — never a value. `server.ts` logs
 * these once at boot.
 */
/**
 * FATAL boot conditions. The service must EXIT NON-ZERO on any of these.
 *
 * This function did not exist before rotation grace was added, and adding it was
 * part of the work rather than an afterthought: a rule that says "refuse" needs
 * a mechanism that CAN refuse. Warnings were the only thing here, and a warning
 * is not a refusal.
 */
export function bootErrors(config: GatewayConfig): string[] {
  const errors: string[] = [];

  if (config.adminTokenNext !== null) {
    if (config.adminToken === null) {
      errors.push(
        "GATEWAY_ADMIN_TOKEN_NEXT is set but GATEWAY_ADMIN_TOKEN is not. A grace value alone must never be the only accepted credential — that is a rotation with nothing to roll back to.",
      );
    } else if (config.adminToken === config.adminTokenNext) {
      errors.push(
        "GATEWAY_ADMIN_TOKEN_NEXT is identical to GATEWAY_ADMIN_TOKEN. That is not an overlap, and it hides a copy-paste mistake behind a service that still starts.",
      );
    }
  }

  errors.push(...paperclipBootErrors(config));

  return errors;
}

/**
 * The Paperclip path is OFF unless an employee is listed. Once it is on, a
 * misconfiguration REFUSES to boot: a poll that can outlive the ledger lease would
 * let the recovery sweeper take a delivery that is still running (two replies), and
 * a missing credential would turn every turn into an escalation. Names only; never a value.
 */
function paperclipBootErrors(config: GatewayConfig): string[] {
  const p = config.paperclip;
  if (p.agentIds.length === 0) return [];
  const errors: string[] = [];
  if (p.baseUrl === null || hostOf(p.baseUrl) === null) {
    errors.push("GATEWAY_PAPERCLIP_AGENT_IDS is set but GATEWAY_PAPERCLIP_BASE_URL is missing or not a URL.");
  }
  if (p.companyId === null) {
    errors.push("GATEWAY_PAPERCLIP_AGENT_IDS is set but GATEWAY_PAPERCLIP_COMPANY_ID is missing.");
  }
  if (p.bearer === null) {
    errors.push("GATEWAY_PAPERCLIP_AGENT_IDS is set but GATEWAY_PAPERCLIP_BEARER (the credential) is missing.");
  }
  if (p.pollDeadlineMs > MAX_PAPERCLIP_POLL_DEADLINE_MS) {
    errors.push(`GATEWAY_PAPERCLIP_POLL_DEADLINE_MS exceeds the ${MAX_PAPERCLIP_POLL_DEADLINE_MS} ms ceiling.`);
  }
  if (p.pollDeadlineMs >= config.runtimeTimeoutMs) {
    errors.push("GATEWAY_PAPERCLIP_POLL_DEADLINE_MS must be inside GATEWAY_RUNTIME_TIMEOUT_MS.");
  }
  if (p.pollDeadlineMs >= config.ledgerLeaseMs) {
    errors.push("GATEWAY_PAPERCLIP_POLL_DEADLINE_MS must be inside GATEWAY_LEDGER_LEASE_MS, or the recovery sweeper can take a delivery that is still running.");
  }
  return errors;
}

export function bootWarnings(config: GatewayConfig): string[] {
  const warnings: string[] = [];
  const bindings = configuredBindings(config);

  if (!config.bindings.ok) {
    warnings.push(
      "GATEWAY_BINDINGS_JSON failed validation: the service will refuse to start.",
    );
  } else if (bindings.length === 0) {
    warnings.push(
      "GATEWAY_BINDINGS_JSON is unset or empty: no inbox is bound, so every webhook will be rejected as unverifiable (fail closed).",
    );
  }

  if (bindings.length > 0 && bindings.every((b) => b.status !== "active")) {
    warnings.push(
      "Every configured binding is retired: signed deliveries will verify and then be declined.",
    );
  }

  // A binding may name its own Chatwoot (multi-tenant: a tenant brings its own).
  // That host still has to be on the egress allowlist, and the moment to find
  // out is boot, not the first customer message — an unallowlisted host makes
  // every outbound call for that tenant fail closed, which reads as an outage
  // rather than as the one-line configuration mistake it is.
  for (const binding of bindings) {
    if (binding.chatwootBaseUrl === undefined) continue;
    const host = hostOf(binding.chatwootBaseUrl);
    if (host === null) continue; // refused already by parseBindings
    if (!config.egressAllowlist.includes(host)) {
      warnings.push(
        `Binding ${binding.tenantId} (${binding.chatwootAccountId}/${binding.chatwootInboxId}) ` +
          `names Chatwoot host "${host}", which is NOT on EGRESS_ALLOWLIST: every reply, note ` +
          `and assignment for that tenant will be blocked before it leaves this process.`,
      );
    }
  }

  if (config.runtimeSecret === null) {
    warnings.push(
      "RUNTIME_SECRET_PUBLIC is unset: every invocation fails closed, so every conversation will be escalated to a human instead of answered.",
    );
  }
  if (config.adminToken === null) {
    warnings.push("GATEWAY_ADMIN_TOKEN is unset: GET /v1/bindings will return 503.");
  }
  if (config.egressAllowlist.length === 0) {
    warnings.push("EGRESS_ALLOWLIST resolved empty: every outbound call will be blocked.");
  }
  if (hostOf(config.chatwootBaseUrl) === null) {
    warnings.push("CHATWOOT_BASE_URL is not a valid URL: no reply can ever be delivered.");
  }
  if (hostOf(config.runtimeBaseUrl) === null) {
    warnings.push("RUNTIME_BASE_URL is not a valid URL: the runtime can never be reached.");
  }

  if (config.ledgerUrl === null) {
    warnings.push(
      config.ledgerRequired
        ? "GATEWAY_LEDGER_URL is unset: the durable delivery ledger cannot be reached, so an acknowledged webhook could not be recorded. The service will refuse to start."
        : "GATEWAY_LEDGER_URL is unset and GATEWAY_LEDGER_REQUIRED is false: de-duplication is in memory only and will NOT survive a container replacement.",
    );
  }
  if (config.voiceReadEnabled) {
    if (config.voiceReadToken === null) {
      warnings.push(
        "GATEWAY_VOICE_READ_ENABLED is on but GATEWAY_VOICE_READ_TOKEN is unset: the personal-line read will return 503.",
      );
    }
    if (config.magnusBaseUrl === null) {
      warnings.push(
        "GATEWAY_VOICE_READ_ENABLED is on but MAGNUS_URL is unset: the personal-line read cannot reach the telephony authority.",
      );
    }
    if (config.magnusApiKey === null || config.magnusApiSecret === null) {
      warnings.push(
        "GATEWAY_VOICE_READ_ENABLED is on but MAGNUS_API_KEY/MAGNUS_API_SECRET are unset: every seat read fails closed.",
      );
    }
    if (!config.voiceSeats.ok) {
      warnings.push(
        "GATEWAY_VOICE_SEATS_JSON failed validation: no seat resolves, so every personal-line read returns 404 (fail closed).",
      );
    } else if (config.voiceSeats.seats.length === 0) {
      warnings.push(
        "GATEWAY_VOICE_SEATS_JSON is unset or empty: every personal-line read returns 404.",
      );
    }
  }
  if (config.failpoint === "unrecognised") {
    warnings.push(
      "GATEWAY_FAILPOINT is set to a value that is not a known failpoint. The service will refuse to start rather than run with a typo that looks disarmed.",
    );
  } else if (config.failpoint !== null) {
    warnings.push(
      `GATEWAY_FAILPOINT is ARMED (${config.failpoint}). This is a TEST-ONLY build configuration: the process will deliberately terminate mid-delivery. It must never be set on a production deployment.`,
    );
  }
  if (config.ledgerLeaseMs <= config.runtimeTimeoutMs) {
    warnings.push(
      "GATEWAY_LEDGER_LEASE_MS is not longer than the runtime timeout: a slow but healthy run can have its lease stolen and be processed twice.",
    );
  }

  return warnings;
}
