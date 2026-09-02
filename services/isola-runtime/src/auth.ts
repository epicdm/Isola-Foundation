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
  // ROTATION GRACE. A second accepted value per class, so the sender and the
   // receiver can be rolled separately without an interval where they disagree.
  const internalNext = config.secretsNext.INTERNAL;
  const publicNext = config.secretsNext.PUBLIC;

  // Keyed on the CURRENT secrets only. A NEXT value alone must never bring a
  // class to life — bootErrors() refuses that configuration outright.
  if (internal === null && publicSecret === null) {
    return { kind: "not_configured" };
  }

  const token = extractBearer(headerValue);
  if (token === null) return { kind: "unauthorized" };

  // Still no early exit: every configured value is compared, every time, so the
  // number of comparisons does not reveal which one matched.
  const internalCurrent = internal !== null && constantTimeEquals(token, internal);
  const internalGrace = internalNext !== null && constantTimeEquals(token, internalNext);
  const publicCurrent = publicSecret !== null && constantTimeEquals(token, publicSecret);
  const publicGrace = publicNext !== null && constantTimeEquals(token, publicNext);

  // A NEXT value resolves to the SAME exposure as the CURRENT value beside it.
  // Grace widens nothing.
  const internalMatch = internalCurrent || internalGrace;
  const publicMatch = publicCurrent || publicGrace;

  // If one token satisfies both classes the boundary does not exist. Refuse
  // rather than silently picking one. This now also catches a NEXT value that
  // collides with the other class, which is the way grace could have quietly
  // dissolved the boundary. bootErrors() refuses that config at startup too.
  if (internalMatch && publicMatch) return { kind: "unauthorized" };
  if (internalMatch) return { kind: "ok", credentialExposure: "INTERNAL" };
  if (publicMatch) return { kind: "ok", credentialExposure: "PUBLIC" };
  return { kind: "unauthorized" };
}
