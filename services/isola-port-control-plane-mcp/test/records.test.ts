import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PortClient } from "../src/portClient.js";
import { JsonlAuditLogger } from "../src/audit.js";
import type { ToolContext } from "../src/tools.js";
import * as tools from "../src/tools.js";
import { readRecord, listRecords } from "../src/records.js";
import { startMockPort, MOCK_CLIENT_ID, MOCK_CLIENT_SECRET, type MockPort } from "./helpers/mockPort.js";
import { seedEntities, longPlan, seededDescription, FAKE, SURVIVORS } from "./helpers/fixtures.js";

let mock: MockPort;
let dir: string;
let auditPath: string;
let ctx: ToolContext;

beforeAll(async () => {
  mock = await startMockPort(seedEntities());
  dir = mkdtempSync(join(tmpdir(), "portmcp-"));
  auditPath = join(dir, "audit.log");
  ctx = {
    client: new PortClient({ baseUrl: mock.url, clientId: MOCK_CLIENT_ID, clientSecret: MOCK_CLIENT_SECRET, envFallback: false }),
    audit: new JsonlAuditLogger(auditPath),
    callerRef: "test"
  };
});
afterAll(async () => {
  await mock.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("read_record", () => {
  it("returns the plan text paged; reassembled pages equal the original", async () => {
    const original = longPlan();
    let offset = 0;
    let assembled = "";
    let pages = 0;
    let first: any;
    for (;;) {
      const r: any = await readRecord(ctx, "execution_plan", "plan-internal-agent", offset, 7000);
      first ??= r;
      const t = r.texts.plan;
      expect(t.offset).toBe(offset);
      expect(t.total_chars).toBe(original.length);
      assembled += t.text;
      pages++;
      if (t.next_offset === null) { expect(t.truncated).toBe(false); break; }
      expect(t.truncated).toBe(true);
      expect(t.next_offset).toBe(offset + t.text.length);
      offset = t.next_offset;
    }
    expect(pages).toBeGreaterThan(3);
    expect(assembled).toBe(original);
    expect(first.identifier).toBe("plan-internal-agent");
    expect(first.title).toBe("Internal agent plan");
    expect(first.blueprint).toBe("execution_plan");
    expect(first.updatedAt).toBe("2026-10-07T12:34:56.000Z");
    expect(first.properties.version).toBe("v0.21.5");
    expect(first.texts.current_state.text).toBe("Building the adapter.");
  });

  it("keeps conversation keys stripped and secret-looking keys redacted", async () => {
    const r: any = await readRecord(ctx, "execution_plan", "plan-internal-agent");
    expect(r.properties.body).toBe("[STRIPPED]");
    expect(r.properties.text).toBe("[STRIPPED]");
    expect(r.properties.transcript).toBe("[STRIPPED]");
    expect(r.properties.api_token).toBe("[REDACTED]");
    expect(JSON.stringify(r)).not.toContain("should-never-appear");
    expect(r.texts.body).toBeUndefined();
  });

  it("clamps max_chars to the 20000 hard cap", async () => {
    const r: any = await readRecord(ctx, "execution_plan", "plan-internal-agent", 0, 999999);
    expect(r.texts.plan.text.length).toBeLessThanOrEqual(20000);
    expect(r.texts.plan.next_offset).not.toBeNull();
  });

  it("scrubs before paging so a secret cannot straddle a page boundary", async () => {
    // page size 1 char at a time through the PEM would leak if scrubbing happened after paging
    const full: any = await readRecord(ctx, "execution_packet", "pkt-scrub", 0, 20000);
    const t = full.texts.description;
    expect(t.text).toContain("[REDACTED:pem_private_key]");
    expect(t.text).not.toContain("MIIBOgIBAAJB");
    for (const v of Object.values(SURVIVORS)) expect(t.text).toContain(v);
    expect(t.text).not.toContain(FAKE.sk);
    expect(full.properties.last_reviewed).toBe("2026-10-07");
  });

  it("refuses non-allowlisted blueprints (even though the mock would serve them) and serves new ones", async () => {
    mock.requests.length = 0;
    for (const bp of ["customer", "contract"]) {
      const r: any = await readRecord(ctx, bp, bp === "customer" ? "cust-1" : "k-1");
      expect(r.error).toContain("not in the allowlist");
    }
    expect(mock.requests.some((q) => q.path.includes("/customer/") || q.path.includes("/contract/"))).toBe(false);
    // positive control: the mock really does serve them if asked directly
    const direct = await fetch(`${mock.url}/v1/blueprints/customer/entities/cust-1`, { headers: { authorization: "Bearer mock-access-token-not-a-secret" } });
    expect(direct.status).toBe(200);
    for (const [bp, id] of [["execution_plan", "plan-older"], ["execution_packet", "pkt-scrub"], ["isola_launch_gate", "gate-a"], ["isola_component", "comp-a"], ["agent_contract", "contract-a"]]) {
      const r: any = await readRecord(ctx, bp, id);
      expect(r.identifier).toBe(id);
      expect(r.error).toBeUndefined();
    }
    const c: any = await readRecord(ctx, "agent_contract", "contract-a");
    expect(c.texts.contract.text).toBe("Agent may read.");
  });

  it("returns port_unavailable_or_stale (no throw) on an unknown id / outage", async () => {
    const r: any = await readRecord(ctx, "execution_plan", "nope");
    expect(r.status).toBe("port_unavailable_or_stale");
  });
});

describe("list_records", () => {
  it("lists with scalar props only, sorted updated_desc by default", async () => {
    const r: any = await listRecords(ctx, "execution_plan");
    expect(r.items.map((i: any) => i.identifier)).toEqual(["plan-internal-agent", "plan-older"]);
    expect(r.items[0].properties).toEqual({ status: "Active", version: "v0.21.5" });
    expect(JSON.stringify(r)).not.toContain("Step 1:");
    expect(r.total_matched).toBe(2);
    expect(r.next_offset).toBeNull();
  });

  it("filters by status and title, sorts, pages, and caps limit at 50", async () => {
    const a: any = await listRecords(ctx, "execution_plan", { status: "done" });
    expect(a.items.map((i: any) => i.identifier)).toEqual(["plan-older"]);
    const b: any = await listRecords(ctx, "execution_plan", { title_contains: "internal" });
    expect(b.items.map((i: any) => i.identifier)).toEqual(["plan-internal-agent"]);
    const c: any = await listRecords(ctx, "execution_plan", { sort: "updated_asc", limit: 1 });
    expect(c.items[0].identifier).toBe("plan-older");
    expect(c.next_offset).toBe(1);
    const d: any = await listRecords(ctx, "execution_plan", { sort: "updated_asc", limit: 1, offset: 1 });
    expect(d.items[0].identifier).toBe("plan-internal-agent");
    const e: any = await listRecords(ctx, "execution_plan", { limit: 9999 });
    expect(e.limit).toBe(50);
  });

  it("refuses non-allowlisted blueprints and works for each new one", async () => {
    expect(((await listRecords(ctx, "customer")) as any).error).toContain("not in the allowlist");
    for (const bp of ["execution_plan", "execution_packet", "isola_launch_gate", "isola_component", "agent_contract"]) {
      const r: any = await listRecords(ctx, bp);
      expect(r.items.length).toBeGreaterThan(0);
    }
    const g: any = await listRecords(ctx, "isola_launch_gate");
    expect(g.items[0].properties.launch_criticality).toBe("P0");
  });
});

describe("search_port covers new blueprints and drops non-allowlisted", () => {
  it("finds execution_plan and agent_contract but never customer/contract", async () => {
    const r: any = await tools.searchPort(ctx, "a", { limit: 100 });
    const bps = new Set(r.rows.map((x: any) => x.blueprint));
    expect(bps.has("execution_plan")).toBe(true);
    expect(bps.has("agent_contract")).toBe(true);
    expect(bps.has("customer")).toBe(false);
    expect(bps.has("contract")).toBe(false);
    const plan = r.rows.find((x: any) => x.identifier === "plan-internal-agent");
    expect(plan.properties.plan.length).toBeLessThan(700);
    expect(plan.properties.plan).toContain("use read_record");
  });
});

describe("read-only on the wire", () => {
  it("CONTROL: the recorder sees a non-GET request when one is made", async () => {
    mock.requests.length = 0;
    await fetch(`${mock.url}/v1/blueprints/decision/entities/dec-1`, { method: "PUT", body: "{}" });
    expect(mock.requests).toEqual([{ method: "PUT", path: "/v1/blueprints/decision/entities/dec-1" }]);
  });

  it("every tool only issues GET, POST access_token or POST entities/search", async () => {
    const fresh = new PortClient({ baseUrl: mock.url, clientId: MOCK_CLIENT_ID, clientSecret: MOCK_CLIENT_SECRET, envFallback: false });
    const c: ToolContext = { client: fresh, audit: new JsonlAuditLogger(auditPath), callerRef: "t" };
    mock.requests.length = 0;
    await tools.getReleaseBoard(c);
    await tools.listOpenGates(c);
    await tools.getGateEvidence(c, "gate-2-device-b-external-p8");
    await tools.listOpenBlockers(c);
    await tools.listDecisions(c);
    await tools.listReleaseTasks(c);
    await tools.listPilotReadiness(c);
    await tools.listRecentPortActivity(c);
    await tools.getEntity(c, "dec-1", "decision");
    await tools.searchPort(c, "plan");
    await readRecord(c, "execution_plan", "plan-internal-agent");
    await listRecords(c, "decision");

    expect(mock.requests.length).toBeGreaterThan(0);
    const patterns = new Set<string>();
    for (const q of mock.requests) {
      const ok =
        q.method === "GET" ||
        (q.method === "POST" && (q.path === "/v1/auth/access_token" || q.path === "/v1/entities/search"));
      expect(ok, `${q.method} ${q.path}`).toBe(true);
      patterns.add(q.method + " " + q.path.replace(/\/blueprints\/[^/]+\/entities\/[^/]+$/, "/blueprints/:bp/entities/:id").replace(/\/blueprints\/[^/]+\/entities$/, "/blueprints/:bp/entities"));
    }
    expect(patterns.has("POST /v1/auth/access_token")).toBe(true);
    expect(patterns.has("POST /v1/entities/search")).toBe(true);
    expect([...patterns].some((p) => p.startsWith("GET "))).toBe(true);
    expect(mock.requests.some((q) => ["PUT", "PATCH", "DELETE"].includes(q.method))).toBe(false);
  });
});

describe("audit log", () => {
  it("has entries with params hash and no param values or secrets", async () => {
    expect(existsSync(auditPath)).toBe(true);
    const raw = readFileSync(auditPath, "utf8");
    const lines = raw.trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.length).toBeGreaterThan(5);
    for (const l of lines) {
      expect(l.paramsHash).toMatch(/^[0-9a-f]{64}$/);
      expect(Object.keys(l).sort()).toEqual(["callerRef", "ok", "paramsHash", "resultCount", "timestamp", "tool"]);
    }
    expect(lines.some((l) => l.tool === "read_record")).toBe(true);
    expect(lines.some((l) => l.tool === "list_records")).toBe(true);
    // param values used above must not appear
    for (const v of ["plan-internal-agent", "pkt-scrub", "cust-1", "title_contains", "internal", MOCK_CLIENT_SECRET, MOCK_CLIENT_ID, "mock-access-token"]) {
      expect(raw).not.toContain(v);
    }
    // CONTROL: the hash really depends on the values (so "no values" isn't vacuous)
    const { hashParams } = await import("../src/audit.js");
    expect(raw).toContain(hashParams({ blueprint: "execution_plan", id: "plan-internal-agent", offset: 0, maxChars: 7000 }));
  });
});
