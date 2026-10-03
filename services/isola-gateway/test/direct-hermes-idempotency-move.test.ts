/**
 * STEP A (direct Hermes path), commit 1: the ledger-key helper leaves the Paperclip module.
 *
 * `pipeline.ts` computed the per-turn idempotency key with a function that lived in
 * `paperclip-runtime.ts`, so the PIPELINE (the one module every execution path shares)
 * imported the Paperclip module. The direct Hermes path must not depend on Paperclip code
 * to run a turn, and the Paperclip module must stay unreferenced-but-kept. The helper
 * moves to `idempotency.ts`; its behaviour must be BYTE-IDENTICAL (the ledger key is a
 * contract: Paperclip's replay, Hermes' Idempotency-Key and the delivery ref all derive
 * from it), and the old export must keep working.
 *
 * SOCKET-FREE. Pure functions and a source scan.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import * as idempotency from "../src/idempotency.js";
import { paperclipIdempotencyKey } from "../src/paperclip-runtime.js";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const IDENTITY = {
  tenantId: "t1",
  bindingId: "b1",
  chatwootAccountId: 1,
  chatwootInboxId: 7,
  eventId: "e1",
};

describe("the per-turn idempotency key lives in idempotency.ts", () => {
  it("exports turnIdempotencyKey from idempotency.ts", () => {
    expect(typeof (idempotency as Record<string, unknown>)["turnIdempotencyKey"]).toBe("function");
  });

  it("is BYTE-IDENTICAL to the pre-move value (golden literal, short form)", () => {
    const turnIdempotencyKey = (idempotency as Record<string, unknown>)["turnIdempotencyKey"] as (
      identity: typeof IDENTITY,
      mode: string,
    ) => string;
    expect(turnIdempotencyKey(IDENTITY, "answer")).toBe("isolagw:t1|b1|1|7|e1|answer");
  });

  it("is BYTE-IDENTICAL to the pre-move value (golden literal, over 255 characters -> sha256 form)", () => {
    const turnIdempotencyKey = (idempotency as Record<string, unknown>)["turnIdempotencyKey"] as (
      identity: typeof IDENTITY,
      mode: string,
    ) => string;
    const long = { ...IDENTITY, eventId: "delivery:" + "x".repeat(300) };
    const key = turnIdempotencyKey(long, "answer");
    expect(key).toBe("isolagw:sha256:dc7c6838eb0ed6e55099814c092d1e40473dbf03c26c6ef2a3cf1781d9bf4686");
    expect(key.length).toBeLessThanOrEqual(255);
  });

  it("CONTROL: the old Paperclip export still computes the very same value", () => {
    const turnIdempotencyKey = (idempotency as Record<string, unknown>)["turnIdempotencyKey"] as (
      identity: typeof IDENTITY,
      mode: string,
    ) => string;
    for (const mode of ["answer", "handoff", "other_action"]) {
      expect(paperclipIdempotencyKey(IDENTITY, mode)).toBe(turnIdempotencyKey(IDENTITY, mode));
    }
    // distinctness control: the key is not a constant
    expect(turnIdempotencyKey(IDENTITY, "answer")).not.toBe(turnIdempotencyKey(IDENTITY, "handoff"));
    expect(turnIdempotencyKey(IDENTITY, "answer")).not.toBe(turnIdempotencyKey({ ...IDENTITY, eventId: "e2" }, "answer"));
  });
});

describe("the shared pipeline no longer imports the Paperclip module", () => {
  it("pipeline.ts has no import of paperclip-runtime", () => {
    const source = readFileSync(join(SRC, "pipeline.ts"), "utf8");
    const importLines = source.split(/\r?\n/).filter((line) => /^\s*(import|export)\b[^;]*\bfrom\b/.test(line));
    expect(importLines.some((line) => line.includes("paperclip-runtime"))).toBe(false);
  });

  it("CONTROL: the scan can see an import (pipeline.ts imports idempotency.js once the move is done)", () => {
    const source = readFileSync(join(SRC, "pipeline.ts"), "utf8");
    const importLines = source.split(/\r?\n/).filter((line) => /^\s*(import|export)\b[^;]*\bfrom\b/.test(line));
    // The scan reads real import lines (there are many), so "no paperclip import" is not vacuous...
    expect(importLines.length).toBeGreaterThan(10);
    // ...and the helper now comes from the shared module.
    expect(importLines.some((line) => line.includes("turnIdempotencyKey") && line.includes("./idempotency.js"))).toBe(true);
  });
});
