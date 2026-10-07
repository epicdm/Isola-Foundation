import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startMockPort, MOCK_CLIENT_ID, MOCK_CLIENT_SECRET, type MockPort } from "./helpers/mockPort.js";
import { seedEntities, longPlan } from "./helpers/fixtures.js";
import { resolveCredentials } from "../src/credentials.js";

const root = resolve(__dirname, "..");
const entry = join(root, "dist", "stdio.js");
let mock: MockPort;
let dir: string;

beforeAll(async () => {
  execSync("npx tsc -p tsconfig.json", { cwd: root, stdio: "pipe" });
  expect(existsSync(entry)).toBe(true);
  mock = await startMockPort(seedEntities());
  dir = mkdtempSync(join(tmpdir(), "portmcp-stdio-"));
}, 120000);
afterAll(async () => {
  await mock.close();
  rmSync(dir, { recursive: true, force: true });
});

function cleanEnv(extra: Record<string, string>): Record<string, string> {
  const base: Record<string, string> = {};
  for (const k of ["PATH", "Path", "SystemRoot", "TEMP", "TMP", "HOME", "USERPROFILE"]) if (process.env[k]) base[k] = process.env[k]!;
  return { ...base, ...extra };
}

interface RawResult { stdout: string; stderr: string; responses: any[] }

/** Drive the server with raw newline-delimited JSON-RPC so stdout can be inspected byte for byte. */
async function runRaw(env: Record<string, string>, calls: { name: string; arguments: any }[]): Promise<RawResult> {
  const child = spawn(process.execPath, [entry], { cwd: dir, env: cleanEnv(env), stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));
  const send = (m: unknown) => child.stdin.write(JSON.stringify(m) + "\n");
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } } });
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  calls.forEach((c, i) => send({ jsonrpc: "2.0", id: 10 + i, method: "tools/call", params: c }));
  const want = 1 + calls.length; // tools/list + each call
  const t0 = Date.now();
  const parsed = () => stdout.split("\n").filter((l) => l.trim()).map((l) => { try { return JSON.parse(l); } catch { return null; } });
  while (parsed().filter((p) => p && p.id !== undefined && p.id !== 1).length < want && Date.now() - t0 < 20000) {
    await new Promise((r) => setTimeout(r, 25));
  }
  child.stdin.end();
  await new Promise((r) => { child.on("close", r); setTimeout(() => { child.kill(); r(null); }, 3000); });
  return { stdout, stderr, responses: parsed().filter(Boolean) };
}

const toolText = (res: any) => JSON.parse(res.result.content[0].text);

describe("stdio end to end (SDK client)", () => {
  it("lists the tool set and serves read_record and list_records", async () => {
    const auditPath = join(dir, "e2e-audit.log");
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [entry],
      cwd: dir,
      env: cleanEnv({
        PORT_API_BASE_URL: mock.url,
        PORT_CLIENT_ID: MOCK_CLIENT_ID,
        PORT_CLIENT_SECRET: MOCK_CLIENT_SECRET,
        PORT_MCP_AUDIT_LOG: auditPath
      }),
      stderr: "pipe"
    });
    const client = new Client({ name: "t", version: "0" });
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name);
      for (const n of ["read_record", "list_records", "search_port", "get_entity", "list_decisions", "list_open_blockers", "list_recent_port_activity"]) {
        expect(names).toContain(n);
      }
      const legacy = tools.find((t) => t.name === "get_release_board")!;
      expect(legacy.description).toContain("LEGACY");

      const rr: any = await client.callTool({ name: "read_record", arguments: { blueprint: "execution_plan", id: "plan-internal-agent", max_chars: 500 } });
      const body = JSON.parse((rr.content as any)[0].text);
      expect(body.identifier).toBe("plan-internal-agent");
      expect(body.texts.plan.text).toBe(longPlan().slice(0, 500));
      expect(body.texts.plan.next_offset).toBe(500);

      const lr: any = await client.callTool({ name: "list_records", arguments: { blueprint: "decision" } });
      const lb = JSON.parse((lr.content as any)[0].text);
      expect(lb.items.map((i: any) => i.identifier)).toEqual(["dec-1"]);

      const bad: any = await client.callTool({ name: "read_record", arguments: { blueprint: "customer", id: "cust-1" } });
      expect(JSON.parse((bad.content as any)[0].text).error).toContain("not in the allowlist");

      expect(readFileSync(auditPath, "utf8")).toContain("read_record");
    } finally {
      await client.close();
    }
  }, 60000);
});

describe("stdio raw protocol hygiene and credentials", () => {
  it("writes only JSON-RPC frames to stdout; diagnostics go to stderr", async () => {
    const r = await runRaw(
      { PORT_API_BASE_URL: mock.url, PORT_CLIENT_ID: MOCK_CLIENT_ID, PORT_CLIENT_SECRET: MOCK_CLIENT_SECRET, PORT_MCP_AUDIT_LOG: join(dir, "raw-audit.log") },
      [{ name: "read_record", arguments: { blueprint: "execution_plan", id: "plan-older" } }]
    );
    const lines = r.stdout.split("\n").filter((l) => l.trim());
    expect(lines.length).toBeGreaterThanOrEqual(3);
    for (const l of lines) {
      const o = JSON.parse(l); // throws if anything non-JSON was printed
      expect(o.jsonrpc).toBe("2.0");
    }
    expect(r.stderr).toContain("stdio server ready");
    expect(toolText(r.responses.find((x) => x.id === 10)).identifier).toBe("plan-older");
  }, 60000);

  it("credentials missing: tools/list works, data tools return unavailable (and stdout stays clean)", async () => {
    const r = await runRaw({ PORT_API_BASE_URL: mock.url, PORT_MCP_AUDIT_LOG: join(dir, "nocred-audit.log") }, [
      { name: "read_record", arguments: { blueprint: "execution_plan", id: "plan-older" } },
      { name: "list_records", arguments: { blueprint: "decision" } },
      { name: "search_port", arguments: { query: "x" } },
      { name: "get_entity", arguments: { id: "dec-1", blueprint: "decision" } },
      { name: "list_decisions", arguments: {} },
      { name: "list_open_blockers", arguments: {} },
      { name: "list_recent_port_activity", arguments: {} }
    ]);
    const list = r.responses.find((x) => x.id === 2);
    expect(list.result.tools.length).toBeGreaterThanOrEqual(7);
    for (let i = 0; i < 7; i++) {
      expect(toolText(r.responses.find((x) => x.id === 10 + i))).toEqual({ status: "unavailable", reason: "credentials_not_configured" });
    }
    for (const l of r.stdout.split("\n").filter((l) => l.trim())) JSON.parse(l);
    expect(r.stderr).toContain("credentials_not_configured");
  }, 60000);

  describe("credential files", () => {
    // Fake per-run values; the mock only accepts these.
    const idFile = () => join(dir, "client_id");
    const secretFile = () => join(dir, "client_secret");

    function writeCreds() {
      writeFileSync(idFile(), MOCK_CLIENT_ID + "\n");
      writeFileSync(secretFile(), MOCK_CLIENT_SECRET + "\r\n");
      if (process.platform !== "win32") { chmodSync(idFile(), 0o600); chmodSync(secretFile(), 0o600); }
    }

    it("uses *_FILE credentials (trailing newline trimmed) and the secret never appears in stdout, stderr, audit log or any result", async () => {
      writeCreds();
      const audit = join(dir, "file-audit.log");
      const before = mock.authAttempts();
      const r = await runRaw(
        { PORT_API_BASE_URL: mock.url, PORT_CLIENT_ID_FILE: idFile(), PORT_CLIENT_SECRET_FILE: secretFile(), PORT_MCP_AUDIT_LOG: audit },
        [
          { name: "read_record", arguments: { blueprint: "execution_plan", id: "plan-older" } },
          { name: "list_records", arguments: { blueprint: "decision" } }
        ]
      );
      // POSITIVE CONTROL: the file value really was used (the mock accepted exactly it)
      expect(mock.authAttempts()).toBeGreaterThan(before);
      expect(mock.authMatched()).toBe(true);
      expect(toolText(r.responses.find((x) => x.id === 10)).identifier).toBe("plan-older");
      expect(r.stderr).toContain("client_id=file");
      expect(r.stderr).toContain("client_secret=file");

      const everything: Record<string, string> = {
        stdout: r.stdout, stderr: r.stderr, results: JSON.stringify(r.responses), audit: readFileSync(audit, "utf8")
      };
      // CONTROL: the leak detector fires on a known leak
      const leaky = "x " + MOCK_CLIENT_SECRET + " y";
      expect(leaky.includes(MOCK_CLIENT_SECRET)).toBe(true);
      for (const [where, text] of Object.entries(everything)) {
        expect(text.length, where).toBeGreaterThan(0);
        expect(text.includes(MOCK_CLIENT_SECRET), `secret leaked in ${where}`).toBe(false);
        expect(text.includes(MOCK_CLIENT_ID), `id leaked in ${where}`).toBe(false);
      }
    }, 60000);

    it("fails closed if a *_FILE is missing, even when valid env credentials are also set (no fallback)", async () => {
      writeCreds();
      const r = await runRaw(
        { PORT_API_BASE_URL: mock.url, PORT_CLIENT_ID: MOCK_CLIENT_ID, PORT_CLIENT_SECRET: MOCK_CLIENT_SECRET, PORT_CLIENT_SECRET_FILE: join(dir, "does-not-exist"), PORT_CLIENT_ID_FILE: idFile(), PORT_MCP_AUDIT_LOG: join(dir, "miss-audit.log") },
        [{ name: "read_record", arguments: { blueprint: "execution_plan", id: "plan-older" } }]
      );
      expect(toolText(r.responses.find((x) => x.id === 10))).toEqual({ status: "unavailable", reason: "credentials_not_configured" });
      expect(r.stderr).toContain("client_secret=file_unreadable_or_empty");
      expect(r.stderr).not.toContain(MOCK_CLIENT_SECRET);
    }, 60000);

    it("fails closed for an empty file", async () => {
      const empty = join(dir, "empty_secret");
      writeFileSync(empty, "\n");
      const c = resolveCredentials({ PORT_CLIENT_ID: "a", PORT_CLIENT_SECRET_FILE: empty });
      expect(c.sources.clientSecret).toBe("file_unreadable_or_empty");
      expect(c.clientSecret).toBeUndefined();
    });

    it("env credentials apply only when *_FILE is unset (precedence) and values are trimmed", () => {
      writeCreds();
      const envOnly = resolveCredentials({ PORT_CLIENT_ID: "env-id", PORT_CLIENT_SECRET: "env-secret" });
      expect(envOnly.sources).toEqual({ clientId: "env", clientSecret: "env" });
      const both = resolveCredentials({ PORT_CLIENT_ID: "env-id", PORT_CLIENT_ID_FILE: idFile(), PORT_CLIENT_SECRET_FILE: secretFile() });
      expect(both.clientId).toBe(MOCK_CLIENT_ID); // file wins when set
      expect(both.clientSecret).toBe(MOCK_CLIENT_SECRET); // trailing CRLF trimmed
      expect(resolveCredentials({}).sources).toEqual({ clientId: "missing", clientSecret: "missing" });
      expect(resolveCredentials({ PORT_CLIENT_ID_FILE: "relative/path" }).sources.clientId).toBe("file_unreadable_or_empty");
    });

    it.skipIf(process.platform === "win32")("warns (path only) when a credential file is group/world readable", () => {
      writeCreds();
      chmodSync(secretFile(), 0o644);
      const c = resolveCredentials({ PORT_CLIENT_ID_FILE: idFile(), PORT_CLIENT_SECRET_FILE: secretFile() });
      expect(c.warnings.length).toBe(1);
      expect(c.warnings[0]).toContain(secretFile());
      expect(c.warnings[0]).not.toContain(MOCK_CLIENT_SECRET);
      // control: a 0600 file produces no warning
      chmodSync(secretFile(), 0o600);
      expect(resolveCredentials({ PORT_CLIENT_ID_FILE: idFile(), PORT_CLIENT_SECRET_FILE: secretFile() }).warnings).toEqual([]);
    });
  });
});
