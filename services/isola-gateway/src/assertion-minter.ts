/**
 * The FIXTURE assertion MINTER. UAT ONLY. Not a production minter.
 *
 * WHAT IT IS
 *   The pl-concierge service takes the customer's identity from a signed assertion, never from the model
 *   (contract s.3): `v1.<P>.<S>`, P = base64url(payload JSON bytes), S = base64url(HMAC-SHA256(key,
 *   "v1." + P)). This module signs ONE such assertion per inbound message, for ONE fixture subject, so the
 *   four read tools can be exercised end to end on the UAT test inbox before any real channel-verified
 *   identity exists. It follows lane 59's C5 spec and the deployed verifier (bff-v2 d736dbf3a,
 *   app/lib/pl-concierge/assertion.ts), against which test/assertion-minter.test.ts checks it.
 *
 * WHAT IT REFUSES, INDEPENDENTLY OF EVERY CALLER (the owner's conditions, 2026-10-03)
 *   - The wa_id that is signed is the CONFIGURED fixture wa_id and nothing else. There is no parameter that
 *     carries a wa_id into the payload. The caller offers a SUBJECT (the channel-bound identifier of the
 *     conversation); it is compared with the configured wa_id and anything else is refused with no token.
 *   - It cannot emit `act` or `act_src` (provisioning stays off): the payload is built from a fixed list of
 *     seven fields, so there is no code path that adds an eighth.
 *   - It constructs only when GATEWAY_ASSERTION_ENV is exactly `uat`.
 *   - It never reuses a nonce (a bounded memory of recent ones, re-draw on a repeat, refuse when stuck).
 *
 * KEY HANDLING
 *   The key and the fixture wa_id arrive as the VALUES of GATEWAY_ASSERTION_KEY and
 *   GATEWAY_ASSERTION_FIXTURE_WA_ID. In the container those are materialised by `entrypoint.sh` from the
 *   mounted Swarm secrets named by GATEWAY_ASSERTION_KEY_FILE and GATEWAY_ASSERTION_FIXTURE_WA_ID_FILE
 *   (`FOO_FILE=/run/secrets/x -> FOO=<contents>`, the convention every other secret here uses). THIS MODULE
 *   READS NO FILE: `node:fs` appears nowhere in src/ and test/no-direct-network.test.ts asserts it. The
 *   standalone runner (tools/mint-and-run.mjs, outside src/) reads the files itself and calls the same
 *   validation (`assertionMinterFromTexts`), so the two cannot drift.
 *   The key is used as its exact UTF-8 bytes, like the verifier (which does NOT trim it). A key with ANY
 *   whitespace, control or non-printable character is refused: a silently trimmed key would sign with
 *   different bytes than the verifier holds and fail in a confusing way. Lane 59 generates 64 lowercase hex
 *   characters. The key is never logged, never in an error, and the object has no member that returns it.
 *
 * NOT VERIFIED HERE: the live verifier's behaviour, the real secret mount, and that the key in the
 * gateway's secret equals the key in bff-v2's env file (value-blind by design).
 */
import { createHmac, randomBytes as nodeRandomBytes } from "node:crypto";

import { hermesSessionLabel } from "./hermes-input.js";
import type { HermesAssertionInput, HermesAssertionProvider } from "./hermes-runtime.js";
import type { Logger } from "./log.js";

export const ASSERTION_ENV = {
  environment: "GATEWAY_ASSERTION_ENV",
  key: "GATEWAY_ASSERTION_KEY",
  keyFile: "GATEWAY_ASSERTION_KEY_FILE",
  fixtureWaId: "GATEWAY_ASSERTION_FIXTURE_WA_ID",
  fixtureWaIdFile: "GATEWAY_ASSERTION_FIXTURE_WA_ID_FILE",
  kid: "GATEWAY_ASSERTION_KID",
  pnid: "GATEWAY_ASSERTION_PNID",
} as const;

/** The only value of GATEWAY_ASSERTION_ENV that lets a minter exist. */
export const REQUIRED_ASSERTION_ENVIRONMENT = "uat";

const MIN_KEY_BYTES = 32;
const MAX_TOKEN_CHARS = 2048;
const KID_RE = /^[a-z0-9]{1,16}$/;
const WA_ID_RE = /^[1-9][0-9]{6,15}$/;
const PNID_RE = /^[0-9]{5,20}$/;
const RID_RE = /^[\x21-\x7E]{1,128}$/;
const MID_RE = /^[^\u0000-\u001F\u007F]{1,256}$/;
const KEY_PRINTABLE_RE = /^[\x21-\x7E]+$/;
const NONCE_BYTES = 16;
const NONCE_DRAWS = 4;
const RECENT_NONCES = 4096;

/** Names only (environment variable names), never a value. */
export class AssertionMinterConfigError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super("assertion minter: invalid configuration");
    this.name = "AssertionMinterConfigError";
    this.problems = [...new Set(problems)];
  }
}

export type MintRefusalCode = "subject_not_fixture" | "no_subject" | "bad_rid" | "bad_mid" | "too_long" | "nonce_unavailable";

/** A refusal carries a code and nothing else: no subject, no key, no token. */
export class AssertionRefused extends Error {
  readonly code: MintRefusalCode;
  constructor(code: MintRefusalCode) {
    super(`assertion refused: ${code}`);
    this.name = "AssertionRefused";
    this.code = code;
  }
}

export interface AssertionMinter {
  /**
   * Sign one assertion for `rid` (the conversation id the tool will send as X-Conversation-Id) and `mid`
   * (the inbound message id), IF AND ONLY IF `subject` is the configured fixture subject. Throws
   * AssertionRefused otherwise. There is no way to choose the wa_id.
   */
  mintForSubject(args: { subject: unknown; rid: string; mid: string }): string;
}

export interface MinterOptions {
  key: string;
  kid: string;
  pnid: string;
  /** The ONE fixture subject, E.164 digits without '+'. */
  fixtureWaId: string;
  /** Must be exactly "uat". */
  environment: string | undefined;
  nowMs?: () => number;
  randomBytes?: (n: number) => Uint8Array;
}

/** Problems with a key's TEXT (names of the rules, never the key). Empty = acceptable. */
export function validateKeyText(text: string): string[] {
  const problems: string[] = [];
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") < MIN_KEY_BYTES) problems.push("too_short");
  if (typeof text !== "string" || !KEY_PRINTABLE_RE.test(text)) problems.push("whitespace_or_non_printable");
  return problems;
}

/** The fixture wa_id FILE: ONE trailing newline (\n or \r\n) is trimmed, nothing else; must be the E.164 digits. */
export function normaliseFixtureWaId(text: string): string | null {
  if (typeof text !== "string") return null;
  const trimmed = text.endsWith("\r\n") ? text.slice(0, -2) : text.endsWith("\n") ? text.slice(0, -1) : text;
  return WA_ID_RE.test(trimmed) ? trimmed : null;
}

/** A channel-bound subject: ONE leading '+' is tolerated, then digits only. Anything else is not a subject. */
export function normaliseSubject(subject: unknown): string | null {
  if (typeof subject !== "string") return null;
  const digits = subject.startsWith("+") ? subject.slice(1) : subject;
  return /^[0-9]+$/.test(digits) ? digits : null;
}

const REDACTED = "[AssertionMinter: redacted]";
const INSPECT = Symbol.for("nodejs.util.inspect.custom");

class FixtureAssertionMinter implements AssertionMinter {
  readonly #key: Buffer;
  readonly #kid: string;
  readonly #pnid: string;
  readonly #waId: string;
  readonly #nowMs: () => number;
  readonly #random: (n: number) => Uint8Array;
  readonly #recent = new Set<string>();

  constructor(o: MinterOptions) {
    const problems: string[] = [];
    if (o.environment !== REQUIRED_ASSERTION_ENVIRONMENT) problems.push(ASSERTION_ENV.environment);
    if (validateKeyText(o.key).length > 0) problems.push(ASSERTION_ENV.key);
    if (typeof o.kid !== "string" || !KID_RE.test(o.kid) || o.kid === "v1") problems.push(ASSERTION_ENV.kid);
    if (typeof o.pnid !== "string" || !PNID_RE.test(o.pnid)) problems.push(ASSERTION_ENV.pnid);
    if (typeof o.fixtureWaId !== "string" || !WA_ID_RE.test(o.fixtureWaId)) problems.push(ASSERTION_ENV.fixtureWaId);
    if (problems.length > 0) throw new AssertionMinterConfigError(problems);
    this.#key = Buffer.from(o.key, "utf8");
    this.#kid = o.kid;
    this.#pnid = o.pnid;
    this.#waId = o.fixtureWaId;
    this.#nowMs = o.nowMs ?? Date.now;
    this.#random = o.randomBytes ?? ((n) => nodeRandomBytes(n));
  }

  mintForSubject(args: { subject: unknown; rid: string; mid: string }): string {
    // Only these three fields are read. Anything else a caller passes (a wa_id, an act) is ignored.
    const subject = args?.subject;
    const rid = args?.rid;
    const mid = args?.mid;

    if (subject === null || subject === undefined || subject === "") throw new AssertionRefused("no_subject");
    const normalised = normaliseSubject(subject);
    if (normalised === null || normalised !== this.#waId) throw new AssertionRefused("subject_not_fixture");
    if (typeof rid !== "string" || !RID_RE.test(rid)) throw new AssertionRefused("bad_rid");
    if (typeof mid !== "string" || !MID_RE.test(mid)) throw new AssertionRefused("bad_mid");

    const nonce = this.#freshNonce();
    // A FIXED list of seven fields, in this order, serialised once: the service never re-serialises, so
    // these are the signed bytes. There is no `act` and no `act_src` anywhere in this function.
    const payload = {
      kid: this.#kid,
      wa_id: this.#waId,
      pnid: this.#pnid,
      rid,
      mid,
      iat: Math.floor(this.#nowMs() / 1000),
      nonce,
    };
    const p = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
    const s = createHmac("sha256", this.#key).update(`v1.${p}`, "utf8").digest("base64url");
    const token = `v1.${p}.${s}`;
    if (token.length > MAX_TOKEN_CHARS) throw new AssertionRefused("too_long");
    this.#remember(nonce);
    return token;
  }

  #freshNonce(): string {
    for (let i = 0; i < NONCE_DRAWS; i += 1) {
      const bytes = this.#random(NONCE_BYTES);
      if (!(bytes instanceof Uint8Array) || bytes.length !== NONCE_BYTES) throw new AssertionRefused("nonce_unavailable");
      const nonce = Buffer.from(bytes).toString("base64url");
      if (!this.#recent.has(nonce)) return nonce;
    }
    throw new AssertionRefused("nonce_unavailable");
  }

  #remember(nonce: string): void {
    this.#recent.add(nonce);
    if (this.#recent.size > RECENT_NONCES) {
      const oldest = this.#recent.values().next().value;
      if (oldest !== undefined) this.#recent.delete(oldest);
    }
  }

  toString(): string {
    return REDACTED;
  }
  toJSON(): string {
    return REDACTED;
  }
  [INSPECT](): string {
    return REDACTED;
  }
}

export function createAssertionMinter(options: MinterOptions): AssertionMinter {
  return new FixtureAssertionMinter(options);
}

export type MinterFromEnv =
  | { mode: "off" }
  | { mode: "fixture"; minter: AssertionMinter }
  | { mode: "invalid"; problems: string[] };

/**
 * The shared loader. The gateway calls it (through `assertionMinterFromEnv`) with the values the entrypoint
 * materialised; the standalone runner calls it with the contents of the files it read. `off` only when
 * NOTHING is configured; a partial configuration is `invalid` and names each missing variable.
 */
export function assertionMinterFromTexts(args: {
  environment: string | undefined;
  kid: string | undefined;
  pnid: string | undefined;
  keyText: string | undefined;
  waIdText: string | undefined;
  nowMs?: () => number;
  randomBytes?: (n: number) => Uint8Array;
}): MinterFromEnv {
  const present = (v: string | undefined): v is string => typeof v === "string" && v.length > 0;
  if (![args.environment, args.kid, args.pnid, args.keyText, args.waIdText].some(present)) return { mode: "off" };

  const missing: string[] = [];
  if (!present(args.environment)) missing.push(ASSERTION_ENV.environment);
  if (!present(args.kid)) missing.push(ASSERTION_ENV.kid);
  if (!present(args.pnid)) missing.push(ASSERTION_ENV.pnid);
  if (!present(args.keyText)) missing.push(ASSERTION_ENV.key);
  if (!present(args.waIdText)) missing.push(ASSERTION_ENV.fixtureWaId);
  if (missing.length > 0) return { mode: "invalid", problems: missing };

  const waId = normaliseFixtureWaId(args.waIdText as string);
  if (waId === null) return { mode: "invalid", problems: [ASSERTION_ENV.fixtureWaId] };
  try {
    return {
      mode: "fixture",
      minter: createAssertionMinter({
        key: args.keyText as string,
        kid: args.kid as string,
        pnid: args.pnid as string,
        fixtureWaId: waId,
        environment: args.environment,
        ...(args.nowMs === undefined ? {} : { nowMs: args.nowMs }),
        ...(args.randomBytes === undefined ? {} : { randomBytes: args.randomBytes }),
      }),
    };
  } catch (e) {
    if (e instanceof AssertionMinterConfigError) return { mode: "invalid", problems: e.problems };
    return { mode: "invalid", problems: ["assertion_minter_unexpected_error"] };
  }
}

/**
 * From the process environment. DEFAULT OFF: with no GATEWAY_ASSERTION_* variable set the result is `off`
 * and nothing about the gateway changes. A `*_FILE` variable that is still set means the entrypoint did not
 * materialise it: that is a boot error, never "off".
 */
export function assertionMinterFromEnv(
  env: Record<string, string | undefined>,
  overrides: { nowMs?: () => number; randomBytes?: (n: number) => Uint8Array } = {},
): MinterFromEnv {
  const get = (name: string): string | undefined => {
    const v = env[name];
    return typeof v === "string" && v.length > 0 ? v : undefined;
  };
  const anyConfigured = Object.values(ASSERTION_ENV).some((name) => get(name) !== undefined);
  if (!anyConfigured) return { mode: "off" };

  const r = assertionMinterFromTexts({
    environment: get(ASSERTION_ENV.environment),
    kid: get(ASSERTION_ENV.kid),
    pnid: get(ASSERTION_ENV.pnid),
    keyText: get(ASSERTION_ENV.key),
    waIdText: get(ASSERTION_ENV.fixtureWaId),
    ...overrides,
  });
  // A still-set *_FILE variable is reported against the variable it should have become.
  if (r.mode === "off") return { mode: "invalid", problems: [ASSERTION_ENV.environment, ASSERTION_ENV.kid, ASSERTION_ENV.pnid, ASSERTION_ENV.key, ASSERTION_ENV.fixtureWaId] };
  return r;
}

// ---------------------------------------------------------------------------------------------
// The provider: "this conversation IS the fixture"
// ---------------------------------------------------------------------------------------------

/** What the Hermes runtime hands the provider. `channelSubject` is the coherent, signed-payload subject. */
export interface FixtureAssertionInput extends HermesAssertionInput {
  /**
   * `conversation.contact_inbox.source_id` from the SIGNED webhook payload, after the same coherence checks the
   * customer scope uses (sender is the contact, the contact_inbox is this contact's and this inbox's). Null/absent
   * = no channel-bound subject. It is NEVER taken from the message text, the transcript, the editable contact
   * phone or a model/tool argument.
   */
  channelSubject?: string | null;
}

/**
 * The `Isola assertion:` provider for the FIXTURE slice. The conversation IS the fixture only when its
 * channel-bound subject equals the minter's configured wa_id (digits, one leading '+' tolerated); any other
 * sender, a missing subject, a missing message id, an unusable conversation identity or ANY minter failure
 * yields `null`, which the runtime renders as `Isola assertion: none` and the business tools then refuse.
 * A failure here never fails the turn and never produces a half token. The rid it signs is the very label the
 * `Conversation id:` line carries (the verifier compares rid with the X-Conversation-Id the tool sends).
 * Log lines carry reason CODES only.
 */
export function createFixtureAssertionProvider(args: { minter: AssertionMinter; logger?: Logger }): HermesAssertionProvider {
  const note = (outcome: string, reason: string, level: "info" | "warn"): void => {
    args.logger?.[level]({ event: "assertion", outcome, reason });
  };
  return {
    async assertionFor(input: HermesAssertionInput): Promise<string | null> {
      const subject = (input as FixtureAssertionInput).channelSubject;
      if (typeof input.messageId !== "number" || !Number.isSafeInteger(input.messageId) || input.messageId <= 0) {
        note("no_assertion", "no_message_id", "info");
        return null;
      }
      let rid: string;
      try {
        rid = hermesSessionLabel({
          tenantId: input.tenantId,
          accountId: input.accountId,
          inboxId: input.inboxId,
          conversationId: input.conversationId,
        });
      } catch {
        note("no_assertion", "no_conversation_identity", "warn");
        return null;
      }
      try {
        const token = args.minter.mintForSubject({ subject: subject ?? null, rid, mid: String(input.messageId) });
        note("minted", "fixture_subject", "info");
        return token;
      } catch (e) {
        if (e instanceof AssertionRefused) {
          // not the fixture is the ordinary case for every other customer; the others are worth a warning
          note("no_assertion", e.code, e.code === "subject_not_fixture" || e.code === "no_subject" ? "info" : "warn");
        } else {
          note("no_assertion", "mint_error", "warn");
        }
        return null;
      }
    },
  };
}

/**
 * Boot cross-checks that need more than the minter's own variables (pure; server.ts calls it and refuses to
 * start on any entry). NAMES only. `off` checks nothing: with no GATEWAY_ASSERTION_* variable the gateway is
 * byte-for-byte what it was.
 */
export function assertionBootErrors(args: {
  minter: MinterFromEnv;
  hermesAgentIds: readonly string[];
  customerScopeMode: "off" | "fail_closed" | "fixture";
}): string[] {
  if (args.minter.mode === "off") return [];
  if (args.minter.mode === "invalid") {
    return [`The assertion minter is half-configured or invalid; fix these variables (names only): ${args.minter.problems.join(", ")}.`];
  }
  const errors: string[] = [];
  if (args.hermesAgentIds.length === 0) {
    errors.push("The assertion minter is configured but GATEWAY_HERMES_AGENT_IDS is empty: only the direct Hermes path uses an assertion, so nothing could ever use it.");
  }
  if (args.customerScopeMode !== "fixture") {
    errors.push("The assertion minter is configured but GATEWAY_CUSTOMER_SCOPE_MODE is not \"fixture\": an assertion is minted only for a sender whose customer scope is verified, so no sender would ever get one.");
  }
  return errors;
}