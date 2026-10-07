/**
 * portClient.ts
 *
 * HTTP client for the Port.io API, hardened to be structurally READ-ONLY.
 *
 * Why this file is the security-critical one in the whole repo:
 * Even if the Port API credential handed to this server were accidentally
 * scoped with write permissions, this client will refuse to ever perform
 * a mutating call. The enforcement lives HERE, in code, not in "trust the
 * credential is read-only." See guardedRequest() below — every single
 * network call in this module funnels through it.
 *
 * Base URL:
 * Isola's Port organization is EU-hosted, so the default base URL is
 * https://api.port.io (Port's EU regional API gateway). If this server
 * is ever pointed at a US-hosted Port org, the correct base URL is
 * https://api.us.port.io — set PORT_API_BASE_URL to that value in env.
 * Do NOT guess the region; a US org calling api.port.io (or vice versa)
 * will simply fail auth/lookups against the wrong region.
 *
 * Outage / missing-credential handling:
 * PORT_CLIENT_ID / PORT_CLIENT_SECRET are expected to be ABSENT in most
 * environments this server runs in (including the one it was originally
 * built in). That is not an error condition for this module — every
 * public method degrades gracefully and returns a PortOutageResult
 * instead of throwing, so callers (src/tools.ts) can produce the
 * spec-mandated `{status:"port_unavailable_or_stale", ...}` tool output.
 */

export class ReadOnlyViolation extends Error {
  constructor(method: string, path: string) {
    super(`ReadOnlyViolation: refused ${method} ${path} — this client only permits GET, POST /v1/auth/access_token, and POST /v1/entities/search`);
    this.name = "ReadOnlyViolation";
  }
}

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface PortOutageResult {
  status: "port_unavailable_or_stale";
  detail: string;
}

export interface PortClientOptions {
  baseUrl?: string;
  clientId?: string;
  clientSecret?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** When false, never fall back to PORT_CLIENT_ID/SECRET env (stdio resolves credentials itself). Default true. */
  envFallback?: boolean;
}

const ALLOWLISTED_POST_PATHS = new Set<string>([
  "/v1/auth/access_token",
  "/v1/entities/search"
]);

/**
 * THE CHOKEPOINT.
 *
 * Every method on PortClient that wants to make a network call MUST pass
 * through this function first. It is the single place read-only-ness is
 * enforced. Do not add alternate code paths that call fetch() directly
 * elsewhere in this file or anywhere else in the codebase.
 *
 * Allowed:
 *   - any GET request (any path)
 *   - POST /v1/auth/access_token   (token exchange — not a data mutation)
 *   - POST /v1/entities/search     (Port's search endpoint is POST-shaped
 *                                    but is a read operation; this is the
 *                                    ONE allowlisted non-trivial POST)
 *
 * Anything else (PUT, PATCH, DELETE, or POST to any other path) throws
 * ReadOnlyViolation BEFORE any network call is attempted — no fetch() is
 * ever reached for a disallowed method/path combination.
 */
export function guardedRequest(method: HttpMethod, path: string): void {
  if (method === "GET") {
    return;
  }
  if (method === "POST" && ALLOWLISTED_POST_PATHS.has(path)) {
    return;
  }
  throw new ReadOnlyViolation(method, path);
}

function isOutageError(err: unknown): boolean {
  if (err instanceof ReadOnlyViolation) return false;
  return true;
}

export class PortClient {
  private baseUrl: string;
  private clientId?: string;
  private clientSecret?: string;
  private fetchImpl: typeof fetch;
  private timeoutMs: number;
  private token: string | null = null;
  private tokenExpiresAt = 0;

  constructor(opts: PortClientOptions = {}) {
    this.baseUrl = opts.baseUrl ?? process.env.PORT_API_BASE_URL ?? "https://api.port.io";
    const envFallback = opts.envFallback !== false;
    this.clientId = opts.clientId ?? (envFallback ? process.env.PORT_CLIENT_ID : undefined);
    this.clientSecret = opts.clientSecret ?? (envFallback ? process.env.PORT_CLIENT_SECRET : undefined);
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
  }

  hasCredentials(): boolean {
    return Boolean(this.clientId && this.clientSecret);
  }

  /** Low-level fetch wrapper. Always funnels through guardedRequest() first. */
  private async rawRequest(
    method: HttpMethod,
    path: string,
    opts: { query?: Record<string, string | number | undefined>; body?: unknown; auth?: boolean } = {}
  ): Promise<{ ok: true; json: unknown } | { ok: false; outage: true; detail: string }> {
    guardedRequest(method, path);

    const url = new URL(this.baseUrl.replace(/\/$/, "") + path);
    if (opts.query) {
      for (const [k, v] of Object.entries(opts.query)) {
        if (v !== undefined) url.searchParams.set(k, String(v));
      }
    }

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (opts.auth) {
      const authed = await this.ensureToken();
      if (!authed) {
        return { ok: false, outage: true, detail: "Port API unreachable; data unavailable" };
      }
      headers["Authorization"] = `Bearer ${this.token}`;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(url.toString(), {
        method,
        headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: controller.signal
      });
      clearTimeout(timer);

      if (res.status >= 500) {
        return { ok: false, outage: true, detail: "Port API unreachable; data unavailable" };
      }
      if (!res.ok) {
        // 4xx (auth failure, not found, etc.) — still treat as a graceful
        // "can't get you data right now" rather than throwing, per spec's
        // outage-handling requirement covering "creds absent or call fails."
        return { ok: false, outage: true, detail: `Port API returned ${res.status}; data unavailable` };
      }
      const json = await res.json().catch(() => null);
      return { ok: true, json };
    } catch (err) {
      clearTimeout(timer);
      if (!isOutageError(err)) throw err; // never swallow ReadOnlyViolation
      return { ok: false, outage: true, detail: "Port API unreachable; data unavailable" };
    }
  }

  /** Acquire a bearer token via POST /v1/auth/access_token. Never throws. */
  private async ensureToken(): Promise<boolean> {
    if (!this.hasCredentials()) return false;
    if (this.token && Date.now() < this.tokenExpiresAt) return true;

    const result = await this.rawRequest("POST", "/v1/auth/access_token", {
      body: { clientId: this.clientId, clientSecret: this.clientSecret },
      auth: false
    });
    if (!result.ok) return false;

    const json = result.json as { accessToken?: string; expiresIn?: number } | null;
    if (!json?.accessToken) return false;
    this.token = json.accessToken;
    this.tokenExpiresAt = Date.now() + (json.expiresIn ? json.expiresIn * 1000 : 55 * 60 * 1000);
    return true;
  }

  /** GET a single entity by blueprint + identifier. */
  async getEntity(blueprint: string, identifier: string): Promise<{ ok: true; data: unknown } | PortOutageResult> {
    const result = await this.rawRequest("GET", `/v1/blueprints/${encodeURIComponent(blueprint)}/entities/${encodeURIComponent(identifier)}`, { auth: true });
    if (!result.ok) return { status: "port_unavailable_or_stale", detail: result.detail };
    return { ok: true, data: result.json };
  }

  /** GET all entities for a blueprint (list). */
  async listEntities(blueprint: string, query?: Record<string, string | number | undefined>): Promise<{ ok: true; data: unknown } | PortOutageResult> {
    const result = await this.rawRequest("GET", `/v1/blueprints/${encodeURIComponent(blueprint)}/entities`, { auth: true, query });
    if (!result.ok) return { status: "port_unavailable_or_stale", detail: result.detail };
    return { ok: true, data: result.json };
  }

  /** POST /v1/entities/search — the one allowlisted search POST. Read-only in effect. */
  async searchEntities(body: unknown): Promise<{ ok: true; data: unknown } | PortOutageResult> {
    const result = await this.rawRequest("POST", "/v1/entities/search", { auth: true, body });
    if (!result.ok) return { status: "port_unavailable_or_stale", detail: result.detail };
    return { ok: true, data: result.json };
  }

  /** GET /v1/audit-log — best-effort, Port may not expose this; treated as outage on failure. */
  async getAuditLog(limit: number): Promise<{ ok: true; data: unknown } | PortOutageResult> {
    const result = await this.rawRequest("GET", "/v1/audit-log", { auth: true, query: { limit } });
    if (!result.ok) return { status: "port_unavailable_or_stale", detail: result.detail };
    return { ok: true, data: result.json };
  }
}

