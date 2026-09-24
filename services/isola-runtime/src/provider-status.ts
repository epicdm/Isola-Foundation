/**
 * Provider status: "can the DEFAULT brain actually answer right now?"
 *
 * WHY THIS EXISTS. The public front desk (3742/6737) calls the default provider
 * with this service's own MODEL_API_KEY. When that account ran out of credit
 * every customer reply failed with provider HTTP 402 for days and nothing
 * alerted (def-public-customer-path-has-no-model-balance-guard-2026-08-24).
 * Nobody could check the account without reading the key, and the only process
 * that legitimately holds the key is this one — so this one answers.
 *
 * Scope is deliberately narrow:
 *  - the DEFAULT brain only (config.modelBaseUrl + config.modelApiKey). A
 *    template's own override brain is not checked here.
 *  - DeepSeek's documented balance API: GET <origin>/user/balance, returning
 *    `{is_available, balance_infos:[{currency,total_balance,...}]}`.
 *  - every request goes through the injected SafeFetch, so the egress allowlist
 *    applies exactly as it does to a model call.
 *
 * What leaves this module is SANITIZED: availability, currency and total, an
 * HTTP status and a category. Never the key, never a header, never the raw
 * provider body.
 *
 * Fail closed: anything this module cannot positively parse as "available" is
 * reported as `check_failed` with `available: null` — never `available: true`.
 */
import type { SafeFetch } from "./egress.js";
import { EgressBlockedError, hostOf } from "./egress.js";
import type { Logger } from "./log.js";

export type ProviderStatusKind = "ok" | "unavailable" | "check_failed" | "not_configured";

export interface ProviderBalance {
  currency: string;
  total: string;
}

export interface ProviderStatusResult {
  provider: string;
  checkedAt: string;
  available: boolean | null;
  balances: ProviderBalance[];
  status: ProviderStatusKind;
  httpStatus?: number;
  failureCategory?: string;
}

export const PROVIDER_STATUS_CACHE_MS = 60_000;
export const PROVIDER_STATUS_TIMEOUT_MS = 10_000;

/** The balance endpoint lives at the ORIGIN, not under any `/v1` path suffix. */
export function balanceUrl(modelBaseUrl: string): string | null {
  try {
    return `${new URL(modelBaseUrl).origin}/user/balance`;
  } catch {
    return null;
  }
}

const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const AMOUNT_PATTERN = /^-?\d{1,15}(\.\d{1,8})?$/;

function parseAmount(raw: unknown): string | null {
  if (typeof raw === "number" && Number.isFinite(raw)) return String(raw);
  if (typeof raw === "string" && AMOUNT_PATTERN.test(raw.trim())) return raw.trim();
  return null;
}

/**
 * Parse the provider body into `{available, balances}` or null. Null means the
 * shape is not the documented one, and the caller reports `check_failed`. Every
 * field is validated — a currency that is not three capital letters, or an
 * amount that is not a plain number, rejects the whole body rather than being
 * echoed back.
 */
export function parseBalanceBody(
  payload: unknown,
): { available: boolean; balances: ProviderBalance[] } | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  const body = payload as Record<string, unknown>;
  const available = body["is_available"];
  if (typeof available !== "boolean") return null;
  const infos = body["balance_infos"];
  if (!Array.isArray(infos)) return null;
  const balances: ProviderBalance[] = [];
  for (const info of infos) {
    if (typeof info !== "object" || info === null) return null;
    const entry = info as Record<string, unknown>;
    const currency = entry["currency"];
    if (typeof currency !== "string" || !CURRENCY_PATTERN.test(currency)) return null;
    const total = parseAmount(entry["total_balance"]);
    if (total === null) return null;
    balances.push({ currency, total });
  }
  return { available, balances };
}

export interface ProviderStatusOptions {
  provider: string;
  modelBaseUrl: string;
  apiKey: string | null;
  safeFetch: SafeFetch;
  logger: Logger;
  now: () => number;
  cacheMs?: number;
  timeoutMs?: number;
}

export interface ProviderStatusChecker {
  /** Cached: at most one provider request per cache window, shared by concurrent callers. */
  check(): Promise<ProviderStatusResult>;
}

export function createProviderStatusChecker(
  options: ProviderStatusOptions,
): ProviderStatusChecker {
  const cacheMs = options.cacheMs ?? PROVIDER_STATUS_CACHE_MS;
  const timeoutMs = options.timeoutMs ?? PROVIDER_STATUS_TIMEOUT_MS;
  let cached: { at: number; result: ProviderStatusResult } | null = null;
  let inFlight: Promise<ProviderStatusResult> | null = null;

  const base = (status: ProviderStatusKind): ProviderStatusResult => ({
    provider: options.provider,
    checkedAt: new Date(options.now()).toISOString(),
    available: null,
    balances: [],
    status,
  });

  const failed = (failureCategory: string, httpStatus?: number): ProviderStatusResult => ({
    ...base("check_failed"),
    ...(httpStatus === undefined ? {} : { httpStatus }),
    failureCategory,
  });

  async function probe(): Promise<ProviderStatusResult> {
    if (options.apiKey === null) {
      return { ...base("not_configured"), failureCategory: "model_api_key_unset" };
    }
    const url = balanceUrl(options.modelBaseUrl);
    if (url === null) return failed("invalid_model_base_url");

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    if (typeof timer.unref === "function") timer.unref();

    try {
      let response: Response;
      try {
        response = await options.safeFetch(url, {
          method: "GET",
          headers: {
            accept: "application/json",
            authorization: `Bearer ${options.apiKey}`,
          },
          signal: controller.signal,
        });
      } catch (err) {
        if (err instanceof EgressBlockedError) return failed("egress_blocked");
        if (timedOut) return failed("timeout");
        // Category only: a transport error message can carry a URL.
        return failed("network_error");
      }

      // 402 is DeepSeek's "Insufficient Balance" — the exact outage this exists
      // to catch. It is a definite answer, not a failed check.
      if (!response.ok) {
        // The error body is never read: it is not part of the result, and it
        // could echo request material. Release the stream instead.
        void response.body?.cancel().catch(() => undefined);
      }
      if (response.status === 402) {
        return {
          ...base("unavailable"),
          available: false,
          httpStatus: 402,
          failureCategory: "insufficient_balance",
        };
      }
      if (!response.ok) {
        const category =
          response.status === 401 || response.status === 403
            ? "provider_auth_rejected"
            : "provider_http_error";
        return failed(category, response.status);
      }

      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        if (timedOut) return failed("timeout", response.status);
        return failed("non_json_body", response.status);
      }
      const parsed = parseBalanceBody(payload);
      if (parsed === null) return failed("unexpected_shape", response.status);

      return {
        ...base(parsed.available ? "ok" : "unavailable"),
        available: parsed.available,
        balances: parsed.balances,
        httpStatus: response.status,
        ...(parsed.available ? {} : { failureCategory: "is_available_false" }),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async function runAndRecord(): Promise<ProviderStatusResult> {
    let result: ProviderStatusResult;
    try {
      result = await probe();
    } catch {
      result = failed("internal_error");
    }
    cached = { at: options.now(), result };
    const fields = {
      event: "provider_status",
      outcome: result.status,
      provider: result.provider,
      available: result.available,
      balances: result.balances.map((b) => `${b.currency} ${b.total}`),
      httpStatus: result.httpStatus ?? null,
      failureCategory: result.failureCategory ?? null,
    };
    if (result.status === "ok") options.logger.info(fields);
    else options.logger.warn(fields);
    return result;
  }

  return {
    check(): Promise<ProviderStatusResult> {
      if (cached !== null && options.now() - cached.at < cacheMs) {
        return Promise.resolve(cached.result);
      }
      if (inFlight !== null) return inFlight;
      inFlight = runAndRecord().finally(() => {
        inFlight = null;
      });
      return inFlight;
    },
  };
}

// ── MONITORING PUSH ──────────────────────────────────────────────────────────

function displayName(provider: string): string {
  return provider.toLowerCase() === "deepseek" ? "DeepSeek" : provider;
}

function balanceText(balances: readonly ProviderBalance[]): string {
  return balances.map((b) => `${b.currency} ${b.total}`).join(", ");
}

/** One short human sentence for the monitor. Contains no credential material. */
export function pushMessage(result: ProviderStatusResult): string {
  const name = displayName(result.provider);
  switch (result.status) {
    case "ok":
      return result.balances.length > 0
        ? `${name} available, balance ${balanceText(result.balances)}`
        : `${name} available`;
    case "unavailable": {
      // Only what was actually observed: a 402 never read `is_available`, so it
      // must not claim it.
      const reasons: string[] = [];
      if (result.httpStatus !== undefined && result.httpStatus !== 200) {
        reasons.push(String(result.httpStatus));
      }
      if (result.failureCategory === "is_available_false") {
        reasons.push("is_available=false");
      }
      const suffix = result.balances.length > 0 ? `, balance ${balanceText(result.balances)}` : "";
      return `${name} UNAVAILABLE (${reasons.join("/")})${suffix}`;
    }
    case "not_configured":
      return `${name} status NOT CONFIGURED (MODEL_API_KEY unset)`;
    default:
      return `${name} status CHECK FAILED (${result.failureCategory ?? "unknown"}${
        result.httpStatus !== undefined ? `/${result.httpStatus}` : ""
      })`;
  }
}

/**
 * Build the Uptime Kuma push request URL. The configured URL is a SECRET (its
 * path carries the push token), so it is never logged — only its host is.
 * Returns null when the configured value is not an http(s) URL.
 */
export function buildPushUrl(pushUrl: string, result: ProviderStatusResult): string | null {
  let url: URL;
  try {
    url = new URL(pushUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  url.searchParams.set("status", result.available === true ? "up" : "down");
  url.searchParams.set("msg", pushMessage(result));
  url.searchParams.delete("ping");
  return url.toString();
}

export interface PushOptions {
  pushUrl: string;
  safeFetch: SafeFetch;
  logger: Logger;
  timeoutMs?: number;
}

/** Push one result. Never throws; logs the push HOST and an outcome only. */
export async function pushProviderStatus(
  result: ProviderStatusResult,
  options: PushOptions,
): Promise<boolean> {
  const pushHost = hostOf(options.pushUrl);
  const target = buildPushUrl(options.pushUrl, result);
  const pushed = result.available === true ? "up" : "down";
  if (target === null) {
    options.logger.warn({
      event: "provider_status_push",
      outcome: "push_invalid_url",
      pushHost,
    });
    return false;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? PROVIDER_STATUS_TIMEOUT_MS);
  if (typeof timer.unref === "function") timer.unref();
  try {
    const response = await options.safeFetch(target, {
      method: "GET",
      signal: controller.signal,
    });
    const ok = response.ok;
    const fields = {
      event: "provider_status_push",
      outcome: ok ? "push_ok" : "push_failed",
      pushHost,
      pushed,
      httpStatus: response.status,
    };
    if (ok) options.logger.info(fields);
    else options.logger.warn(fields);
    return ok;
  } catch (err) {
    options.logger.warn({
      event: "provider_status_push",
      outcome: err instanceof EgressBlockedError ? "push_egress_blocked" : "push_failed",
      pushHost,
      pushed,
      detail: err instanceof EgressBlockedError ? "push host is not in EGRESS_ALLOWLIST" : "transport failure",
    });
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export interface MonitorOptions {
  checker: ProviderStatusChecker;
  intervalMs: number;
  pushUrl: string | null;
  safeFetch: SafeFetch;
  logger: Logger;
}

/**
 * Optional periodic self-check. Off unless an interval is configured. Without a
 * push URL it still checks (so the log line exists) but pushes nothing. The
 * timer is unref'd and never keeps the process alive. Returns a stop function.
 */
export function startProviderStatusMonitor(options: MonitorOptions): () => void {
  if (!(options.intervalMs > 0)) return () => undefined;
  const tick = async (): Promise<void> => {
    const result = await options.checker.check();
    if (options.pushUrl !== null) {
      await pushProviderStatus(result, {
        pushUrl: options.pushUrl,
        safeFetch: options.safeFetch,
        logger: options.logger,
      });
    }
  };
  const run = (): void => {
    void tick().catch(() => undefined);
  };
  run();
  const timer = setInterval(run, options.intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  return () => clearInterval(timer);
}
