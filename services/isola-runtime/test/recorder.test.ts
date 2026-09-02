import { describe, expect, it } from "vitest";

import { createSafeFetch } from "../src/egress.js";
import {
  NullRunRecorder,
  PaperclipRunRecorder,
  createRecorder,
  renderOutcomeBody,
  type RunOutcome,
} from "../src/recorder.js";
import { createLogger, redact } from "../src/log.js";

const base: RunOutcome = {
  correlationId: "corr-1",
  agentId: "agent-1",
  runId: "run-1",
  issueId: "issue-1",
  templateId: "epic-staff-operations-coordinator@v1",
  templateVersion: "v1",
  exposure: "INTERNAL",
  status: "succeeded",
  durationMs: 4200,
  content: "| Account | Balance |\n|---|---|\n| ACC-1 | 10 |",
  failureCategory: null,
  contextTruncated: false,
};

describe("createRecorder selection", () => {
  const safeFetch = createSafeFetch({ allowlist: ["x.test"] });

  it("uses NullRunRecorder when PAPERCLIP_API_KEY is unset", () => {
    const recorder = createRecorder({
      baseUrl: "https://x.test",
      apiKey: null,
      pathTemplate: "/p",
      safeFetch,
    });
    expect(recorder).toBeInstanceOf(NullRunRecorder);
    expect(recorder.kind).toBe("null");
  });

  it("uses NullRunRecorder when PAPERCLIP_BASE_URL is unset", () => {
    const recorder = createRecorder({
      baseUrl: null,
      apiKey: "k",
      pathTemplate: "/p",
      safeFetch,
    });
    expect(recorder.kind).toBe("null");
  });

  it("uses PaperclipRunRecorder when both are set", () => {
    const recorder = createRecorder({
      baseUrl: "https://x.test",
      apiKey: "k",
      pathTemplate: "/p",
      safeFetch,
    });
    expect(recorder).toBeInstanceOf(PaperclipRunRecorder);
    expect(recorder.kind).toBe("paperclip");
  });

  it("NullRunRecorder is a no-op that never throws", async () => {
    await expect(new NullRunRecorder().record(base)).resolves.toBeUndefined();
  });
});

describe("renderOutcomeBody", () => {
  it("carries the model output verbatim on success", () => {
    const body = renderOutcomeBody(base);
    expect(body).toContain("| ACC-1 | 10 |");
    expect(body).toContain("corr-1");
    expect(body).toContain("epic-staff-operations-coordinator@v1");
    expect(body).not.toContain("FAILED");
  });

  it("flags a size-capped context on an otherwise successful run", () => {
    const body = renderOutcomeBody({ ...base, contextTruncated: true });
    expect(body).toContain("exceeded the size cap");
    expect(body).toContain("| ACC-1 | 10 |");
  });

  it("states plainly that a timed-out run failed, and invents nothing", () => {
    const body = renderOutcomeBody({
      ...base,
      status: "timed_out",
      content: null,
      failureCategory: "model_timeout_after_60000ms",
    });
    expect(body).toContain("This run FAILED");
    expect(body).toContain("model_timeout_after_60000ms");
    expect(body).toContain("No answer was produced");
    expect(body).toContain("Nothing in this run was inferred, guessed or filled in");
    expect(body).not.toContain("| ACC-1 | 10 |");
  });

  it("states plainly that a provider failure failed, category only", () => {
    const body = renderOutcomeBody({
      ...base,
      status: "provider_error",
      content: null,
      failureCategory: "model provider error: provider returned HTTP 500",
    });
    expect(body).toContain("model provider returned an error");
    expect(body).toContain("provider returned HTTP 500");
    // No provider payload, no key, no prompt.
    expect(body).not.toMatch(/sk-[A-Za-z0-9]/);
    expect(body).not.toContain("You are the EPIC");
  });

  it("covers the internal_error headline too", () => {
    const body = renderOutcomeBody({
      ...base,
      status: "internal_error",
      content: null,
      failureCategory: "internal_error (TypeError)",
    });
    expect(body).toContain("Isola runtime hit an internal error");
  });
});

describe("log redaction", () => {
  it("strips credential-shaped keys and bearer-shaped values", () => {
    // Built at runtime so no scanner has to decide whether these are real.
    const marker = ["must", "never", "appear"].join("-");
    const out = redact({
      apiKey: marker,
      api_key: marker,
      authorization: "Bearer abc",
      MODEL_API_KEY: marker,
      password: marker,
      token: "t",
      nested: { credential: "x", ok: "visible" },
      header: `Bearer ${marker}`,
      plain: "safe text",
    }) as Record<string, unknown>;

    expect(JSON.stringify(out)).not.toContain(marker);
    expect(out["plain"]).toBe("safe text");
    expect((out["nested"] as Record<string, unknown>)["ok"]).toBe("visible");
  });

  it("emits one JSON line per event with the standard field set", () => {
    const lines: string[] = [];
    const logger = createLogger((line) => lines.push(line));
    logger.info({
      event: "invoke",
      correlationId: "c",
      runId: "r",
      agentId: "a",
      templateId: "t",
      outcome: "ok",
      durationMs: 1,
    });
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!) as Record<string, unknown>;
    for (const key of [
      "ts",
      "level",
      "service",
      "version",
      "event",
      "correlationId",
      "runId",
      "agentId",
      "templateId",
      "outcome",
      "durationMs",
    ]) {
      expect(parsed).toHaveProperty(key);
    }
  });

  it("never throws on an unserialisable field", () => {
    const lines: string[] = [];
    const logger = createLogger((line) => lines.push(line));
    const circular: Record<string, unknown> = { event: "x" };
    circular["self"] = circular;
    expect(() => logger.info(circular as never)).not.toThrow();
    expect(lines).toHaveLength(1);
  });
});
