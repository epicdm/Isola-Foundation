/**
 * Credential resolution.
 *
 * There is deliberately NO single shared secret. Paperclip stores the bearer in
 * the employee's `adapterConfig.headers`, and an employee can read and PATCH its
 * own `adapterConfig`. With one secret, the INTERNAL employee could read its own
 * bearer and invoke the PUBLIC template — which would defeat the only boundary
 * this service exists to enforce.
 *
 * So each exposure class has its own bearer, and the bearer *is* the authority
 * for which class of template the caller may run. Nothing in the request body
 * can widen it.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import type { Exposure } from "./registry.js";
import type { RuntimeConfig } from "./config.js";

export type AuthResult =
  | { kind: "ok"; credentialExposure: Exposure }
  | { kind: "unauthorized" }
  | { kind: "not_configured" };

/**
 * Constant-time equality. Both sides are hashed first so the comparison is over
 * two equal-length buffers and the length of the configured secret does not leak
 * through an early return.
 */
export function constantTimeEquals(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ha, hb);
}

/** Pull the token out of an `Authorization: Bearer <token>` header. */
export function extractBearer(headerValue: string | string[] | undefined): string | null {
  const raw = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  if (typeof raw !== "string") return null;
  const match = /^Bearer[ ]+(.+)$/i.exec(raw.trim());
  if (!match) return null;
  const token = (match[1] ?? "").trim();
  return token.length === 0 ? null : token;
}

/**
 * Resolve the caller's credential exposure.
 *
 * Every configured secret is compared, always, with no early exit, so the number
 * of comparisons does not depend on which secret matched.
 */
export function resolveCredential(
  config: RuntimeConfig,
  headerValue: string | string[] | undefined,
): AuthResult {
  const internal = config.secrets.INTERNAL;
  const publicSecret = config.secrets.PUBLIC;

  if (internal === null && publicSecret === null) {
    return { kind: "not_configured" };
  }

  const token = extractBearer(headerValue);
  if (token === null) return { kind: "unauthorized" };

  const internalMatch = internal !== null && constantTimeEquals(token, internal);
  const publicMatch = publicSecret !== null && constantTimeEquals(token, publicSecret);

  // If the operator set both secrets to the same value the boundary does not
  // exist. Refuse rather than silently picking one. bootWarnings() flags this.
  if (internalMatch && publicMatch) return { kind: "unauthorized" };
  if (internalMatch) return { kind: "ok", credentialExposure: "INTERNAL" };
  if (publicMatch) return { kind: "ok", credentialExposure: "PUBLIC" };
  return { kind: "unauthorized" };
}
