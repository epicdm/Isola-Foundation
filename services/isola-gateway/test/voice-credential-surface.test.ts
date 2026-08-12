/**
 * The containment invariant, ported conceptually from PR #100.
 *
 * That P0 shipped because a browser-facing response acquired a credential
 * field, and the defence that finally held was a SOURCE SCAN rather than a
 * behavioural test: a behavioural test proves only the paths it exercises,
 * whereas a scan proves the property for the whole tree, including code added
 * later by someone who never read this file.
 *
 * The property asserted here: a personal-line response can never acquire a
 * credential field, a credential-bearing URI, or a QR encoder co-located with
 * either.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { PERSONAL_LINE_FIELDS, PROHIBITED_FIELDS, projectPersonalLine } from "../src/voice.js";

const SRC_DIR = fileURLToPath(new URL("../src", import.meta.url));

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
 * Strip comments before scanning. This source deliberately *names* the
 * forbidden shapes in its doc comments and in `PROHIBITED_FIELDS`, so comments
 * must not produce false positives. Code inside a comment does not run.
 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

const FILES = sourceFiles(SRC_DIR).map((full) => {
  const text = readFileSync(full, "utf8");
  return {
    rel: relative(SRC_DIR, full).split(sep).join("/"),
    code: stripComments(text),
  };
});

/** `voice.ts` legitimately names the prohibited keys — that IS the denylist. */
const DENYLIST_HOME = "voice.ts";

describe("source scan: no credential ever reaches a personal-line response", () => {
  it("finds the source tree", () => {
    expect(FILES.length).toBeGreaterThan(5);
    expect(FILES.map((f) => f.rel)).toContain("voice.ts");
  });

  it("no module builds a SIP password field into a response", () => {
    const offenders = FILES.filter(
      (f) => f.rel !== DENYLIST_HOME && /\bsip_password\b|\bsipPassword\b/.test(f.code),
    ).map((f) => f.rel);
    expect(offenders).toEqual([]);
  });

  it("the csc: provisioning scheme appears nowhere in src/", () => {
    const offenders = FILES.filter(
      (f) => f.rel !== DENYLIST_HOME && /\bcsc:/i.test(f.code),
    ).map((f) => f.rel);
    expect(offenders).toEqual([]);
  });

  it("no module builds a user:password@host URI", () => {
    const pattern = /[a-z][a-z0-9+.-]*:\/\/\$\{[^}]*\}:\$\{[^}]*\}@|:\$\{[^}]*\}@/;
    const offenders = FILES.filter((f) => pattern.test(f.code)).map((f) => f.rel);
    expect(offenders).toEqual([]);
  });

  it("no QR encoder is imported or referenced anywhere", () => {
    const pattern = /\bqrcode\b|\bqr[-_]?code\b|\btoDataURL\b|\bQRCode\b/i;
    const offenders = FILES.filter(
      (f) => f.rel !== DENYLIST_HOME && pattern.test(f.code),
    ).map((f) => f.rel);
    expect(offenders).toEqual([]);
  });

  it("the projection allowlist is exactly the seven approved fields", () => {
    // Pinning the list here means widening it is a deliberate edit to a test
    // named "credential surface", not an incidental change to a type.
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
    // Drive the projection with an upstream record that carries EVERY
    // prohibited field, and assert none survives.
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
    const voice = FILES.find((f) => f.rel === DENYLIST_HOME)!;
    expect(/sip_password/.test(voice.code)).toBe(true);
  });
});
