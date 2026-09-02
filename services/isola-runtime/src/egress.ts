/**
 * THE ONLY MODULE IN THIS SERVICE ALLOWED TO TOUCH THE NETWORK.
 *
 * Everything outbound goes through `safeFetch`. Any hostname not on the
 * allowlist throws `EgressBlockedError` before a socket is opened.
 *
 * `test/no-direct-network.test.ts` asserts by source scan that the token
 * `fetch(` appears nowhere in `src/` except in this file. Do not add a direct
 * network call anywhere else, and do not rename this module's use of
 * `globalThis.fetch` in a way that defeats that scan.
 */
import { EgressBlockedError } from "./errors.js";

export type SafeFetch = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

/** Underlying transport. Injectable so tests never open a real socket. */
export type FetchLike = SafeFetch;

export interface SafeFetchOptions {
  /** Lower-cased hostnames permitted for outbound requests. */
  allowlist: readonly string[];
  /** Transport. Defaults to the platform fetch. */
  transport?: FetchLike;
}

export function normaliseHost(host: string): string {
  return host.trim().toLowerCase();
}

/** Parse an allowlist env value ("a.example, b.example") into hostnames. */
export function parseAllowlist(raw: string | undefined | null): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((entry) => normaliseHost(entry))
    .filter((entry) => entry.length > 0);
}

/** Extract the hostname from a URL string, or null if it is not a URL. */
export function hostOf(url: string | undefined | null): string | null {
  if (!url) return null;
  try {
    return normaliseHost(new URL(url).hostname);
  } catch {
    return null;
  }
}

export function isAllowedHost(
  host: string,
  allowlist: readonly string[],
): boolean {
  const candidate = normaliseHost(host);
  if (candidate.length === 0) return false;
  // Exact hostname match only. No suffix matching: "evil-deepseek.com" must not
  // be admitted by an allowlist entry of "deepseek.com".
  return allowlist.some((entry) => normaliseHost(entry) === candidate);
}

/**
 * Build the single outbound network primitive for this service.
 * Only http/https are permitted; every other scheme is blocked outright.
 */
export function createSafeFetch(options: SafeFetchOptions): SafeFetch {
  const allowlist = options.allowlist.map(normaliseHost).filter((h) => h.length > 0);
  const transport: FetchLike =
    options.transport ??
    ((input, init) => globalThis.fetch(input as string | URL, init));

  return async function safeFetch(input, init) {
    const raw = typeof input === "string" ? input : input.toString();
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      throw new EgressBlockedError("<unparseable-url>");
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new EgressBlockedError(`${parsed.protocol}//${parsed.hostname}`);
    }
    const host = normaliseHost(parsed.hostname);
    if (!isAllowedHost(host, allowlist)) {
      throw new EgressBlockedError(host);
    }
    return transport(parsed.toString(), init);
  };
}

export { EgressBlockedError };
