/**
 * Configuration. Pure function of an environment record so tests can build a
 * config without touching process.env.
 */
import type { Exposure } from "./registry.js";
import { hostOf, parseAllowlist } from "./egress.js";

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
  paperclipRecordPath: string;
  egressAllowlist: string[];
  /** Hard ceiling on an inbound request body, in bytes. */
  maxRequestBytes: number;
}

export const DEFAULT_MODEL_BASE_URL = "https://api.deepseek.com";
export const DEFAULT_MODEL_NAME = "deepseek-chat";
export const DEFAULT_MODEL_TIMEOUT_MS = 60_000;
export const DEFAULT_RECORD_PATH = "/api/issues/{issueId}/comments";
export const DEFAULT_MAX_REQUEST_BYTES = 1024 * 1024; // 1 MiB

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

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
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
    paperclipApiKey: str(env, "PAPERCLIP_API_KEY"),
    paperclipRecordPath: str(env, "PAPERCLIP_RECORD_PATH") ?? DEFAULT_RECORD_PATH,
    egressAllowlist,
    maxRequestBytes: int(env, "RUNTIME_MAX_REQUEST_BYTES", DEFAULT_MAX_REQUEST_BYTES),
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
  return warnings;
}
