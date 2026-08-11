import { describe, expect, it } from "vitest";

import {
  allTemplates,
  findTemplate,
  healthTemplateSummary,
  templateMetadata,
} from "../src/registry.js";
import { renderContext } from "../src/context.js";
import { bootWarnings, loadConfig } from "../src/config.js";

describe("registry shape", () => {
  it("holds exactly the two ratified templates at the exact ids", () => {
    expect(allTemplates().map((t) => t.id)).toEqual([
      "epic-staff-operations-coordinator@v1",
      "isola-ai-sales-front-desk-agent@v1",
    ]);
    expect(healthTemplateSummary()).toEqual([
      {
        id: "epic-staff-operations-coordinator@v1",
        version: "v1",
        exposure: "INTERNAL",
      },
      { id: "isola-ai-sales-front-desk-agent@v1", version: "v1", exposure: "PUBLIC" },
    ]);
  });

  it("toolPolicy is all-false for every template", () => {
    for (const template of allTemplates()) {
      expect(template.toolPolicy).toEqual({
        shell: false,
        filesystem: false,
        web: false,
        mcp: false,
        customTools: false,
      });
      for (const [capability, allowed] of Object.entries(template.toolPolicy)) {
        expect(`${template.id}.${capability}=${String(allowed)}`).toBe(
          `${template.id}.${capability}=false`,
        );
      }
    }
  });

  it("every template has a non-trivial system prompt and a byte cap", () => {
    for (const template of allTemplates()) {
      expect(template.systemPrompt.length).toBeGreaterThan(500);
      expect(template.maxContextBytes).toBe(24 * 1024);
      expect(template.timeoutMs).toBe(60_000);
      expect(template.model).toBe("deepseek-chat");
    }
  });

  it("metadata projection never carries the prompt", () => {
    for (const template of allTemplates()) {
      const meta = templateMetadata(template) as unknown as Record<string, unknown>;
      expect(meta["systemPrompt"]).toBeUndefined();
      expect(JSON.stringify(meta)).not.toContain("You are");
    }
  });

  it("lookup is exact, trims whitespace, and never guesses", () => {
    expect(findTemplate("epic-staff-operations-coordinator@v1")?.exposure).toBe("INTERNAL");
    expect(findTemplate("  isola-ai-sales-front-desk-agent@v1  ")?.exposure).toBe("PUBLIC");
    expect(findTemplate("Epic-Staff-Operations-Coordinator@v1")).toBeNull();
    expect(findTemplate("epic-staff-operations-coordinator")).toBeNull();
    expect(findTemplate("")).toBeNull();
    expect(findTemplate(null)).toBeNull();
    expect(findTemplate({ id: "epic-staff-operations-coordinator@v1" })).toBeNull();
  });
});

describe("system prompt content commitments", () => {
  const ops = findTemplate("epic-staff-operations-coordinator@v1")!;
  const frontDesk = findTemplate("isola-ai-sales-front-desk-agent@v1")!;

  it("the operations coordinator names all seven columns and the no-action statement", () => {
    for (const column of [
      "Account / Customer Reference",
      "Balance",
      "Days Overdue",
      "Priority",
      "Recommended Next Action",
      "Escalation Reason",
      "Requires Human Approval",
    ]) {
      expect(ops.systemPrompt).toContain(column);
    }
    expect(ops.systemPrompt).toContain(
      "I have contacted no one and changed no record",
    );
    expect(ops.systemPrompt).toContain("Overdue Receivables Action List");
    expect(ops.systemPrompt).toMatch(/missing or unparseable/i);
    expect(ops.systemPrompt).toMatch(/do NOT produce a table and do NOT invent rows/);
  });

  it("the front desk agent is grounded, escalating and silent under takeover", () => {
    expect(frontDesk.systemPrompt).toMatch(/ONLY from the business information/i);
    expect(frontDesk.systemPrompt).toMatch(/escalat/i);
    expect(frontDesk.systemPrompt).toMatch(/takeover/i);
    expect(frontDesk.systemPrompt).toMatch(/handback/i);
    expect(frontDesk.systemPrompt).toMatch(/full name/i);
    expect(frontDesk.systemPrompt).toMatch(/Never say or imply that you have/i);
    expect(frontDesk.systemPrompt).toMatch(/I don't have that detail here/);
  });
});

describe("renderContext", () => {
  it("passes small contexts through untouched", () => {
    const r = renderContext({ a: 1 }, 1024);
    expect(r.truncated).toBe(false);
    expect(JSON.parse(r.text)).toEqual({ a: 1 });
  });

  it("caps by BYTES, not characters, and never splits a multi-byte character", () => {
    // Each "€" is 3 UTF-8 bytes.
    const r = renderContext("€".repeat(100), 10);
    expect(r.truncated).toBe(true);
    expect(r.originalBytes).toBe(300);
    expect(r.emittedBytes).toBe(9); // 3 whole characters, not 10 bytes
    expect(r.text.startsWith("€€€[")).toBe(false);
    expect(r.text).toContain("€€€");
    expect(() => Buffer.from(r.text, "utf8").toString("utf8")).not.toThrow();
    expect(r.text).not.toContain("�"); // no replacement character
  });

  it("announces how much was dropped", () => {
    const r = renderContext("A".repeat(100), 10);
    expect(r.text).toContain("90 byte(s) were omitted");
    expect(r.text).toContain("Do not infer or invent the omitted content");
  });

  it("survives a circular context without throwing", () => {
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;
    const r = renderContext(circular, 1024);
    expect(r.text).toBe("[unserialisable run context]");
  });
});

describe("config defaults and boot warnings", () => {
  it("applies the documented defaults", () => {
    const config = loadConfig({});
    expect(config.port).toBe(3000);
    expect(config.modelBaseUrl).toBe("https://api.deepseek.com");
    expect(config.modelNameOverride).toBeNull();
    expect(config.modelTimeoutMs).toBe(60_000);
    expect(config.paperclipRecordPath).toBe("/api/issues/{issueId}/comments");
    expect(config.secrets.INTERNAL).toBeNull();
    expect(config.secrets.PUBLIC).toBeNull();
  });

  it("warns — without printing a value — about every fail-closed condition", () => {
    const warnings = bootWarnings(loadConfig({}));
    expect(warnings.join("\n")).toContain("RUNTIME_SECRET_INTERNAL is unset");
    expect(warnings.join("\n")).toContain("RUNTIME_SECRET_PUBLIC is unset");
    expect(warnings.join("\n")).toContain("MODEL_API_KEY is unset");
    expect(warnings.join("\n")).toContain("NullRunRecorder");
  });

  it("warns loudly when the two bearers are identical", () => {
    const warnings = bootWarnings(
      loadConfig({ RUNTIME_SECRET_INTERNAL: "same-value", RUNTIME_SECRET_PUBLIC: "same-value" }),
    );
    expect(warnings.join("\n")).toContain("are identical");
    expect(warnings.join("\n")).not.toContain("same-value");
  });
});
