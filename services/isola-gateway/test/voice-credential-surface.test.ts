/**
 * The containment invariant, ported conceptually from PR #100.
 *
 * That P0 shipped because a browser-facing response acquired a credential
 * field, and the defence that finally held was a SOURCE SCAN rather than a
 * behavioural test: a behavioural test proves only the paths it exercises,
 * whereas a scan proves the property for the whole tree, including code added
 * later by someone who never read this file.
 *
 * THE BLIND SPOT THIS REVISION CLOSES. The first version exempted the whole of
 * `voice.ts` from the prohibited-name, `csc:` and QR checks, because that file
 * housed the denylist. But `voice.ts` is also where the browser projection and
 * the Magnus adapter live — so a credential construction added to the single
 * most important file in the feature would have passed the scan.
 *
 * The declarations now live in `voice-policy.ts`, which declares and executes
 * nothing. That file is the ONLY exemption, and a separate assertion pins it to
 * being declaration-only so it cannot quietly grow logic and become a new blind
 * spot. `voice.ts` is scanned in full.
 *
 * The scan is proved by a mutation negative control: a credential construction
 * is injected into a copy of `voice.ts` and the scanner must reject it.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { projectPersonalLine } from "../src/voice.js";
import { PERSONAL_LINE_FIELDS, PROHIBITED_FIELDS } from "../src/voice-policy.js";

const SRC_DIR = fileURLToPath(new URL("../src", import.meta.url));

/** The ONLY exempt file: declarations, no logic. */
const POLICY_FILE = "voice-policy.ts";

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out.sort();
}

/**
 * Strip comments before scanning. The source deliberately *describes* the
 * forbidden shapes in its doc comments, so comments must not produce false
 * positives — and code inside a comment does not run.
 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

/**
 * Every check the invariant makes, as data, so the same rules can be run
 * against the real tree AND against a deliberately corrupted copy.
 */
export const CREDENTIAL_PATTERNS: Array<[string, RegExp]> = [
  // Credential field names and their camelCase aliases.
  ["a SIP password field", /\bsip_password\b|\bsipPassword\b|\bsipPass\b|\bsip_pass\b/],
  ["a SIP secret field", /\bsip_secret\b|\bsipSecret\b/],
  ["an auth password field", /\bauth_password\b|\bauthPassword\b|\bha1\b/],
  // The Acrobits provisioning scheme with ANY slash count — `\/*`, not a
  // bounded range. A bounded {0,2} matched the examples but not the stated
  // property, and would have missed `csc:///…`.
  ["the csc: provisioning scheme", /csc:\/*/i],
  // scheme://user:password@host, including template-interpolated forms.
  [
    "a user:password@host URI",
    /[a-z][a-z0-9+.-]*:\/\/[^\s/:@"'`]+:[^\s/@"'`]+@|:\$\{[^}]*\}@/i,
  ],
  // QR encoders and the data URI a QR payload travels in.
  ["a QR encoder", /\bqrcode\b|\bqr[-_]?code\b|\btoDataURL\b|\bQRCode\b/i],
  ["a data: image URI", /data:image\//i],
  // Credential-bearing response properties and serialisers.
  [
    "a credential-bearing response property",
    /\b(provisioning_url|provisioningUrl|provisioning_uri|provisioningUri|csc_url|cscUrl|config_url|configUrl|qr_payload|qrPayload)\b/,
  ],
];

const FILES = sourceFiles(SRC_DIR).map((full) => {
  const text = readFileSync(full, "utf8");
  return {
    rel: relative(SRC_DIR, full).split(sep).join("/"),
    text,
    code: stripComments(text),
  };
});

/** Run the invariant over a set of (name, code) pairs. Returns offenders. */
export function scanForCredentials(
  files: ReadonlyArray<{ rel: string; code: string }>,
): string[] {
  const offenders: string[] = [];
  for (const [label, pattern] of CREDENTIAL_PATTERNS) {
    for (const f of files) {
      if (f.rel === POLICY_FILE) continue;
      if (pattern.test(f.code)) offenders.push(`${f.rel}: ${label}`);
    }
  }
  return offenders.sort();
}

describe("source scan: no credential ever reaches a personal-line response", () => {
  it("finds the source tree, including the file that does the projecting", () => {
    expect(FILES.length).toBeGreaterThan(5);
    const names = FILES.map((f) => f.rel);
    expect(names).toContain("voice.ts");
    expect(names).toContain(POLICY_FILE);
  });

  it("voice.ts is NOT exempt from the scan", () => {
    // Guards against a future revision quietly reintroducing the blind spot.
    const scanned = FILES.filter((f) => f.rel !== POLICY_FILE).map((f) => f.rel);
    expect(scanned).toContain("voice.ts");
    expect(scanned).toContain("app.ts");
  });

  it("the whole src/ tree is clean of every credential pattern", () => {
    expect(scanForCredentials(FILES)).toEqual([]);
  });

  /**
   * The exemption is only safe while the exempt file cannot *do* anything.
   * If it grows a function, the exemption becomes a hiding place again.
   */
  it("the exempt policy file declares and does not execute", () => {
    const policy = FILES.find((f) => f.rel === POLICY_FILE);
    expect(policy).toBeDefined();
    const code = policy!.code;
    expect(/\bfunction\b/.test(code)).toBe(false);
    expect(/=>/.test(code)).toBe(false);
    expect(/\bclass\b/.test(code)).toBe(false);
    expect(/\bimport\b/.test(code)).toBe(false);
    expect(/\bfetch\s*\(/.test(code)).toBe(false);
    // Only `export const` / `export type` declarations.
    for (const line of code.split("\n")) {
      const t = line.trim();
      if (t.length === 0) continue;
      if (/^(export (const|type)|type |\]|\)|\}|"|'|\/)/.test(t)) continue;
      expect(t).toMatch(/^[A-Za-z0-9_"'`,.:|/\\[\](){}<>=?+*{}$ -]*$/);
    }
  });

  /**
   * NEGATIVE CONTROL. A scan that never fails proves nothing, so inject each
   * forbidden construction into a copy of the real `voice.ts` and require the
   * scanner to catch it. If any of these passes, the invariant is decorative.
   */
  describe("mutation negative control", () => {
    const realVoice = FILES.find((f) => f.rel === "voice.ts")!;

    const MUTATIONS: Array<[string, string]> = [
      ["a sip_password projection", `out["sip_password"] = upstream["sip_password"];`],
      ["a camelCase alias", `const sipPassword = upstream.secret;`],
      ["a csc: link build", 'const link = "csc:" + user + ":" + pass + "@EPIC";'],
      ["a csc:// link build", 'const link = "csc://" + user + ":" + pass + "@EPIC";'],
      ["a csc:/// link build", 'const link = "csc:///" + user + ":" + pass + "@EPIC";'],
      ["a csc://// link build", 'const link = "csc:////" + user + ":" + pass + "@EPIC";'],
      ["a user:password@host URI", 'const u = "sip://alice:hunter2000@voice00.epic.dm";'],
      ["an interpolated credential URI", "const u = `sip://${user}:${pass}@${host}`;"],
      ["a QR encoder import", 'import QRCode from "qrcode";'],
      ["a QR data URI", 'const img = "data:image/png;base64," + payload;'],
      ["a provisioning_url property", `out["provisioning_url"] = built;`],
    ];

    for (const [label, injected] of MUTATIONS) {
      it(`fails when ${label} is inserted into voice.ts`, () => {
        const mutated = [
          { rel: "voice.ts", code: stripComments(realVoice.text + "\n" + injected) },
        ];
        const offenders = scanForCredentials(mutated);
        expect(offenders.length).toBeGreaterThan(0);
      });
    }

    it("the unmutated file passes, so the control is not trivially always-red", () => {
      expect(scanForCredentials([{ rel: "voice.ts", code: realVoice.code }])).toEqual([]);
    });
  });

  it("the projection allowlist is exactly the seven approved fields", () => {
    expect([...PERSONAL_LINE_FIELDS]).toEqual([
      "state",
      "sip_username",
      "activation_state",
      "did_number",
      "registration_server",
      "forward_to_cell",
      "cell_number",
    ]);
  });

  it("no prohibited field name is reachable through the projection", () => {
    const hostile: Record<string, unknown> = {};
    for (const field of PROHIBITED_FIELDS) hostile[field] = "s3cret-value-1234";
    for (const field of PERSONAL_LINE_FIELDS) hostile[field] = "ok";

    const projected = projectPersonalLine(hostile) as Record<string, unknown>;
    for (const field of PROHIBITED_FIELDS) {
      expect(projected[field]).toBeUndefined();
    }
    expect(Object.keys(projected).sort()).toEqual([...PERSONAL_LINE_FIELDS].sort());
  });

  it("the scan itself is not vacuous", () => {
    for (const f of FILES) expect(f.code.trim().length).toBeGreaterThan(0);
    // The policy file really does contain the names, so the exemption matters.
    const policy = FILES.find((f) => f.rel === POLICY_FILE)!;
    expect(/sip_password/.test(policy.code)).toBe(true);
  });
});
