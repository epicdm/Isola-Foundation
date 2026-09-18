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
 *
 * AGENT-BOUND CREDENTIALS, added to close a confirmed impersonation gap.
 * -----------------------------------------------------------------------
 * `PAPERCLIP_BUSINESS_FACTS_MAP` (instructions.ts) is an admin allowlist of which
 * (agentId, templateId) pairs may receive business facts. Proven live (isolated
 * fixtures, real HTTP `/v1/invoke`, 2026-09-17): an allowlist alone is NOT a
 * caller-to-agent binding. Two agents A and B genuinely authorized for the SAME
 * template are, before this change, distinguishable ONLY by a request-body field
 * -- the single shared PUBLIC bearer lets any caller holding it claim to be
 * EITHER, on demand, with nothing to stop it. The allowlist proves a claim is
 * well-formed; it never proves THIS caller may make it.
 *
 * The fix extends this file's own existing principle instead of inventing a new
 * one: the bearer already IS the authority for exposure class, so an agent that
 * needs to be told apart from its template-mates gets its OWN bearer, checked
 * with the exact same constant-time, no-early-exit discipline as INTERNAL/PUBLIC.
 * A caller presenting an agent-bound secret proves it specifically represents
 * that agent -- `credentialAgentId` carries that proof forward; nothing in the
 * request body ever can. A PUBLIC caller with no agent-bound secret configured
 * (or a caller using the plain shared PUBLIC secret) still works exactly as
 * before: `credentialAgentId: null`, so its claimed `body.agentId` gets no
 * business facts -- the safe, pre-existing default, not a regression.
 *
 * NOTE ON PROVENANCE: this PUBLIC-exposure half (`agentCallerSecrets`,
 * business-facts-oriented) originates on
 * `feat/isola-runtime-business-facts-connection-2026-09-17` (PR #139, isola-portal
 * -- confirmed OPEN/DRAFT, not deployed) and is reproduced here byte-for-byte
 * (module doc included) so this branch does not fork a second, divergent copy
 * of the same mechanism. PR139 is a DEPENDENCY of this branch's own
 * agent-caller-proof gate below, not a competing implementation of it — see
 * agent-caller-proof.ts's own module doc for the INTERNAL-exposure half this
 * branch adds on top, symmetrically, for the CCO template specifically.
 *
 * DELIBERATELY NOT DONE HERE: agent-bound secrets (either exposure) have no
 * rotation-grace `_NEXT` companion (unlike INTERNAL/PUBLIC). That is a real,
 * separately-schedulable gap for whoever operationalizes this, not an
 * oversight -- adding it is the same shape of change already proven safe for
 * the shared secrets, just not exercised by the question this change answers.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import type { Exposure } from "./registry.js";
import type { RuntimeConfig } from "./config.js";

export type AuthResult =
  | { kind: "ok"; credentialExposure: Exposure; credentialAgentId: string | null }
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
 * Every agent-bound secret map is checked with this same shape: compare every
 * entry unconditionally (no early exit), report a match only when EXACTLY one
 * entry matched, and surface a `>1` count separately so the caller can refuse
 * a colliding configuration outright rather than picking one.
 */
function matchAgentSecret(
  token: string,
  secrets: Readonly<Record<string, string>>,
): { matchedAgentId: string | null; matchCount: number } {
  let matchedAgentId: string | null = null;
  let matchCount = 0;
  for (const [agentId, secret] of Object.entries(secrets)) {
    if (constantTimeEquals(token, secret)) {
      matchCount++;
      matchedAgentId = agentId;
    }
  }
  return { matchedAgentId, matchCount };
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

  // AGENT-BOUND CREDENTIALS -- see the module comment. Two independent maps,
  // ONE PER EXPOSURE CLASS, the same "one map per exposure" shape the plain
  // shared secrets above already use: `agentCallerSecrets` (PR139,
  // business-facts, PUBLIC) and `internalAgentCallerSecrets` (this branch,
  // the CCO caller-proof gate, INTERNAL). Every configured value in BOTH maps
  // is still compared unconditionally.
  const { matchedAgentId: matchedPublicAgentId, matchCount: publicAgentMatchCount } = matchAgentSecret(
    token,
    config.agentCallerSecrets,
  );
  const { matchedAgentId: matchedInternalAgentId, matchCount: internalAgentMatchCount } = matchAgentSecret(
    token,
    config.internalAgentCallerSecrets,
  );
  const publicAgentMatch = publicAgentMatchCount === 1;
  const internalAgentMatch = internalAgentMatchCount === 1;

  // A NEXT value resolves to the SAME exposure as the CURRENT value beside it.
  // Grace widens nothing.
  const internalMatch = internalCurrent || internalGrace;
  const publicMatch = publicCurrent || publicGrace;

  // If a token satisfies more than one identity -- two exposure classes, two
  // different agents (in either map), or an agent secret colliding with a
  // shared class secret -- the boundary it is supposed to draw does not
  // exist. Refuse rather than silently picking one. bootErrors()
  // independently refuses the equivalent misconfiguration at startup; this is
  // the same discipline applied to the token actually presented at request
  // time.
  const distinctMatches =
    (internalMatch ? 1 : 0) + (publicMatch ? 1 : 0) + (publicAgentMatch ? 1 : 0) + (internalAgentMatch ? 1 : 0);
  if (publicAgentMatchCount > 1 || internalAgentMatchCount > 1 || distinctMatches > 1) {
    return { kind: "unauthorized" };
  }
  if (internalMatch) return { kind: "ok", credentialExposure: "INTERNAL", credentialAgentId: null };
  if (internalAgentMatch) {
    return { kind: "ok", credentialExposure: "INTERNAL", credentialAgentId: matchedInternalAgentId };
  }
  if (publicAgentMatch) return { kind: "ok", credentialExposure: "PUBLIC", credentialAgentId: matchedPublicAgentId };
  if (publicMatch) return { kind: "ok", credentialExposure: "PUBLIC", credentialAgentId: null };
  return { kind: "unauthorized" };
}
