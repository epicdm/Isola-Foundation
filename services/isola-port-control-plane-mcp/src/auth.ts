/**
 * auth.ts
 *
 * Bearer-token auth, in-memory token-bucket rate limiting, response
 * size capping, and pagination clamping for the MCP HTTP server.
 *
 * Token source: env MCP_BEARER_TOKEN. Absent by default (must be set by
 * the operator at runtime) and NEVER committed to the repo.
 */

export const MAX_RESPONSE_BYTES = 200 * 1024; // 200KB
export const DEFAULT_PAGE_LIMIT = 25;
export const MAX_PAGE_LIMIT = 100;
export const RATE_LIMIT_PER_MINUTE = 60;
export const RATE_LIMIT_WINDOW_MS = 60_000;

export function getExpectedBearerToken(): string | undefined {
  return process.env.MCP_BEARER_TOKEN;
}

export function extractBearerToken(authorizationHeader: string | null | undefined): string | null {
  if (!authorizationHeader) return null;
  const match = /^Bearer\s+(.+)$/i.exec(authorizationHeader.trim());
  return match ? match[1] : null;
}

/**
 * Returns true if the presented Authorization header carries a token that
 * matches the configured MCP_BEARER_TOKEN. If no token is configured at
 * all, auth is considered UNCONFIGURED and every request is rejected
 * (fail closed, never fail open).
 */
export function isAuthorized(authorizationHeader: string | null | undefined): boolean {
  const expected = getExpectedBearerToken();
  if (!expected) return false;
  const presented = extractBearerToken(authorizationHeader);
  if (!presented) return false;
  return timingSafeEqualString(presented, expected);
}

function timingSafeEqualString(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

/** Simple in-memory token-bucket-ish fixed-window rate limiter, per caller key. */
export class RateLimiter {
  private windows = new Map<string, { count: number; windowStart: number }>();

  constructor(
    private limit: number = RATE_LIMIT_PER_MINUTE,
    private windowMs: number = RATE_LIMIT_WINDOW_MS,
    private now: () => number = () => Date.now()
  ) {}

  /** Returns true if this call is allowed (and records it); false if rate-limited. */
  tryConsume(key: string): boolean {
    const t = this.now();
    const entry = this.windows.get(key);
    if (!entry || t - entry.windowStart >= this.windowMs) {
      this.windows.set(key, { count: 1, windowStart: t });
      return true;
    }
    if (entry.count >= this.limit) {
      return false;
    }
    entry.count += 1;
    return true;
  }

  reset(): void {
    this.windows.clear();
  }
}

export interface PaginationInput {
  limit?: number;
  cursor?: string;
  offset?: number;
}

export interface PaginationClamped {
  limit: number;
  cursor?: string;
  offset?: number;
}

/** Clamp caller-supplied pagination: default 25, hard max 100. cursor/offset pass through untouched. */
export function clampPagination(input: PaginationInput | undefined): PaginationClamped {
  const requested = input?.limit ?? DEFAULT_PAGE_LIMIT;
  const limit = Math.max(1, Math.min(requested, MAX_PAGE_LIMIT));
  return { limit, cursor: input?.cursor, offset: input?.offset };
}

export interface SizeCapResult {
  body: string;
  truncated: boolean;
}

/** Enforce the 200KB response cap. If exceeded, truncate and flag it. */
export function capResponseSize(payload: unknown, maxBytes: number = MAX_RESPONSE_BYTES): SizeCapResult {
  const json = JSON.stringify(payload);
  const byteLength = Buffer.byteLength(json, "utf8");
  if (byteLength <= maxBytes) {
    return { body: json, truncated: false };
  }
  // Truncate the raw JSON string to fit, then wrap in an explicit flag
  // object so callers know data was cut rather than silently losing tail
  // content mid-JSON.
  const truncatedRaw = json.slice(0, maxBytes);
  const wrapper = {
    truncated: true,
    note: `Response exceeded ${maxBytes} bytes and was truncated.`,
    partial: truncatedRaw
  };
  return { body: JSON.stringify(wrapper), truncated: true };
}

