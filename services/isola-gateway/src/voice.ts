/**
 * The personal-line voice-seat READ projection.
 *
 * One capability: given a tenant and one of its members, report the state of
 * that member's personal voice seat. Read-only. No write path exists here and
 * none may be added — NocoBase owns the operator control plane, and Magnus
 * remains the telephony authority. This module owns the *mapping and the
 * policy*, nothing else.
 *
 * THE CONTAINMENT RULE, ported conceptually from PR #100. That P0 shipped
 * because a browser-facing response acquired a credential field. The defence
 * there was a source scan, not a behavioural test, because a behavioural test
 * only proves the paths it exercises. The same shape is used here — and unlike
 * the first revision of this file, the scan now covers THIS file too. The
 * forbidden names live in `voice-policy.ts`, which declares and does nothing,
 * so the scanner's exemption is a tiny declaration file rather than the module
 * that implements the projection.
 *
 * Absence, not masking. A masked value is still a value on the wire.
 */
import { createHmac } from "node:crypto";

import type { SafeFetch } from "./egress.js";
import {
  CREDENTIAL_SHAPED_VALUE,
  PERSONAL_LINE_FIELDS,
  PROHIBITED_FIELDS,
  type PersonalLineField,
} from "./voice-policy.js";

export { PERSONAL_LINE_FIELDS, PROHIBITED_FIELDS };
export type { PersonalLineField };

export type PersonalLine = Partial<Record<PersonalLineField, string | boolean | null>> & {
  /** Present only when upstream reported one, and only after redaction. */
  provisioning_error?: string;
};

/**
 * The complete set of `provisioning_error` values this endpoint can emit.
 *
 * UPSTREAM PROSE IS NEVER RETURNED. An earlier revision redacted the upstream
 * string and returned what was left, which cannot be made safe in the general
 * case: `candidateSecretsFrom` could only see top-level string values, so a
 * credential nested inside `provider_config: { password: "…" }`, or one echoed
 * in the error text but present in no separate field at all, survived unless it
 * happened to match a URI or QR shape. That is the same nested-secret failure
 * class this programme has hit repeatedly.
 *
 * So the diagnostic is now a fixed, locally-generated category. Nothing from
 * the upstream body reaches the caller — not redacted, not truncated, not
 * shape-checked. Absence is the only containment that does not depend on
 * enumerating what a credential looks like.
 *
 * These strings are written here, in full, and contain no interpolation.
 */
export const PROVISIONING_ERROR_CATEGORIES = {
  /** Upstream reported a provisioning problem. Deliberately non-specific. */
  upstream_error: "Provisioning did not complete. Support has the details.",
} as const;

export type ProvisioningErrorCode = keyof typeof PROVISIONING_ERROR_CATEGORIES;

/**
 * Map "upstream reported something" onto a fixed category.
 *
 * Takes only a presence decision from the upstream value; its content is never
 * inspected for output and never propagated. The parameter is `unknown` because
 * nothing about its shape is trusted.
 */
export function safeProvisioningError(raw: unknown): string | undefined {
  const reported =
    (typeof raw === "string" && raw.trim().length > 0) ||
    (raw !== null && raw !== undefined && typeof raw !== "string");
  if (!reported) return undefined;
  return PROVISIONING_ERROR_CATEGORIES.upstream_error;
}

/**
 * Copy the allowlisted fields and discard everything else.
 *
 * Unknown upstream fields are dropped silently and deliberately: this is the
 * property that makes a future Magnus schema change safe by default rather than
 * safe only if someone remembers to review it.
 */
export function projectPersonalLine(upstream: Record<string, unknown>): PersonalLine {
  const out: PersonalLine = {};

  for (const field of PERSONAL_LINE_FIELDS) {
    const value = upstream[field];
    if (value === undefined) continue;
    if (typeof value === "string") {
      // A credential-shaped value must not pass merely because it arrived under
      // an allowlisted key.
      if (CREDENTIAL_SHAPED_VALUE.test(value)) continue;
      out[field] = value;
    } else if (typeof value === "boolean" || value === null) {
      out[field] = value;
    }
    // Numbers, objects and arrays are not part of this contract and are dropped.
  }

  const error = safeProvisioningError(upstream["provisioning_error"]);
  if (error !== undefined) out.provisioning_error = error;

  return out;
}

// ---------------------------------------------------------------------------
// Seat mapping — the registry half
// ---------------------------------------------------------------------------

export interface VoiceSeat {
  tenantId: string;
  memberId: string;
  /** The Magnus-side identifier. Never returned to a caller. */
  magnusExtension: string;
}

export interface SeatParseResult {
  ok: boolean;
  seats: VoiceSeat[];
  errors: string[];
}

/**
 * Parse `GATEWAY_VOICE_SEATS_JSON`. ALL-OR-NOTHING.
 *
 * The first revision accumulated valid entries and returned them alongside
 * `ok: false`, so a document with one duplicate or one malformed entry still
 * served its valid seats — the exact opposite of the advertised property. Any
 * error now empties the list, so a partially-invalid mapping resolves nothing
 * at all. `resolveSeat` additionally refuses to look at a result whose `ok` is
 * not literally `true`, so the invariant holds even if a future caller reaches
 * past this function.
 */
export function parseVoiceSeats(raw: string | undefined | null): SeatParseResult {
  const fail = (...errors: string[]): SeatParseResult => ({ ok: false, seats: [], errors });

  if (raw === undefined || raw === null || raw.trim().length === 0) {
    // An absent mapping is valid and empty — nothing resolves, which is the
    // same observable outcome as a rejected one.
    return { ok: true, seats: [], errors: [] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return fail("GATEWAY_VOICE_SEATS_JSON is not valid JSON");
  }
  if (!Array.isArray(parsed)) {
    return fail("GATEWAY_VOICE_SEATS_JSON must be an array");
  }

  const seats: VoiceSeat[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();

  parsed.forEach((entry, index) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      errors.push(`seat[${index}] is not an object`);
      return;
    }
    const record = entry as Record<string, unknown>;
    const tenantId = typeof record["tenantId"] === "string" ? record["tenantId"].trim() : "";
    const memberId = typeof record["memberId"] === "string" ? record["memberId"].trim() : "";
    const magnusExtension =
      typeof record["magnusExtension"] === "string" ? record["magnusExtension"].trim() : "";

    if (tenantId.length === 0) errors.push(`seat[${index}] has no tenantId`);
    if (memberId.length === 0) errors.push(`seat[${index}] has no memberId`);
    if (magnusExtension.length === 0) errors.push(`seat[${index}] has no magnusExtension`);
    if (tenantId.length === 0 || memberId.length === 0 || magnusExtension.length === 0) return;

    const key = `${tenantId}:${memberId}`;
    if (seen.has(key)) {
      errors.push(`seat[${index}] duplicates (tenantId, memberId)`);
      return;
    }
    seen.add(key);
    seats.push({ tenantId, memberId, magnusExtension });
  });

  // ALL-OR-NOTHING: one bad entry invalidates the whole document.
  if (errors.length > 0) return { ok: false, seats: [], errors };

  return { ok: true, seats, errors: [] };
}

/**
 * Resolve the seat for exactly this (tenant, member) pair.
 *
 * Takes the whole parse RESULT, not a bare array, so it can refuse a document
 * that failed validation. That is deliberate: passing the array alone is what
 * let the first revision route against a rejected mapping.
 *
 * Returns `null` for "mapping invalid", "no such seat", "not your tenant" and
 * "no such tenant" alike. The caller turns all of them into the same 404 as an
 * unknown route, so the endpoint cannot be used to enumerate tenants, members
 * or seats.
 */
export function resolveSeat(
  parsed: SeatParseResult,
  tenantId: string,
  memberId: string,
): VoiceSeat | null {
  // Defensive: never resolve against a mapping that did not fully validate.
  if (parsed.ok !== true) return null;
  if (tenantId.length === 0 || memberId.length === 0) return null;
  const matches = parsed.seats.filter(
    (s) => s.tenantId === tenantId && s.memberId === memberId,
  );
  // An ambiguous mapping is refused, not guessed.
  if (matches.length !== 1) return null;
  return matches[0] ?? null;
}

// ---------------------------------------------------------------------------
// Magnus — the server builds the request; a browser never speaks to Magnus
// ---------------------------------------------------------------------------

export interface PersonalLineSource {
  /** Raw upstream record, unprojected. Returns null when Magnus has no seat. */
  fetchSeat(seat: VoiceSeat): Promise<Record<string, unknown> | null>;
}

export interface MagnusSourceOptions {
  baseUrl: string;
  apiKey: string;
  apiSecret: string;
  safeFetch: SafeFetch;
  timeoutMs: number;
  module?: string;
  action?: string;
  /** Column holding the SIP username. `sip.name` in the live schema. */
  selectorField?: string;
  now?: () => [number, number];
}

/**
 * The canonical Magnus grid read, matching the proven live client in
 * `artifacts/isola/engines/magnus.ts` (`findRowByField`) and
 * `artifacts/isola/lib/magnus-voice.ts` (`findOneByField`): module `sip`,
 * action `read`, and a JSON grid `filter` with an `eq` comparison.
 *
 * The first revision defaulted to an undocumented `list` action with a bare
 * `username` parameter. Neither exists in the proven client, and the SIP
 * username is stored in `sip.name` — so that selector could not have matched.
 */
export const MAGNUS_SIP_MODULE = "sip";
export const MAGNUS_SIP_READ_ACTION = "read";
export const MAGNUS_SIP_SELECTOR_FIELD = "name";

/**
 * Contract field -> live Magnus column, for the fields whose source has ACTUALLY
 * been proven by a read-only contract check against `voice00.epic.dm`.
 *
 * Only one entry, and that is deliberate. The authorized live probe reported a
 * `sip` row exposing `id` and `name` and none of the other six contract fields:
 * they live in other modules (`did`, `sip.forward`, and the tenant's own
 * records), and none of those has been proven yet.
 *
 * An unproven field is therefore ABSENT from the response rather than guessed.
 * A personal-line read that quietly reported `state: "active"` because a column
 * happened to share a name would be worse than one that reports nothing: the
 * portal would render a confident answer nobody verified. Absence is honest and
 * the projection already treats a missing field as missing.
 *
 * Widening this map requires the same evidence the first entry has: a live
 * read-only probe showing the column exists and carries the meaning claimed.
 */
export const MAGNUS_FIELD_MAP: ReadonlyArray<readonly [PersonalLineField, string]> = [
  ["sip_username", "name"],
];

/**
 * Translate a live Magnus row into the contract's field names.
 *
 * Contract-named keys already present on the row are preserved, so a future
 * upstream that speaks the contract directly needs no change here — and so the
 * injected test doubles exercise the same projection path as production.
 */
export function normaliseMagnusRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  // ONLY the explicitly evidenced map. A previous revision first copied every
  // contract-named key straight off the raw row and then applied the map, which
  // silently re-adopted the six unproven fields the live check says are absent:
  // a Magnus column that merely happens to be called `state` or `did_number`
  // would have become browser-visible carrying whatever Magnus means by it.
  // Same name is not same meaning, and this endpoint does not guess.
  for (const [field, column] of MAGNUS_FIELD_MAP) {
    const value = row[column];
    if (value !== undefined) out[field] = value;
  }

  // The diagnostic is governed separately: `projectPersonalLine` maps the mere
  // PRESENCE of an upstream error onto a fixed local category and never
  // propagates its content, so passing the raw value on here reveals nothing.
  if (row["provisioning_error"] !== undefined) {
    out["provisioning_error"] = row["provisioning_error"];
  }

  return out;
}

/** PHP-compatible urlencoding — the signature is over this exact encoding. */
function phpUrlencode(s: string): string {
  return encodeURIComponent(s)
    .replace(/%20/g, "+")
    .replace(/!/g, "%21")
    .replace(/~/g, "%7E")
    .replace(/\*/g, "%2A")
    .replace(/'/g, "%27")
    .replace(/\(/g, "%28")
    .replace(/\)/g, "%29");
}

/**
 * Pick the row that IS the requested seat.
 *
 * Never `rows[0]`, and never row order. If Magnus ignores the filter, widens
 * it, or returns a grid page, the first row belongs to whoever happens to sort
 * first — projecting it would hand one tenant another tenant's line. So the
 * rows are searched for an EXACT match on the selector field, and anything
 * other than exactly one match resolves to nothing.
 */
export function selectExactSeatRow(
  rows: readonly unknown[],
  selectorField: string,
  expected: string,
): Record<string, unknown> | null {
  const matches: Record<string, unknown>[] = [];
  for (const row of rows) {
    if (typeof row !== "object" || row === null || Array.isArray(row)) continue;
    const record = row as Record<string, unknown>;
    const identifier = record[selectorField];
    // STRING IDENTITY ONLY — type and value must both match. The live contract
    // check established `sip.name` as a string, so a numeric row identifier is
    // off-contract and must not be coerced into a match: coercion is how a row
    // that is not the requested seat becomes one.
    if (typeof identifier === "string" && identifier === expected) matches.push(record);
  }
  if (matches.length !== 1) return null;
  return matches[0] ?? null;
}

export function createMagnusPersonalLineSource(
  options: MagnusSourceOptions,
): PersonalLineSource {
  const base = options.baseUrl.replace(/\/+$/, "");
  const moduleName = options.module ?? MAGNUS_SIP_MODULE;
  const actionName = options.action ?? MAGNUS_SIP_READ_ACTION;
  const selectorField = options.selectorField ?? MAGNUS_SIP_SELECTOR_FIELD;
  const hrtime = options.now ?? (() => process.hrtime());

  return {
    async fetchSeat(seat: VoiceSeat): Promise<Record<string, unknown> | null> {
      const mt = hrtime();
      const nonce = mt[0].toString() + String(mt[1]).padStart(9, "0").slice(0, 6);

      // Same grid-filter shape the proven client uses, including its
      // value-shaped type selection.
      const isNumeric = /^\d+$/.test(seat.magnusExtension);
      const filter = JSON.stringify([
        {
          type: isNumeric ? "numeric" : "string",
          field: selectorField,
          value: seat.magnusExtension,
          comparison: "eq",
        },
      ]);

      const postData = Object.entries({
        module: moduleName,
        action: actionName,
        nonce,
        page: "1",
        start: "0",
        limit: "25",
        filter,
      })
        .map(([k, v]) => phpUrlencode(k) + "=" + phpUrlencode(v))
        .join("&");

      const signature = createHmac("sha512", options.apiSecret)
        .update(postData)
        .digest("hex");

      const response = await options.safeFetch(
        `${base}/index.php/${moduleName}/${actionName}`,
        {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            Key: options.apiKey,
            Sign: signature,
          },
          body: postData,
          signal: AbortSignal.timeout(options.timeoutMs),
        },
      );

      if (!response.ok) return null;

      let body: unknown;
      try {
        body = await response.json();
      } catch {
        // A non-JSON upstream body is never echoed — it is exactly the sort of
        // raw provider output this endpoint must not surface.
        return null;
      }

      if (typeof body !== "object" || body === null) return null;
      const record = body as Record<string, unknown>;
      if (record["status"] === "error") {
        // Upstream error text is not returned. `provisioning_error` on the
        // projected record is the only diagnostic channel, and it is redacted.
        return null;
      }

      const rows = record["rows"];
      if (!Array.isArray(rows)) return null;

      // Identity is proven BEFORE anything is translated or projected.
      const row = selectExactSeatRow(rows, selectorField, seat.magnusExtension);
      if (row === null) return null;
      return normaliseMagnusRow(row);
    },
  };
}

// ---------------------------------------------------------------------------
// Rate limiting — fixed window, in memory, per (tenant, member)
// ---------------------------------------------------------------------------

export interface RateLimiter {
  /** True when the call is permitted. */
  take(key: string, nowMs: number): boolean;
}

export function createRateLimiter(limit: number, windowMs: number): RateLimiter {
  const buckets = new Map<string, { count: number; resetAt: number }>();

  return {
    take(key: string, nowMs: number): boolean {
      const existing = buckets.get(key);
      if (existing === undefined || nowMs >= existing.resetAt) {
        // Opportunistic sweep so a long-lived process cannot grow unbounded.
        if (buckets.size > 10_000) {
          for (const [k, v] of buckets) if (nowMs >= v.resetAt) buckets.delete(k);
        }
        buckets.set(key, { count: 1, resetAt: nowMs + windowMs });
        return true;
      }
      if (existing.count >= limit) return false;
      existing.count += 1;
      return true;
    },
  };
}

// ---------------------------------------------------------------------------
// Path parameters
// ---------------------------------------------------------------------------

/**
 * Identifier shape accepted in the path. Deliberately narrow: tenant and member
 * identifiers are opaque tokens, so anything outside this set is a malformed
 * request rather than a lookup that happens to miss.
 */
const IDENTIFIER_PATTERN = /^[A-Za-z0-9._~-]{1,128}$/;

/**
 * Decode one path segment, or return null.
 *
 * `decodeURIComponent` throws `URIError` synchronously on malformed
 * percent-encoding (`/%E0%A4%A`). In the first revision that threw inside the
 * router, before the asynchronous handler's catch existed — so a malformed path
 * could take down the request rather than 404. Every rejection here becomes the
 * same 404 as an unknown route.
 */
export function safeDecodeIdentifier(raw: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }
  // An encoded separator must not smuggle a second path segment through.
  if (decoded.includes("/") || decoded.includes("\\")) return null;
  // Control characters (including NUL) and the space used as the rate-limit
  // and duplicate-detection key separator.
  for (let i = 0; i < decoded.length; i++) {
    const code = decoded.charCodeAt(i);
    // Anything at or below SPACE is a control character or the separator;
    // 127 is DEL. None may appear in an opaque identifier.
    if (code <= 32 || code === 127) return null;
  }
  if (!IDENTIFIER_PATTERN.test(decoded)) return null;
  return decoded;
}
