/**
 * The fixture assertion MINTER (UAT only), tested against a faithful port of the DEPLOYED bff-v2
 * verifier (test/pl-verifier-oracle.ts). Socket-free. Every key, id and number here is SYNTHETIC; the
 * only key used is generated inside this process or is the labelled TEST key in the vectors file.
 *
 * What these tests are for (CLAUDE.md laws 11/19/20/23/28): each refusal has a positive twin in the same
 * harness, the oracle is itself fired by independently generated vectors, and the multi-gate rule is
 * honoured (the subject the minter signs for and the subject a caller offers are DIFFERENT fields).
 */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { inspect } from "node:util";
import { beforeEach, describe, expect, it } from "vitest";

import {
  ASSERTION_ENV,
  AssertionMinterConfigError,
  AssertionRefused,
  assertionMinterFromEnv,
  assertionMinterFromTexts,
  createAssertionMinter,
  normaliseFixtureWaId,
  normaliseSubject,
  validateKeyText,
  type MinterOptions,
} from "../src/assertion-minter.js";
import {
  OracleNonceStore,
  oracleConfigFromEnv,
  signPayloadSegment,
  verifyAssertion,
  type OracleResult,
} from "./pl-verifier-oracle.js";

const KEY = randomBytes(32).toString("hex"); // 64 hex chars, generated in-process, never written anywhere
const KID = "fxuat1";
const PNID = "990000000017"; // the synthetic UAT id (not a real WhatsApp phone_number_id)
const WA = "15555550100"; // SYNTHETIC
const OTHER_WA = "15555550199"; // SYNTHETIC, a different customer
const RID = "igw1-" + "c".repeat(64);
const MID = "424242";
const NOW_S = 1_790_000_005;
const NOW_MS = NOW_S * 1000;

function opts(over: Partial<MinterOptions> = {}): MinterOptions {
  return { key: KEY, kid: KID, pnid: PNID, fixtureWaId: WA, environment: "uat", nowMs: () => NOW_MS, ...over };
}
function mint(over: Partial<MinterOptions> = {}, args: { subject?: unknown; rid?: string; mid?: string } = {}): string {
  return createAssertionMinter(opts(over)).mintForSubject({ subject: WA, rid: RID, mid: MID, ...args });
}
function verify(token: string, over: { now?: number; rid?: string | null; keys?: Record<string, string>; allow?: string[] } = {}): OracleResult {
  return verifyAssertion(token, {
    keys: over.keys ?? { [KID]: KEY },
    pnidAllowlist: over.allow ?? [PNID],
    now: over.now ?? NOW_S,
    conversationId: over.rid === undefined ? RID : over.rid,
  });
}
function decode(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split(".")[1] as string, "base64url").toString("utf8")) as Record<string, unknown>;
}
function refusal(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof AssertionRefused) return e.code;
    return `other:${e instanceof Error ? e.name : "throw"}`;
  }
  return "none";
}
function configProblems(fn: () => unknown): string[] {
  try {
    fn();
  } catch (e) {
    if (e instanceof AssertionMinterConfigError) return e.problems;
    return [`other:${e instanceof Error ? e.name : "throw"}`];
  }
  return [];
}

// ---------------------------------------------------------------------------------------------
describe("the oracle is the deployed verifier, fired by independently generated vectors", () => {
  const doc = JSON.parse(readFileSync(new URL("./fixtures/assertion-vectors.json", import.meta.url), "utf8")) as {
    key: string;
    kid: string;
    pnidAllowlist: string[];
    vectors: Array<{ name: string; token: string; headers: Record<string, string>; now: number; expected: { ok: boolean; code?: string; detail?: string } }>;
  };

  it("the vector file is not vacuous (a check that never fires proves nothing: law 11)", () => {
    expect(doc.vectors.length).toBeGreaterThanOrEqual(20);
    expect(doc.vectors.some((v) => v.expected.ok)).toBe(true);
    expect(doc.vectors.some((v) => !v.expected.ok)).toBe(true);
  });

  for (const v of doc.vectors) {
    it(`vector ${v.name} gets the verifier's own verdict`, () => {
      const r = verifyAssertion(v.headers["x-isola-assertion"], {
        keys: { [doc.kid]: doc.key },
        pnidAllowlist: doc.pnidAllowlist,
        now: v.now,
        conversationId: v.headers["x-conversation-id"],
      });
      expect(r.ok).toBe(v.expected.ok);
      if (!r.ok) {
        expect(r.code).toBe(v.expected.code);
        expect(r.detail).toBe(v.expected.detail);
      }
    });
  }
});

// ---------------------------------------------------------------------------------------------
describe("a token the minter produces is accepted by the deployed verifier", () => {
  it("POSITIVE: accepted, with exactly the fields the contract names and no others", () => {
    const token = mint();
    const r = verify(token);
    expect(r.ok).toBe(true);
    const payload = decode(token);
    expect(Object.keys(payload)).toEqual(["kid", "wa_id", "pnid", "rid", "mid", "iat", "nonce"]);
    expect(payload["kid"]).toBe(KID);
    expect(payload["wa_id"]).toBe(WA);
    expect(payload["pnid"]).toBe(PNID);
    expect(payload["rid"]).toBe(RID);
    expect(payload["mid"]).toBe(MID);
    expect(payload["iat"]).toBe(NOW_S);
    expect(typeof payload["nonce"]).toBe("string");
    expect(payload["nonce"]).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });

  it("never emits act or act_src (provisioning stays off), whatever the caller passes", () => {
    const m = createAssertionMinter(opts());
    const token = m.mintForSubject({ subject: WA, rid: RID, mid: MID, act: "pl.confirm_signup", act_src: "button" } as never);
    const payload = decode(token);
    expect("act" in payload).toBe(false);
    expect("act_src" in payload).toBe(false);
  });

  it("a token is at most 2048 characters", () => {
    expect(mint({}, { rid: "r".repeat(128), mid: "m".repeat(256) }).length).toBeLessThanOrEqual(2048);
  });

  it("the signature covers the exact payload bytes: 'v1.' + P is signed with the raw UTF-8 key", () => {
    const token = mint();
    const [fmt, p, s] = token.split(".") as [string, string, string];
    expect(fmt).toBe("v1");
    expect(s).toBe(signPayloadSegment(KEY, p));
    expect(s.length).toBe(43);
  });

  it("is byte-identical to the independently generated vector for the same inputs", () => {
    const doc = JSON.parse(readFileSync(new URL("./fixtures/assertion-vectors.json", import.meta.url), "utf8")) as {
      key: string;
      fixed: { wa_id: string; rid: string; mid: string; iat: number };
      vectors: Array<{ name: string; token: string }>;
    };
    const expected = doc.vectors.find((v) => v.name === "tv-valid")!.token;
    const m = createAssertionMinter({
      key: doc.key,
      kid: "fxuat1",
      pnid: "990000000017",
      fixtureWaId: doc.fixed.wa_id,
      environment: "uat",
      nowMs: () => doc.fixed.iat * 1000,
      randomBytes: (n) => new Uint8Array(n).fill(0x11), // base64url -> EREREREREREREREREREREQ
    });
    expect(m.mintForSubject({ subject: doc.fixed.wa_id, rid: doc.fixed.rid, mid: doc.fixed.mid })).toBe(expected);
  });

  it("freshness: accepted within 120 s either side of iat, refused beyond (positive and negative controls)", () => {
    const token = mint();
    expect(verify(token, { now: NOW_S + 120 }).ok).toBe(true);
    expect(verify(token, { now: NOW_S - 120 }).ok).toBe(true);
    const late = verify(token, { now: NOW_S + 121 });
    expect(late.ok).toBe(false);
    expect(!late.ok && late.code).toBe("stale_assertion");
    const early = verify(token, { now: NOW_S - 121 });
    expect(!early.ok && early.code).toBe("stale_assertion");
  });

  it("iat is an integer even when the clock has fractions", () => {
    const token = mint({ nowMs: () => NOW_MS + 999.9 });
    expect(Number.isInteger(decode(token)["iat"])).toBe(true);
    expect(decode(token)["iat"]).toBe(NOW_S);
  });
});

// ---------------------------------------------------------------------------------------------
describe("the deployed verifier REFUSES what the minter would be wrong to produce (the oracle is wired to the minter)", () => {
  let token = "";
  beforeEach(() => {
    token = mint();
  });

  it("wrong rid in the header => request_mismatch (control: the right rid is accepted)", () => {
    expect(verify(token, { rid: RID }).ok).toBe(true);
    const r = verify(token, { rid: "igw1-" + "d".repeat(64) });
    expect(!r.ok && r.code).toBe("request_mismatch");
  });

  it("pnid not on the allowlist => wrong_number (control: on the list)", () => {
    expect(verify(token, { allow: [PNID] }).ok).toBe(true);
    const r = verify(token, { allow: ["990000000018"] });
    expect(!r.ok && r.code).toBe("wrong_number");
  });

  it("an unknown kid, or a wrong key for the kid, is refused", () => {
    const unknown = verify(token, { keys: { other1: KEY } });
    expect(!unknown.ok && unknown.code === "bad_assertion" && unknown.detail).toBe("unknown_kid");
    const wrong = verify(token, { keys: { [KID]: randomBytes(32).toString("hex") } });
    expect(!wrong.ok && wrong.code === "bad_assertion" && wrong.detail).toBe("bad_signature");
  });

  it("a token with act but no act_src, or act_src without act, is refused by the verifier; a minter token has neither", () => {
    const base = decode(token);
    const sign = (o: Record<string, unknown>): string => {
      const p = Buffer.from(JSON.stringify(o), "utf8").toString("base64url");
      return `v1.${p}.${signPayloadSegment(KEY, p)}`;
    };
    const a = verify(sign({ ...base, act: "pl.confirm_signup" }));
    expect(!a.ok && a.code === "bad_assertion" && a.detail).toBe("bad_fields");
    const b = verify(sign({ ...base, act_src: "button" }));
    expect(!b.ok && b.code === "bad_assertion" && b.detail).toBe("bad_fields");
    expect(verify(sign(base)).ok).toBe(true); // control: the same payload without them
  });

  it("an oversize value is refused by the verifier (the minter's own cap keeps it far below)", () => {
    const base = decode(token);
    const p = Buffer.from(JSON.stringify({ ...base, pad: "x".repeat(2100) }), "utf8").toString("base64url");
    const big = `v1.${p}.${signPayloadSegment(KEY, p)}`;
    const r = verify(big);
    expect(!r.ok && r.code === "bad_assertion" && r.detail).toBe("malformed");
  });

  it("nonce replay is a SERVICE rule (step 6, mutating ops): two minted tokens never share a nonce, and a replayed one is the 409 case", () => {
    const m = createAssertionMinter(opts());
    const t1 = m.mintForSubject({ subject: WA, rid: RID, mid: MID });
    const t2 = m.mintForSubject({ subject: WA, rid: RID, mid: MID });
    const n1 = decode(t1)["nonce"] as string;
    const n2 = decode(t2)["nonce"] as string;
    expect(n1).not.toBe(n2);
    const store = new OracleNonceStore();
    expect(store.consume(n1, "provision")).toBe(true);
    expect(store.consume(n2, "provision")).toBe(true); // control: a fresh nonce passes
    expect(store.consume(n1, "provision")).toBe(false); // the same nonce again = replay
  });

  it("the verifier's config rules for the env key, as read from the deployed config.ts (the key is NOT trimmed)", () => {
    const ok = oracleConfigFromEnv({ PL_ASSERTION_KID: KID, PL_ASSERTION_HMAC_KEY: KEY, PL_CONCIERGE_PNID_ALLOWLIST: PNID });
    expect(ok.misconfig).toEqual([]);
    expect(Object.keys(ok.keys)).toEqual([KID]);
    // a key with a trailing newline in the verifier's env would sign/verify over DIFFERENT bytes: this is why the minter refuses it
    const nl = oracleConfigFromEnv({ PL_ASSERTION_KID: KID, PL_ASSERTION_HMAC_KEY: KEY + "\n", PL_CONCIERGE_PNID_ALLOWLIST: PNID });
    expect(nl.keys[KID]).toBe(KEY + "\n");
    const token2 = mint();
    expect(verifyAssertion(token2, { keys: nl.keys, pnidAllowlist: [PNID], now: NOW_S, conversationId: RID }).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
describe("the minter enforces the ONE fixture subject, independently of every caller", () => {
  it("POSITIVE CONTROL: the configured subject gets a token", () => {
    expect(refusal(() => mint())).toBe("none");
  });

  it("any other subject is refused with NO token (and the refusal never contains the subject)", () => {
    let message = "";
    try {
      mint({}, { subject: OTHER_WA });
    } catch (e) {
      message = e instanceof Error ? e.message : "";
    }
    expect(refusal(() => mint({}, { subject: OTHER_WA }))).toBe("subject_not_fixture");
    expect(message).not.toContain(OTHER_WA);
    expect(message).not.toContain(WA);
  });

  it("a missing, empty, non-string or malformed subject is refused", () => {
    for (const subject of [null, undefined, "", "   ", 15555550100, {}, [WA], true, "abc", `${WA}x`, `${WA}\n`, `1${WA}`, WA.slice(1)]) {
      expect(refusal(() => mint({}, { subject })), JSON.stringify(subject)).toMatch(/^(no_subject|subject_not_fixture)$/);
    }
  });

  it("normalisation: ONE leading '+' is tolerated, nothing else (spaces, dashes, brackets are not digits-only)", () => {
    expect(normaliseSubject(`+${WA}`)).toBe(WA);
    expect(normaliseSubject(WA)).toBe(WA);
    expect(normaliseSubject(`++${WA}`)).toBeNull();
    expect(normaliseSubject("1 555 555 0100")).toBeNull();
    expect(normaliseSubject("1-555-555-0100")).toBeNull();
    expect(normaliseSubject("(1)5555550100")).toBeNull();
    expect(normaliseSubject(` ${WA}`)).toBeNull();
    expect(refusal(() => mint({}, { subject: `+${WA}` }))).toBe("none");
    expect(refusal(() => mint({}, { subject: "1 555 555 0100" }))).toBe("subject_not_fixture");
  });

  it("the minter exposes NO way to choose the wa_id: the signed wa_id is always the configured one", () => {
    const m = createAssertionMinter(opts());
    const t = m.mintForSubject({ subject: WA, rid: RID, mid: MID, wa_id: OTHER_WA, waId: OTHER_WA } as never);
    expect(decode(t)["wa_id"]).toBe(WA);
    expect(Object.keys(m).sort()).toEqual([]); // no own enumerable members to reach into
    // the only members: the one mint method and the two redacting stringifiers; nothing returns a value
    expect(Object.getOwnPropertyNames(Object.getPrototypeOf(m)).sort()).toEqual(["constructor", "mintForSubject", "toJSON", "toString"]);
  });

  it("DISTINCTNESS CONTROL (multi-gate rule): the subject the caller offers and the wa_id that is signed are different fields that happen to be equal only for the fixture", () => {
    const other = createAssertionMinter(opts({ fixtureWaId: OTHER_WA }));
    expect(refusal(() => other.mintForSubject({ subject: WA, rid: RID, mid: MID }))).toBe("subject_not_fixture");
    expect(decode(other.mintForSubject({ subject: OTHER_WA, rid: RID, mid: MID }))["wa_id"]).toBe(OTHER_WA);
  });

  it("rid: 1..128 header-safe printable characters (it must equal the X-Conversation-Id the tool sends)", () => {
    expect(refusal(() => mint({}, { rid: "" }))).toBe("bad_rid");
    expect(refusal(() => mint({}, { rid: "r".repeat(129) }))).toBe("bad_rid");
    expect(refusal(() => mint({}, { rid: "has space" }))).toBe("bad_rid");
    expect(refusal(() => mint({}, { rid: "line\nbreak" }))).toBe("bad_rid");
    expect(refusal(() => mint({}, { rid: "nul\u0000" }))).toBe("bad_rid");
    expect(refusal(() => mint({}, { rid: "r".repeat(128) }))).toBe("none");
    expect(refusal(() => mint({}, { rid: 5 as unknown as string }))).toBe("bad_rid");
  });

  it("mid: 1..256 characters, no control characters", () => {
    expect(refusal(() => mint({}, { mid: "" }))).toBe("bad_mid");
    expect(refusal(() => mint({}, { mid: "m".repeat(257) }))).toBe("bad_mid");
    expect(refusal(() => mint({}, { mid: "a\nb" }))).toBe("bad_mid");
    expect(refusal(() => mint({}, { mid: "m".repeat(256) }))).toBe("none");
    expect(refusal(() => mint({}, { mid: 7 as unknown as string }))).toBe("bad_mid");
  });
});

// ---------------------------------------------------------------------------------------------
describe("construction fails closed, with NAMES in the error and never a value", () => {
  it("POSITIVE CONTROL: the valid options construct", () => {
    expect(configProblems(() => createAssertionMinter(opts()))).toEqual([]);
  });

  it("the environment guard: only exactly 'uat' constructs (production, UAT in capitals, empty, absent are refused)", () => {
    for (const environment of ["prod", "production", "UAT", " uat", "uat ", "", undefined, "staging"]) {
      const p = configProblems(() => createAssertionMinter(opts({ environment })));
      expect(p, String(environment)).toContain(ASSERTION_ENV.environment);
    }
  });

  it("a missing or short key is refused; the minimum is 32 UTF-8 bytes (control: exactly 32 constructs)", () => {
    expect(configProblems(() => createAssertionMinter(opts({ key: "" })))).toContain(ASSERTION_ENV.key);
    expect(configProblems(() => createAssertionMinter(opts({ key: "k".repeat(31) })))).toContain(ASSERTION_ENV.key);
    expect(configProblems(() => createAssertionMinter(opts({ key: "k".repeat(32) })))).toEqual([]);
  });

  it("the key must be exact bytes: ANY leading/trailing whitespace, newline, control or non-printable character is refused (the verifier does not trim)", () => {
    for (const bad of [`${KEY}\n`, `${KEY}\r\n`, ` ${KEY}`, `${KEY} `, `\t${KEY}`, `${KEY.slice(0, 20)}\t${KEY.slice(20)}`, `${KEY}\u0000`, `﻿${KEY}`, `${KEY}é`, `${KEY.slice(0, 10)} ${KEY.slice(10)}`]) {
      expect(validateKeyText(bad).length, JSON.stringify(bad.slice(-6))).toBeGreaterThan(0);
      expect(configProblems(() => createAssertionMinter(opts({ key: bad }))), JSON.stringify(bad.slice(-6))).toContain(ASSERTION_ENV.key);
    }
    expect(validateKeyText(KEY)).toEqual([]);
    expect(validateKeyText("0123456789abcdef".repeat(4))).toEqual([]); // lane 59's 64 lowercase hex characters
  });

  it("kid: ^[a-z0-9]{1,16}$ and never 'v1' (that is the format version)", () => {
    for (const kid of ["v1", "FXUAT1", "has-dash", "", "a".repeat(17), "fx uat", "fx\n"]) {
      expect(configProblems(() => createAssertionMinter(opts({ kid }))), kid).toContain(ASSERTION_ENV.kid);
    }
    expect(configProblems(() => createAssertionMinter(opts({ kid: "a".repeat(16) })))).toEqual([]);
    expect(configProblems(() => createAssertionMinter(opts({ kid: "k1" })))).toEqual([]);
  });

  it("pnid: ^[0-9]{5,20}$", () => {
    for (const pnid of ["", "1234", "12345678901234567890 1", "abc12345", "99000000001 7", "-99000000001"]) {
      expect(configProblems(() => createAssertionMinter(opts({ pnid }))), pnid).toContain(ASSERTION_ENV.pnid);
    }
    expect(configProblems(() => createAssertionMinter(opts({ pnid: "12345" })))).toEqual([]);
    expect(configProblems(() => createAssertionMinter(opts({ pnid: "1".repeat(20) })))).toEqual([]);
  });

  it("fixture wa_id: ^[1-9][0-9]{6,15}$", () => {
    for (const fixtureWaId of ["", "0555555010", "123456", "1".repeat(17), "+15555550100", "1555555 0100", "abcdefgh"]) {
      expect(configProblems(() => createAssertionMinter(opts({ fixtureWaId }))), fixtureWaId).toContain(ASSERTION_ENV.fixtureWaId);
    }
  });

  it("the wa_id FILE loader trims ONE trailing newline only (not the key)", () => {
    expect(normaliseFixtureWaId(`${WA}\n`)).toBe(WA);
    expect(normaliseFixtureWaId(`${WA}\r\n`)).toBe(WA);
    expect(normaliseFixtureWaId(WA)).toBe(WA);
    expect(normaliseFixtureWaId(`${WA}\n\n`)).toBeNull();
    expect(normaliseFixtureWaId(` ${WA}`)).toBeNull();
    expect(normaliseFixtureWaId(`${WA} `)).toBeNull();
    expect(normaliseFixtureWaId("")).toBeNull();
  });

  it("an error never carries the key, the wa_id or the subject", () => {
    const badKey = "short-secret-key-value";
    let text = "";
    try {
      createAssertionMinter(opts({ key: badKey, fixtureWaId: "0badwaid" }));
    } catch (e) {
      text = `${e instanceof Error ? e.message : ""} ${JSON.stringify(e instanceof AssertionMinterConfigError ? e.problems : [])} ${String(e)}`;
    }
    expect(text).toContain(ASSERTION_ENV.key);
    expect(text).not.toContain(badKey);
    expect(text).not.toContain("0badwaid");
  });
});

// ---------------------------------------------------------------------------------------------
describe("redaction: the key and the fixture wa_id cannot leave through the object", () => {
  let m = undefined as unknown as ReturnType<typeof createAssertionMinter>;
  beforeEach(() => {
    m = createAssertionMinter(opts());
  });
  const needles = [KEY, WA];

  it("String(), JSON.stringify(), util.inspect() and template interpolation show neither", () => {
    const outputs = [String(m), JSON.stringify(m), inspect(m, { depth: 5, showHidden: true }), `${m}`, JSON.stringify({ m }), inspect({ nested: { m } }, { depth: 6 })];
    for (const out of outputs) for (const n of needles) expect(out).not.toContain(n);
    expect(String(m)).toContain("redacted");
  });

  it("has no own properties and no accessor that returns either value", () => {
    expect(Reflect.ownKeys(m)).toEqual([]);
    for (const name of Object.getOwnPropertyNames(Object.getPrototypeOf(m))) {
      const d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(m), name)!;
      expect("get" in d && d.get !== undefined).toBe(false);
    }
  });

  it("the error from a refusal does not leak the token either", () => {
    let text = "";
    try {
      mint({}, { subject: OTHER_WA, rid: "bad rid" });
    } catch (e) {
      text = String(e);
    }
    expect(text).not.toContain(KEY);
  });
});

// ---------------------------------------------------------------------------------------------
describe("a nonce is never reused", () => {
  it("many mints give distinct nonces (default CSPRNG)", () => {
    const m = createAssertionMinter(opts());
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) seen.add(decode(m.mintForSubject({ subject: WA, rid: RID, mid: MID }))["nonce"] as string);
    expect(seen.size).toBe(500);
  });

  it("an RNG that repeats is detected: a repeat is re-drawn, and a stuck RNG REFUSES (no token with a reused nonce)", () => {
    let calls = 0;
    const flaky = createAssertionMinter(
      opts({
        randomBytes: (n) => {
          calls += 1;
          return new Uint8Array(n).fill(calls <= 2 ? 0x22 : 0x33); // call 1 and 2 identical, then different
        },
      }),
    );
    const a = decode(flaky.mintForSubject({ subject: WA, rid: RID, mid: MID }))["nonce"];
    const b = decode(flaky.mintForSubject({ subject: WA, rid: RID, mid: MID }))["nonce"]; // draws 0x22 again (seen), re-draws 0x33
    expect(a).not.toBe(b);

    const stuck = createAssertionMinter(opts({ randomBytes: (n) => new Uint8Array(n).fill(0x44) }));
    expect(refusal(() => stuck.mintForSubject({ subject: WA, rid: RID, mid: MID }))).toBe("none");
    expect(refusal(() => stuck.mintForSubject({ subject: WA, rid: RID, mid: MID }))).toBe("nonce_unavailable");
  });

  it("an RNG returning the wrong number of bytes is refused, not padded", () => {
    const short = createAssertionMinter(opts({ randomBytes: () => new Uint8Array(8) }));
    expect(refusal(() => short.mintForSubject({ subject: WA, rid: RID, mid: MID }))).toBe("nonce_unavailable");
  });
});

// ---------------------------------------------------------------------------------------------
describe("loading from the environment (the same validation for the gateway and the runner)", () => {
  const full = {
    [ASSERTION_ENV.environment]: "uat",
    [ASSERTION_ENV.kid]: KID,
    [ASSERTION_ENV.pnid]: PNID,
    [ASSERTION_ENV.key]: KEY,
    [ASSERTION_ENV.fixtureWaId]: WA,
  };

  it("nothing set => off (default, behaviour unchanged)", () => {
    expect(assertionMinterFromEnv({})).toEqual({ mode: "off" });
    expect(assertionMinterFromEnv({ UNRELATED: "x" })).toEqual({ mode: "off" });
  });

  it("everything set => a working fixture minter (POSITIVE CONTROL for the refusals below)", () => {
    const r = assertionMinterFromEnv(full, { nowMs: () => NOW_MS });
    expect(r.mode).toBe("fixture");
    if (r.mode === "fixture") expect(verify(r.minter.mintForSubject({ subject: WA, rid: RID, mid: MID })).ok).toBe(true);
  });

  it("a HALF-configured minter is refused naming each missing variable; each one alone triggers it", () => {
    for (const name of Object.values({ e: ASSERTION_ENV.environment, k: ASSERTION_ENV.kid, p: ASSERTION_ENV.pnid, key: ASSERTION_ENV.key, w: ASSERTION_ENV.fixtureWaId })) {
      const partial = { ...full } as Record<string, string | undefined>;
      delete partial[name];
      const r = assertionMinterFromEnv(partial);
      expect(r.mode, name).toBe("invalid");
      if (r.mode === "invalid") expect(r.problems.join(" ")).toContain(name);
    }
    const only = assertionMinterFromEnv({ [ASSERTION_ENV.kid]: KID });
    expect(only.mode).toBe("invalid");
  });

  it("a *_FILE variable that the entrypoint did NOT materialise is a boot error, not 'off'", () => {
    const r = assertionMinterFromEnv({ [ASSERTION_ENV.keyFile]: "/run/secrets/x" });
    expect(r.mode).toBe("invalid");
    const r2 = assertionMinterFromEnv({ ...full, [ASSERTION_ENV.key]: undefined, [ASSERTION_ENV.keyFile]: "/run/secrets/x" });
    expect(r2.mode).toBe("invalid");
    if (r2.mode === "invalid") expect(r2.problems.join(" ")).toContain(ASSERTION_ENV.key);
  });

  it("the environment guard applies at load (production is refused)", () => {
    const r = assertionMinterFromEnv({ ...full, [ASSERTION_ENV.environment]: "production" });
    expect(r.mode).toBe("invalid");
  });

  it("problems are NAMES only: neither the key nor the wa_id appears", () => {
    const r = assertionMinterFromEnv({ ...full, [ASSERTION_ENV.key]: "tooshort", [ASSERTION_ENV.fixtureWaId]: "0123" });
    expect(r.mode).toBe("invalid");
    const text = JSON.stringify(r);
    expect(text).not.toContain("tooshort");
    expect(text).not.toContain("0123");
  });

  it("the texts loader (what the runner calls) refuses a partial configuration and names exactly the missing variables; it is 'off' only when NOTHING is given", () => {
    const all = { environment: "uat", kid: KID, pnid: PNID, keyText: KEY, waIdText: WA };
    expect(assertionMinterFromTexts({ environment: undefined, kid: undefined, pnid: undefined, keyText: undefined, waIdText: undefined })).toEqual({ mode: "off" });
    expect(assertionMinterFromTexts({ environment: "", kid: "", pnid: "", keyText: "", waIdText: "" })).toEqual({ mode: "off" });
    const cases: Array<[keyof typeof all, string]> = [
      ["environment", ASSERTION_ENV.environment],
      ["kid", ASSERTION_ENV.kid],
      ["pnid", ASSERTION_ENV.pnid],
      ["keyText", ASSERTION_ENV.key],
      ["waIdText", ASSERTION_ENV.fixtureWaId],
    ];
    for (const [field, name] of cases) {
      const r = assertionMinterFromTexts({ ...all, [field]: undefined });
      expect(r, name).toEqual({ mode: "invalid", problems: [name] });
    }
  });

  it("the longest token the minter can produce is far below 2048, so the length cap is a backstop and not a limit", () => {
    const m = createAssertionMinter(opts({ kid: "a".repeat(16), pnid: "9".repeat(20), fixtureWaId: "9".repeat(16) }));
    const t = m.mintForSubject({ subject: "9".repeat(16), rid: "r".repeat(128), mid: "m".repeat(256) });
    expect(t.length).toBeLessThan(1000);
    expect(t.length).toBeLessThanOrEqual(2048);
  });

  it("the texts loader is the same validation (the runner reads FILES and calls it): a key with a trailing newline is refused, a wa_id with one is trimmed", () => {
    const args = { environment: "uat", kid: KID, pnid: PNID, keyText: KEY, waIdText: `${WA}\n`, nowMs: () => NOW_MS };
    expect(assertionMinterFromTexts(args).mode).toBe("fixture");
    expect(assertionMinterFromTexts({ ...args, keyText: `${KEY}\n` }).mode).toBe("invalid");
    expect(assertionMinterFromTexts({ ...args, waIdText: `${WA}\n\n` }).mode).toBe("invalid");
  });
});
