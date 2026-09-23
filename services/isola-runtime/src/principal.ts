/**
 * THE VERIFIED PRINCIPAL, as the runtime receives, AUTHENTICATES and forwards it.
 *
 * dec-internal-manager-owner-instruction-authority-and-alerts-2026-09-23: the
 * acting identity comes from the verified channel and trusted server context,
 * never from message content. The internal gateway derives it AFTER its
 * allowlist admits a sender and sends it as a top-level `principal` field on
 * `POST /v1/invoke` — never inside `context`, which this service renders
 * verbatim into the model's user message.
 *
 * WHY IT IS SIGNED (Codex, PR #151)
 *   The runtime credential does not identify the gateway: RUNTIME_SECRET_INTERNAL
 *   is shared by every INTERNAL caller. An unsigned principal is therefore only
 *   a caller's assertion, and any holder of that credential could name the
 *   owner. So the gateway signs it with HMAC-SHA256 under PRINCIPAL_SIGNING_KEY,
 *   a key held ONLY by that gateway and this service. The signature covers
 *   every identity field, an `issuedAt` (unix seconds), a `nonce` that must
 *   equal the invoke's `runId`, and `contextSha256` — the hash of the exact
 *   canonical context (see `canonicalContext`) — so a signed principal cannot
 *   be edited, kept for later, moved onto another run, or attached to other
 *   text. Each nonce is accepted once per process (`PrincipalReplayGuard`).
 *
 *   An unsigned, badly signed, stale or mis-bound principal is UNVERIFIED:
 *     - a template that `requiresPrincipal` refuses it (400 principal_unverified);
 *     - every other template IGNORES it, exactly as if none had been sent.
 *
 * WHAT REACHES THE BRAIN
 *   Never the phone number. The brain gets:
 *     - `user`: HMAC-SHA256(user key, E.164) cut to 32 hex chars. KEYED, so the
 *       brain and its logs cannot enumerate phone numbers back from it the way
 *       they could from a plain hash of a ~10^10 space. Stable per person.
 *     - header `X-Isola-Principal-Channel`: the channel name.
 */
import { createHash, createHmac, hkdfSync, timingSafeEqual } from "node:crypto";

export interface VerifiedPrincipal {
  channel: "whatsapp";
  senderE164: string;
  verifiedBy: "gateway-allowlist";
  bindingKey: string;
}

/** The wire form: the identity plus the fields that authenticate it. */
export interface PrincipalClaim extends VerifiedPrincipal {
  issuedAt: number | null;
  nonce: string | null;
  /** sha256 (hex) of `canonicalContext(context)` — binds the principal to the text. */
  contextSha256: string | null;
  signature: string | null;
}

/**
 * THE ONE CANONICAL FORM OF THE RUN CONTEXT, shared by signer and verifier.
 *
 * `JSON.stringify` of the context value (absent -> `null`). The gateway signs
 * over this of the object it sends; the runtime recomputes it from the object
 * it PARSED. For JSON data the two are byte-identical (stringify→parse→stringify
 * is a fixed point: key order is preserved, numbers and escapes re-serialise
 * the same), and the text the runtime renders to the model
 * (`renderContext`, pretty-printed) is a pure function of the same value — so
 * a principal signed for one message cannot be attached to another.
 *
 * The gateway carries a byte-for-byte copy of this function;
 * `services/isola-gateway/test/verified-principal.test.ts` signs on the
 * gateway and verifies here to hold the two together.
 */
export function canonicalContext(context: unknown): string {
  return JSON.stringify(context === undefined ? null : context);
}

export function contextSha256(context: unknown): string {
  return createHash("sha256").update(canonicalContext(context), "utf8").digest("hex");
}

export type PrincipalParse =
  | { kind: "absent" }
  | { kind: "ok"; claim: PrincipalClaim }
  | { kind: "invalid"; reason: string };

export type PrincipalVerification =
  | { kind: "verified"; principal: VerifiedPrincipal }
  | {
      kind: "unverified";
      reason:
        | "unsigned"
        | "bad_signature"
        | "stale"
        | "nonce_mismatch"
        | "context_mismatch"
        | "no_key";
    };

const E164 = /^\+[1-9]\d{6,14}$/;
const BINDING_KEY = /^\d{1,12}\/\d{1,12}$/;
const HEX_SHA256 = /^[0-9a-f]{64}$/;
const KEYS = [
  "channel",
  "senderE164",
  "verifiedBy",
  "bindingKey",
  "issuedAt",
  "nonce",
  "contextSha256",
  "signature",
] as const;

/** Domain-separation tag for the signature. Versioned; the gateway uses the same. */
export const PRINCIPAL_SIGNATURE_VERSION = "isola-principal-v1";
/** How old (or how far in the future) a signed principal may be. */
export const PRINCIPAL_MAX_AGE_SEC = 120;
/** HKDF `info` for deriving the user-id key from the signing key. */
export const PRINCIPAL_USER_KEY_INFO = "isola-principal-user-id-v1";

export function parsePrincipal(raw: unknown): PrincipalParse {
  if (raw === undefined || raw === null) return { kind: "absent" };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { kind: "invalid", reason: "principal must be a JSON object" };
  }
  const record = raw as Record<string, unknown>;
  const extra = Object.keys(record).filter((k) => !(KEYS as readonly string[]).includes(k));
  if (extra.length > 0) {
    // Named by count, not by key: the key names are caller-supplied text.
    return { kind: "invalid", reason: `principal carries ${extra.length} unrecognised field(s)` };
  }
  if (record["channel"] !== "whatsapp") {
    return { kind: "invalid", reason: "principal.channel must be \"whatsapp\"" };
  }
  if (record["verifiedBy"] !== "gateway-allowlist") {
    return { kind: "invalid", reason: "principal.verifiedBy must be \"gateway-allowlist\"" };
  }
  const sender = record["senderE164"];
  if (typeof sender !== "string" || !E164.test(sender)) {
    return { kind: "invalid", reason: "principal.senderE164 must be an E.164 number" };
  }
  const bindingKey = record["bindingKey"];
  if (typeof bindingKey !== "string" || !BINDING_KEY.test(bindingKey)) {
    return { kind: "invalid", reason: "principal.bindingKey must be <account>/<inbox>" };
  }
  // The authenticating fields are OPTIONAL at parse time on purpose: their
  // absence means "unsigned", which is an authentication outcome, not a
  // malformed body. Present but mistyped is malformed.
  const issuedAt = record["issuedAt"];
  if (issuedAt !== undefined && !(typeof issuedAt === "number" && Number.isSafeInteger(issuedAt))) {
    return { kind: "invalid", reason: "principal.issuedAt must be an integer when present" };
  }
  const nonce = record["nonce"];
  if (nonce !== undefined && (typeof nonce !== "string" || nonce.length === 0 || nonce.length > 256)) {
    return { kind: "invalid", reason: "principal.nonce must be a non-empty string when present" };
  }
  const ctxHash = record["contextSha256"];
  if (ctxHash !== undefined && (typeof ctxHash !== "string" || !HEX_SHA256.test(ctxHash))) {
    return { kind: "invalid", reason: "principal.contextSha256 must be 64 lowercase hex chars when present" };
  }
  const signature = record["signature"];
  if (signature !== undefined && (typeof signature !== "string" || !HEX_SHA256.test(signature))) {
    return { kind: "invalid", reason: "principal.signature must be 64 lowercase hex chars when present" };
  }
  return {
    kind: "ok",
    claim: {
      channel: "whatsapp",
      senderE164: sender,
      verifiedBy: "gateway-allowlist",
      bindingKey,
      issuedAt: typeof issuedAt === "number" ? issuedAt : null,
      nonce: typeof nonce === "string" ? nonce : null,
      contextSha256: typeof ctxHash === "string" ? ctxHash : null,
      signature: typeof signature === "string" ? signature : null,
    },
  };
}

/**
 * The exact bytes signed. Newline-joined: no field can contain a newline
 * (E.164, the binding key and the fixed literals cannot; the nonce is checked
 * below), so no two distinct claims share a canonical form.
 */
export type SignableFields = VerifiedPrincipal & {
  issuedAt: number;
  nonce: string;
  contextSha256: string;
};

export function canonicalPrincipal(p: SignableFields): string {
  return [
    PRINCIPAL_SIGNATURE_VERSION,
    p.channel,
    p.senderE164,
    p.verifiedBy,
    p.bindingKey,
    String(p.issuedAt),
    p.nonce,
    p.contextSha256,
  ].join("\n");
}

export function signPrincipal(key: string, p: SignableFields): string {
  return createHmac("sha256", key).update(canonicalPrincipal(p), "utf8").digest("hex");
}

/**
 * Authenticate a parsed claim. `runId` is the invoke's own run id, which the
 * claim's nonce must equal; `context` is the run context AS RECEIVED, whose
 * canonical hash the claim must carry. `nowSec` is injected for testability.
 */
export function verifyPrincipal(
  claim: PrincipalClaim,
  args: { key: string | null; runId: string | null; nowSec: number; context: unknown },
): PrincipalVerification {
  if (args.key === null) return { kind: "unverified", reason: "no_key" };
  if (
    claim.signature === null ||
    claim.issuedAt === null ||
    claim.nonce === null ||
    claim.contextSha256 === null
  ) {
    return { kind: "unverified", reason: "unsigned" };
  }
  if (claim.nonce.includes("\n")) return { kind: "unverified", reason: "bad_signature" };
  const expected = Buffer.from(
    signPrincipal(args.key, {
      ...claim,
      issuedAt: claim.issuedAt,
      nonce: claim.nonce,
      contextSha256: claim.contextSha256,
    }),
    "hex",
  );
  const presented = Buffer.from(claim.signature, "hex");
  // Lengths are equal by the parse regex; checked anyway so timingSafeEqual
  // can never throw on a future change to the parse.
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
    return { kind: "unverified", reason: "bad_signature" };
  }
  // Freshness and binding are checked AFTER the MAC, so an unauthenticated
  // body cannot learn anything about the clock or the run from the reason.
  if (Math.abs(args.nowSec - claim.issuedAt) > PRINCIPAL_MAX_AGE_SEC) {
    return { kind: "unverified", reason: "stale" };
  }
  if (args.runId === null || claim.nonce !== args.runId) {
    return { kind: "unverified", reason: "nonce_mismatch" };
  }
  // The signed hash must be of THIS context: the same signed principal with
  // altered text is a different request, not the one the gateway vouched for.
  if (contextSha256(args.context) !== claim.contextSha256) {
    return { kind: "unverified", reason: "context_mismatch" };
  }
  return {
    kind: "verified",
    principal: {
      channel: claim.channel,
      senderE164: claim.senderE164,
      verifiedBy: claim.verifiedBy,
      bindingKey: claim.bindingKey,
    },
  };
}

/**
 * The key for the brain-facing user id: PRINCIPAL_USER_KEY when configured,
 * otherwise HKDF-SHA256 of the signing key with a distinct info string, so the
 * user-id key is never the signing key itself.
 */
export function principalUserKey(args: {
  userKey: string | null;
  signingKey: string | null;
}): Buffer | null {
  if (args.userKey !== null) return Buffer.from(args.userKey, "utf8");
  if (args.signingKey === null) return null;
  return Buffer.from(
    hkdfSync("sha256", Buffer.from(args.signingKey, "utf8"), Buffer.alloc(0), PRINCIPAL_USER_KEY_INFO, 32),
  );
}

/** Stable, keyed, non-phone id for the brain's `user` field. 32 lowercase hex chars. */
export function principalUserId(principal: VerifiedPrincipal, userKey: Buffer): string {
  return createHmac("sha256", userKey)
    .update(principal.senderE164, "utf8")
    .digest("hex")
    .slice(0, 32);
}

export const PRINCIPAL_CHANNEL_HEADER = "X-Isola-Principal-Channel";

/**
 * ONE ACCEPTANCE PER NONCE.
 *
 * A signed principal is bound to its run id and its context, but within the
 * freshness window the IDENTICAL request could still be sent twice by anyone
 * who observed it. This remembers every nonce (= run id) accepted in the last
 * `ttlMs` and refuses a second acceptance (`principal_replayed`).
 *
 * PER-PROCESS, deliberately and with a stated bound. The set lives in memory:
 * a restart or a second replica does not share it. The exposure that leaves is
 * bounded by the freshness window — a captured principal is useless after
 * PRINCIPAL_MAX_AGE_SEC whether or not this set survived — so a restart opens
 * at most one window's worth of replay for requests captured just before it.
 *
 * BOUNDED. At most `maxEntries` nonces are held. Expired entries are pruned on
 * insert; if the set is still full, the new principal is REFUSED rather than an
 * unexpired nonce forgotten (forgetting would re-open a replay). The default
 * cap (10,000 per 120s ≈ 83 owner-principal requests per second) is far above
 * the realistic rate of one person's WhatsApp line.
 */
export class PrincipalReplayGuard {
  private readonly seen = new Map<string, number>();

  constructor(
    private readonly ttlMs: number = PRINCIPAL_MAX_AGE_SEC * 1000,
    private readonly maxEntries: number = 10_000,
  ) {}

  /** Records the nonce if it is new. `replayed`: accepted before; `full`: at capacity. */
  accept(nonce: string, nowMs: number): "accepted" | "replayed" | "full" {
    const until = this.seen.get(nonce);
    if (until !== undefined && until > nowMs) return "replayed";
    if (this.seen.size >= this.maxEntries) {
      for (const [n, expiry] of this.seen) if (expiry <= nowMs) this.seen.delete(n);
      if (this.seen.size >= this.maxEntries) return "full";
    }
    this.seen.set(nonce, nowMs + this.ttlMs);
    return "accepted";
  }

  get size(): number {
    return this.seen.size;
  }
}
