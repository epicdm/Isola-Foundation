/**
 * Signature verification, including the property that makes the whole thing
 * work: the HMAC is over the RAW body, so a re-serialised JSON body does not
 * verify even though it is semantically identical.
 */
import { describe, expect, it } from "vitest";

import {
  computeSignature,
  parseDeliveryHeader,
  parseSignatureHeader,
  parseTimestampHeader,
  signingPayload,
  verifyChatwootSignature,
} from "../src/signature.js";
import { BOT_SECRET, placeholder } from "./harness.js";

const NOW_MS = 1_770_000_000_000;
const NOW_SEC = Math.floor(NOW_MS / 1000);
const WINDOW = 300;

function verify(overrides: {
  raw?: Buffer;
  signatureHeader?: string | undefined;
  timestampHeader?: string | undefined;
  secret?: string | null;
  nowMs?: number;
}) {
  const raw = overrides.raw ?? Buffer.from(JSON.stringify({ event: "message_created" }));
  const timestampHeader =
    overrides.timestampHeader === undefined ? String(NOW_SEC) : overrides.timestampHeader;
  const secret = overrides.secret === undefined ? BOT_SECRET : overrides.secret;
  const signatureHeader =
    overrides.signatureHeader === undefined
      ? `sha256=${computeSignature(secret ?? "", timestampHeader ?? "", raw)}`
      : overrides.signatureHeader;
  return verifyChatwootSignature({
    raw,
    signatureHeader,
    timestampHeader,
    secret,
    nowMs: overrides.nowMs ?? NOW_MS,
    windowSec: WINDOW,
  });
}

describe("the signed string", () => {
  it("is `${timestamp}.${rawBody}`, byte for byte", () => {
    const raw = Buffer.from('{"a":1}', "utf8");
    expect(signingPayload("1770000000", raw).toString("utf8")).toBe('1770000000.{"a":1}');
  });

  it("computes a 64-character lower-case hex digest", () => {
    const digest = computeSignature(BOT_SECRET, "1770000000", Buffer.from("{}"));
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("verifyChatwootSignature", () => {
  it("accepts a correctly signed delivery", () => {
    expect(verify({})).toEqual({ ok: true });
  });

  it("rejects a signature made with the wrong secret", () => {
    const raw = Buffer.from('{"event":"message_created"}', "utf8");
    const wrong = `sha256=${computeSignature(placeholder("other"), String(NOW_SEC), raw)}`;
    expect(verify({ raw, signatureHeader: wrong })).toEqual({
      ok: false,
      reason: "signature_mismatch",
    });
  });

  it("rejects a missing signature header", () => {
    expect(
      verifyChatwootSignature({
        raw: Buffer.from("{}"),
        signatureHeader: undefined,
        timestampHeader: String(NOW_SEC),
        secret: BOT_SECRET,
        nowMs: NOW_MS,
        windowSec: WINDOW,
      }),
    ).toEqual({ ok: false, reason: "signature_header_missing" });
  });

  it("rejects a malformed signature header", () => {
    expect(verify({ signatureHeader: "deadbeef" })).toEqual({
      ok: false,
      reason: "signature_header_malformed",
    });
    expect(verify({ signatureHeader: "sha256=nothex" })).toEqual({
      ok: false,
      reason: "signature_header_malformed",
    });
    expect(verify({ signatureHeader: "sha1=" + "a".repeat(64) })).toEqual({
      ok: false,
      reason: "signature_header_malformed",
    });
  });

  it("rejects a missing or malformed timestamp header", () => {
    expect(
      verifyChatwootSignature({
        raw: Buffer.from("{}"),
        signatureHeader: `sha256=${"a".repeat(64)}`,
        timestampHeader: undefined,
        secret: BOT_SECRET,
        nowMs: NOW_MS,
        windowSec: WINDOW,
      }),
    ).toEqual({ ok: false, reason: "timestamp_header_missing" });

    expect(verify({ timestampHeader: "not-a-number" })).toEqual({
      ok: false,
      reason: "timestamp_header_malformed",
    });
  });

  it("rejects a stale timestamp in the past", () => {
    const timestampHeader = String(NOW_SEC - WINDOW - 1);
    expect(verify({ timestampHeader })).toEqual({ ok: false, reason: "timestamp_too_old" });
  });

  it("rejects a timestamp in the future", () => {
    const timestampHeader = String(NOW_SEC + WINDOW + 1);
    expect(verify({ timestampHeader })).toEqual({ ok: false, reason: "timestamp_in_future" });
  });

  it("accepts skew at the edge of the window in both directions", () => {
    expect(verify({ timestampHeader: String(NOW_SEC - WINDOW) })).toEqual({ ok: true });
    expect(verify({ timestampHeader: String(NOW_SEC + WINDOW) })).toEqual({ ok: true });
  });

  it("fails closed when the binding has no secret", () => {
    expect(verify({ secret: null })).toEqual({ ok: false, reason: "no_secret_configured" });
    expect(verify({ secret: "" })).toEqual({ ok: false, reason: "no_secret_configured" });
  });

  it("enforces the replay window before the HMAC, so a valid old signature is still refused", () => {
    const raw = Buffer.from('{"event":"message_created"}', "utf8");
    const old = String(NOW_SEC - 10_000);
    const signature = `sha256=${computeSignature(BOT_SECRET, old, raw)}`;
    expect(
      verifyChatwootSignature({
        raw,
        signatureHeader: signature,
        timestampHeader: old,
        secret: BOT_SECRET,
        nowMs: NOW_MS,
        windowSec: WINDOW,
      }),
    ).toEqual({ ok: false, reason: "timestamp_too_old" });
  });
});

describe("raw body vs re-serialised JSON", () => {
  // This is the reason the handler reads bytes before it parses anything.
  const rawBody = '{"event":"message_created",  "content":"caf\\u00e9",  "id":9001}';
  const reparsed = JSON.stringify(JSON.parse(rawBody));

  it("the two bodies are semantically identical but not byte identical", () => {
    expect(JSON.parse(rawBody)).toEqual(JSON.parse(reparsed));
    expect(reparsed).not.toBe(rawBody);
  });

  it("a signature over the raw body verifies against the raw body", () => {
    const raw = Buffer.from(rawBody, "utf8");
    expect(verify({ raw })).toEqual({ ok: true });
  });

  it("a signature over the raw body does NOT verify against the re-serialised body", () => {
    const timestamp = String(NOW_SEC);
    const signature = `sha256=${computeSignature(BOT_SECRET, timestamp, Buffer.from(rawBody, "utf8"))}`;
    expect(
      verifyChatwootSignature({
        raw: Buffer.from(reparsed, "utf8"),
        signatureHeader: signature,
        timestampHeader: timestamp,
        secret: BOT_SECRET,
        nowMs: NOW_MS,
        windowSec: WINDOW,
      }),
    ).toEqual({ ok: false, reason: "signature_mismatch" });
  });
});

describe("header parsers", () => {
  it("parses sha256=<hex> case-insensitively and lower-cases the digest", () => {
    const hex = "A".repeat(64);
    expect(parseSignatureHeader(`SHA256=${hex}`)).toBe("a".repeat(64));
  });

  it("refuses anything that is not sha256=<64 hex>", () => {
    expect(parseSignatureHeader("sha256=" + "a".repeat(63))).toBeNull();
    expect(parseSignatureHeader(undefined)).toBeNull();
    expect(parseSignatureHeader(["sha256=zz"])).toBeNull();
  });

  it("parses only integer unix seconds", () => {
    expect(parseTimestampHeader(" 1770000000 ")).toBe(1_770_000_000);
    expect(parseTimestampHeader("1770000000.5")).toBeNull();
    expect(parseTimestampHeader("-1")).toBeNull();
  });

  it("parses a delivery id and refuses an absurd one", () => {
    expect(parseDeliveryHeader(" abc ")).toBe("abc");
    expect(parseDeliveryHeader("")).toBeNull();
    expect(parseDeliveryHeader("x".repeat(201))).toBeNull();
  });
});
