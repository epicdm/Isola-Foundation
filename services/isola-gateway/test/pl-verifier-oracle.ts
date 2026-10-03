/**
 * TEST ORACLE: the DEPLOYED bff-v2 pl-concierge assertion verifier, ported for offline use.
 *
 * SOURCE (read-only, 2026-10-03):
 *   file     /opt/bff-v2/app/lib/pl-concierge/assertion.ts (on deepseek)
 *   deployed bff-v2 HEAD d736dbf3ae0fde9f98b18eaa116ce4f9214eeb40 (PR #277 build)
 *   last commit touching the file 8db806aaed16f7d2aff2ae8d1a9530bd05f73c9f (2026-10-01T02:38:08Z)
 *   sha256 of the original file 9e0050cc233f2fc8c2b9ba1325b2304673adf2e61f964120b6dfb3745a9cd491
 *   (and app/lib/pl-concierge/config.ts sha256 23ee59aab4b2e53870982d9f5a3f0c2aafa296900bb46371b15432e0b2152082,
 *   read for the key/kid/pnid-allowlist rules: see `oracleConfigFromEnv` below)
 *
 * FAITHFULNESS: `verifyAssertion` and every helper it uses are the original's logic, statement for
 * statement. The ONLY edits are TYPE-LEVEL (this repo compiles with `noUncheckedIndexedAccess`): the
 * `parts` destructuring casts p and s to string after the length check, and `any` is spelled
 * `unknown`-then-narrowed where the compiler required it. No condition, order or constant was changed.
 * A drift of the real verifier from this port is possible: this is the logic AS DEPLOYED ON THE DATE
 * ABOVE, which is what lane 59 re-verifies offline against a scratch copy of the deployed file.
 *
 * What the original verifier does NOT do (so neither does this oracle): it does not track nonces (the
 * service's database does, for MUTATING operations only, contract s.3.4 step 6) and it does not rate-limit.
 * `OracleNonceStore` below models step 6 ONLY so the minter's "never reused" can be tested end to end.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export const ASSERTION_FORMAT = "v1";
export const FRESHNESS_S = 120;
export const MAX_ASSERTION_LEN = 2048;
export const MIN_KEY_BYTES = 32;

export interface OraclePayload {
  kid: string;
  wa_id: string;
  pnid: string;
  rid: string;
  mid: string;
  iat: number;
  nonce: string;
  act?: string;
  act_src?: "button" | "list" | "numbered";
}

export const ACT_SOURCES = ["button", "list", "numbered"] as const;

export type OracleFailure =
  | { ok: false; code: "bad_assertion"; detail: "flow_wiring" | "malformed" | "unknown_kid" | "bad_signature" | "bad_fields" }
  | { ok: false; code: "stale_assertion"; detail: "stale"; payload: OraclePayload }
  | { ok: false; code: "wrong_number"; detail: "pnid_not_allowed"; payload: OraclePayload }
  | { ok: false; code: "request_mismatch"; detail: "rid_mismatch"; payload: OraclePayload };

export type OracleResult = { ok: true; payload: OraclePayload } | OracleFailure;

export interface OracleVerifyOptions {
  /** kid -> key bytes (UTF-8 of the env string). Keys shorter than MIN_KEY_BYTES are ignored. */
  keys: Record<string, string>;
  pnidAllowlist: string[];
  /** Unix seconds. */
  now: number;
  conversationId: string | null | undefined;
}

const B64URL_RE = /^[A-Za-z0-9_-]+$/;
const KID_RE = /^[a-z0-9]{1,16}$/;
const WA_ID_RE = /^[1-9][0-9]{6,15}$/;
const PNID_RE = /^[0-9]{5,20}$/;
const NONCE_RE = /^[A-Za-z0-9_-]{22}$/;

export function signPayloadSegment(key: string, payloadSegment: string): string {
  return createHmac("sha256", Buffer.from(key, "utf8")).update(`${ASSERTION_FORMAT}.${payloadSegment}`, "utf8").digest("base64url");
}

export function isFlowWiringValue(raw: string | null | undefined): boolean {
  if (raw === null || raw === undefined) return true;
  const t = raw.trim();
  return t === "" || /^\$\{.*\}$/.test(t) || /^\{\{.*\}\}$/.test(t);
}

function validFields(x: unknown): x is OraclePayload {
  if (!x || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  return (
    typeof o["kid"] === "string" && KID_RE.test(o["kid"]) &&
    typeof o["wa_id"] === "string" && WA_ID_RE.test(o["wa_id"]) &&
    typeof o["pnid"] === "string" && PNID_RE.test(o["pnid"]) &&
    typeof o["rid"] === "string" && o["rid"].length > 0 && o["rid"].length <= 128 &&
    typeof o["mid"] === "string" && o["mid"].length > 0 && o["mid"].length <= 256 &&
    typeof o["iat"] === "number" && Number.isInteger(o["iat"]) &&
    typeof o["nonce"] === "string" && NONCE_RE.test(o["nonce"]) &&
    (o["act"] === undefined || (typeof o["act"] === "string" && o["act"].length > 0 && o["act"].length <= 64)) &&
    // A2: act_src is present exactly when act is, and is one of the three sources.
    (o["act"] === undefined ? o["act_src"] === undefined : (ACT_SOURCES as readonly string[]).includes(o["act_src"] as string))
  );
}

export function verifyAssertion(raw: string | null | undefined, opts: OracleVerifyOptions): OracleResult {
  if (isFlowWiringValue(raw)) return { ok: false, code: "bad_assertion", detail: "flow_wiring" };
  const value = (raw as string).trim();
  if (!value.startsWith(`${ASSERTION_FORMAT}.`)) return { ok: false, code: "bad_assertion", detail: "flow_wiring" };
  if (value.length > MAX_ASSERTION_LEN) return { ok: false, code: "bad_assertion", detail: "malformed" };
  const parts = value.split(".");
  if (parts.length !== 3 || parts[0] !== ASSERTION_FORMAT) return { ok: false, code: "bad_assertion", detail: "malformed" };
  const p = parts[1] as string;
  const s = parts[2] as string;
  if (!B64URL_RE.test(p) || !B64URL_RE.test(s) || s.length !== 43) return { ok: false, code: "bad_assertion", detail: "malformed" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(p, "base64url").toString("utf8"));
  } catch {
    return { ok: false, code: "bad_assertion", detail: "malformed" };
  }
  const kid = parsed && typeof (parsed as Record<string, unknown>)["kid"] === "string" ? ((parsed as Record<string, unknown>)["kid"] as string) : "";
  const key = Object.prototype.hasOwnProperty.call(opts.keys, kid) ? opts.keys[kid] : undefined;
  if (!key || Buffer.byteLength(key, "utf8") < MIN_KEY_BYTES) return { ok: false, code: "bad_assertion", detail: "unknown_kid" };

  const expected = Buffer.from(signPayloadSegment(key, p), "utf8");
  const given = Buffer.from(s, "utf8");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, code: "bad_assertion", detail: "bad_signature" };

  if (!validFields(parsed)) return { ok: false, code: "bad_assertion", detail: "bad_fields" };
  const payload: OraclePayload = parsed;

  if (Math.abs(opts.now - payload.iat) > FRESHNESS_S) return { ok: false, code: "stale_assertion", detail: "stale", payload };
  if (!opts.pnidAllowlist.includes(payload.pnid)) return { ok: false, code: "wrong_number", detail: "pnid_not_allowed", payload };
  if (typeof opts.conversationId !== "string" || opts.conversationId !== payload.rid) {
    return { ok: false, code: "request_mismatch", detail: "rid_mismatch", payload };
  }
  return { ok: true, payload };
}

/**
 * The deployed config.ts rules for the keys and the allowlist (read for this oracle):
 *   - kid  = (PL_ASSERTION_KID ?? '').trim()   must match /^[a-z0-9]{1,16}$/
 *   - key  = PL_ASSERTION_HMAC_KEY (NOT trimmed) ; UTF-8 byte length >= 32
 *   - pnid allowlist = PL_CONCIERGE_PNID_ALLOWLIST split on ',', each trimmed, kept only if /^[0-9]{5,20}$/
 */
export function oracleConfigFromEnv(env: Record<string, string | undefined>): { keys: Record<string, string>; pnidAllowlist: string[]; misconfig: string[] } {
  const misconfig: string[] = [];
  const keys: Record<string, string> = {};
  const kid = (env["PL_ASSERTION_KID"] ?? "").trim();
  const key = env["PL_ASSERTION_HMAC_KEY"] ?? "";
  if (!KID_RE.test(kid)) misconfig.push("PL_ASSERTION_KID");
  if (Buffer.byteLength(key, "utf8") < MIN_KEY_BYTES) misconfig.push("PL_ASSERTION_HMAC_KEY");
  if (KID_RE.test(kid) && Buffer.byteLength(key, "utf8") >= MIN_KEY_BYTES) keys[kid] = key;
  const pnidAllowlist = (env["PL_CONCIERGE_PNID_ALLOWLIST"] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^[0-9]{5,20}$/.test(s));
  if (pnidAllowlist.length === 0) misconfig.push("PL_CONCIERGE_PNID_ALLOWLIST");
  return { keys, pnidAllowlist, misconfig };
}

/**
 * Contract s.3.4 step 6 (the SERVICE, not assertion.ts): a MUTATING operation inserts (nonce, op) into a
 * table and a conflict is `409 replay`. Reads never consume. Modelled here only to test the minter's
 * "a nonce is never reused" end to end.
 */
export class OracleNonceStore {
  private readonly seen = new Set<string>();
  /** @returns true when the nonce was fresh for this op; false = the service would answer 409 replay. */
  consume(nonce: string, op: string): boolean {
    const k = `${op}\u0000${nonce}`;
    if (this.seen.has(k)) return false;
    this.seen.add(k);
    return true;
  }
}
