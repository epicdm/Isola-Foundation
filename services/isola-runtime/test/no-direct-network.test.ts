/**
 * Structural guard. The whole security argument for this service rests on there
 * being exactly one outbound network primitive, and on there being no shell, no
 * filesystem access and no dynamic code loading anywhere in src/.
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

  it("only server.ts imports node:http, and only to listen", () => {
    const importers = FILES.filter((f) => /from\s+["']node:http["']/.test(f.code)).map(
      (f) => f.rel,
    );
    // app.ts imports only the request/response TYPES; server.ts creates the listener.
    expect(importers.sort()).toEqual(["app.ts", "server.ts"]);
    const appSource = FILES.find((f) => f.rel === "app.ts")!;
    expect(appSource.code).toMatch(/import\s+type\s*\{[^}]*\}\s*from\s*["']node:http["']/);
  });
});

/**
 * The ONE file permitted to touch the filesystem.
 *
 * The runtime persists idempotency records, the cost-event outbox and the
 * sub-cent accumulator, and the container has no volume — so there has to be a
 * writable path. The concession is deliberately one module wide, and the scans
 * below pin it down rather than merely allowing it: `state.ts` and nothing else
 * may name `node:fs`, and `state.ts` itself may not do any of the other
 * forbidden things.
 */
const FS_ALLOWED_FILE = "state.ts";

describe("source scan: no tools of any kind", () => {
  const forbiddenImports: Array<[string, RegExp]> = [
    ["child_process / shell", /node:child_process|require\(['"]child_process/],
    ["process spawning helpers", /\b(execSync|spawnSync|exec|spawn|fork)\s*\(\s*['"`]/],
    ["dynamic code loading", /\bnew Function\s*\(|\beval\s*\(/],
    ["vm sandbox", /node:vm\b/],
    ["worker threads", /node:worker_threads\b/],
    ["mcp client", /modelcontextprotocol|\bmcp[-_]?(client|server)\b/i],
    ["plugin loader", /\bloadPlugin\b|\brequirePlugin\b|\bregisterTool\b/],
  ];

  for (const [label, pattern] of forbiddenImports) {
    it(`src/ contains no ${label}`, () => {
      const offenders = FILES.filter((f) => pattern.test(f.code)).map((f) => f.rel);
      expect(offenders).toEqual([]);
    });
  }

  const FS_PATTERN = /node:fs\b|require\(['"]fs['"]|node:fs\/promises/;

  it(`only src/${FS_ALLOWED_FILE} touches the filesystem`, () => {
    const offenders = FILES.filter((f) => FS_PATTERN.test(f.code)).map((f) => f.rel);
    expect(offenders).toEqual([FS_ALLOWED_FILE]);
  });

  it("the filesystem allowance is not vacuous — state.ts really does import node:fs", () => {
    const state = FILES.find((f) => f.rel === FS_ALLOWED_FILE);
    expect(state).toBeDefined();
    expect(FS_PATTERN.test(state!.code)).toBe(true);
  });

  it("state.ts imports only the specific fs functions it needs", () => {
    const state = FILES.find((f) => f.rel === FS_ALLOWED_FILE)!;
    const importLine = /import\s*\{([^}]*)\}\s*from\s*["']node:fs["']/.exec(state.code);
    expect(importLine).not.toBeNull();
    const imported = (importLine![1] ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .sort();
    // A deliberately short list. Anything beyond it — rm, chmod, symlink,
    // opendir, watch — is a new capability and must be argued for, not slipped in.
    expect(imported).toEqual(["mkdirSync", "readFileSync", "renameSync", "writeFileSync"]);
    // No namespace import that would smuggle the whole module in.
    expect(/import\s+\*\s+as\s+\w+\s+from\s*["']node:fs/.test(state.code)).toBe(false);
    expect(/from\s*["']node:fs\/promises["']/.test(state.code)).toBe(false);
  });

  it("no file path is ever built from request data", () => {
    const state = FILES.find((f) => f.rel === FS_ALLOWED_FILE)!;
    // Every path is a fixed basename joined onto the configured directory, and
    // resolveStateFile refuses anything that resolves outside it.
    expect(state.code).toMatch(/export function resolveStateFile/);
    expect(state.code).toMatch(/escapes RUNTIME_STATE_DIR/);
    // The only fs targets in the file are the two fields set in the constructor.
    const fsCallTargets = [...state.code.matchAll(/\b(readFileSync|writeFileSync|renameSync)\s*\(\s*([^,)]+)/g)]
      .map((m) => (m[2] ?? "").trim())
      .sort();
    for (const target of fsCallTargets) {
      expect(["this.file", "this.tmpFile"]).toContain(target);
    }
    expect(fsCallTargets.length).toBeGreaterThan(0);
  });

  it("src/ never references a Paperclip volume or master-key path", () => {
    const pattern = /(master[_-]?key|\/data\/paperclip|paperclip[_-]?volume|\.paperclip\/)/i;
    const offenders = FILES.filter((f) => pattern.test(f.code)).map((f) => f.rel);
    expect(offenders).toEqual([]);
  });

  it("the scan itself is not vacuous", () => {
    // Guard against a stripComments() bug silently emptying every file.
    for (const f of FILES) {
      expect(f.code.trim().length).toBeGreaterThan(0);
    }
    const egress = FILES.find((f) => f.rel === "egress.ts")!;
    expect(/\bfetch\s*\(/.test(egress.code)).toBe(true);
  });
});
