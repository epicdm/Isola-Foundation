/**
 * Structural guard. The security argument for this service — the only publicly
 * exposed Isola component — rests on there being exactly one outbound network
 * primitive, and on there being no shell, no filesystem access and no dynamic
 * code loading anywhere in src/.
 *
 * These are source scans, deliberately: a behavioural test can only prove that
 * the paths it exercises are clean, whereas a scan proves the property for the
 * whole tree, including code added later.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

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
 * Strip comments before scanning. The source deliberately *describes* the
 * forbidden capabilities in its doc comments; the scan is about executable
 * code, so comments must not produce false positives (nor hide a real call —
 * code inside a comment does not run).
 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

const FILES = sourceFiles(SRC_DIR).map((full) => {
  const text = readFileSync(full, "utf8");
  return {
    path: full,
    rel: relative(SRC_DIR, full).split(sep).join("/"),
    text,
    code: stripComments(text),
  };
});

describe("source scan: exactly one network primitive", () => {
  it("finds the source tree", () => {
    expect(FILES.length).toBeGreaterThan(5);
    expect(FILES.map((f) => f.rel)).toContain("egress.ts");
  });

  it("the token `fetch(` appears only in src/egress.ts", () => {
    const offenders = FILES.filter(
      (f) => f.rel !== "egress.ts" && /\bfetch\s*\(/.test(f.code),
    ).map((f) => f.rel);
    expect(offenders).toEqual([]);
  });

  it("egress.ts is the only file that names the platform fetch", () => {
    const offenders = FILES.filter(
      (f) => f.rel !== "egress.ts" && /\bglobalThis\s*\.\s*fetch\b/.test(f.code),
    ).map((f) => f.rel);
    expect(offenders).toEqual([]);
  });

  it("no HTTP client library or raw socket client is imported anywhere", () => {
    const pattern =
      /\b(axios|undici|node-fetch|superagent)\b|from\s+["']node:(https|net|tls|dgram|http2)["']|\bhttps?\s*\.\s*request\s*\(/;
    const offenders = FILES.filter((f) => pattern.test(f.code)).map((f) => f.rel);
    expect(offenders).toEqual([]);
  });

  it("only server.ts imports node:http, and app.ts imports only its types", () => {
    const importers = FILES.filter((f) => /from\s+["']node:http["']/.test(f.code)).map(
      (f) => f.rel,
    );
    expect(importers.sort()).toEqual(["app.ts", "server.ts"]);
    const appSource = FILES.find((f) => f.rel === "app.ts")!;
    expect(appSource.code).toMatch(/import\s+type\s*\{[^}]*\}\s*from\s*["']node:http["']/);
  });

  it("the scan itself is not vacuous", () => {
    for (const f of FILES) {
      expect(f.code.trim().length).toBeGreaterThan(0);
    }
    const egress = FILES.find((f) => f.rel === "egress.ts")!;
    expect(/\bfetch\s*\(/.test(egress.code)).toBe(true);
  });
});

describe("source scan: no tools of any kind", () => {
  const forbidden: Array<[string, RegExp]> = [
    ["child_process / shell", /node:child_process|require\(['"]child_process/],
    ["process spawning helpers", /\b(execSync|spawnSync|exec|spawn|fork)\s*\(\s*['"`]/],
    ["dynamic code loading", /\bnew Function\s*\(|\beval\s*\(/],
    ["vm sandbox", /node:vm\b/],
    ["worker threads", /node:worker_threads\b/],
    ["mcp client", /modelcontextprotocol|\bmcp[-_]?(client|server)\b/i],
    ["plugin loader", /\bloadPlugin\b|\brequirePlugin\b|\bregisterTool\b/],
    // Unlike isola-runtime, this service has NO state directory and therefore
    // no filesystem allowance at all.
    ["filesystem access", /node:fs\b|require\(['"]fs['"]|node:fs\/promises/],
  ];

  for (const [label, pattern] of forbidden) {
    it(`src/ contains no ${label}`, () => {
      const offenders = FILES.filter((f) => pattern.test(f.code)).map((f) => f.rel);
      expect(offenders).toEqual([]);
    });
  }

  it("src/ never references a Paperclip volume or master-key path", () => {
    const pattern = /(master[_-]?key|\/data\/paperclip|paperclip[_-]?volume|\.paperclip\/)/i;
    const offenders = FILES.filter((f) => pattern.test(f.code)).map((f) => f.rel);
    expect(offenders).toEqual([]);
  });
});

describe("source scan: the Chatwoot API is only spoken by one module", () => {
  it("only chatwoot.ts builds an /api/v1/accounts path", () => {
    const offenders = FILES.filter(
      (f) => f.rel !== "chatwoot.ts" && /\/api\/v1\/accounts/.test(f.code),
    ).map((f) => f.rel);
    expect(offenders).toEqual([]);
  });

  it("the api_access_token header is set in exactly one place", () => {
    const offenders = FILES.filter(
      (f) => f.rel !== "chatwoot.ts" && /api_access_token/.test(f.code),
    ).map((f) => f.rel);
    expect(offenders).toEqual([]);
  });
});
