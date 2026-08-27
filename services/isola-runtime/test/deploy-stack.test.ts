/**
 * THE PRODUCTION STACK FILE MUST NOT BE ABLE TO STOP PRODUCTION STARTING.
 *
 * `deploy/isola-rt-stack.yml` is the checked-in production stack. It defines
 * none of AGENTOS_BASE_URL / AGENTOS_SHARED_SECRET / AGENTOS_TENANT_ID. While
 * those were unconditionally boot-fatal, deploying this image with that file
 * would have BOOT-REFUSED and taken the live runtime out of service.
 *
 * This is a source scan rather than a behavioural test on purpose: it holds
 * for the file as committed, including any future edit to it, which is exactly
 * where the hazard lives.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { bootErrors, loadConfig } from "../src/config.js";

const STACK_PATH = fileURLToPath(new URL("../deploy/isola-rt-stack.yml", import.meta.url));
const STACK = readFileSync(STACK_PATH, "utf8");

/** Parse only the `KEY: value` pairs, so no secret VALUE is ever asserted on. */
function envValue(key: string): string | null {
  const match = STACK.match(new RegExp(`^\\s*${key}:\\s*"?([^"\\n#]*)"?\\s*$`, "m"));
  return match ? (match[1] ?? "").trim() : null;
}

describe("deploy/isola-rt-stack.yml keeps AgentOS disabled", () => {
  it("finds the stack file (control: the scan is reading something)", () => {
    expect(STACK.length).toBeGreaterThan(200);
    expect(STACK).toContain("RUNTIME_STATE_DIR");
  });

  it("declares AGENTOS_ENABLED explicitly, and declares it OFF", () => {
    // Explicit, not merely absent: absence would rely on the code default,
    // and the whole point is that the file states the decision.
    const value = envValue("AGENTOS_ENABLED");
    expect(value).not.toBeNull();
    expect(String(value).toLowerCase()).toBe("false");
  });

  it("records that a production AgentOS rollout is not authorized", () => {
    expect(STACK).toMatch(/NOT AUTHORIZED/i);
  });

  it("a config built from this file's AgentOS settings boots without error", () => {
    // The end-to-end property that matters: the stack file's AgentOS posture
    // must not produce a boot refusal. Only the AgentOS settings are taken
    // from the file; the rest are the minimum a boot needs.
    const config = loadConfig({
      RUNTIME_SECRET_INTERNAL: "not-a-real-credential-internal-0000",
      RUNTIME_BUDGET_FALLBACK_CENTS: "5000",
      AGENTOS_ENABLED: envValue("AGENTOS_ENABLED") ?? undefined,
      AGENTOS_BASE_URL: envValue("AGENTOS_BASE_URL") ?? undefined,
      AGENTOS_SHARED_SECRET: envValue("AGENTOS_SHARED_SECRET") ?? undefined,
      AGENTOS_TENANT_ID: envValue("AGENTOS_TENANT_ID") ?? undefined,
    });
    expect(config.agentOsEnabled).toBe(false);
    expect(bootErrors(config)).toEqual([]);
  });

  it("SABOTAGE CONTROL: flipping it on without the three settings DOES refuse", () => {
    // Proves the test above is not passing vacuously — the boot gate really
    // does fire when the switch is on and the settings are absent.
    const config = loadConfig({
      RUNTIME_SECRET_INTERNAL: "not-a-real-credential-internal-0000",
      RUNTIME_BUDGET_FALLBACK_CENTS: "5000",
      AGENTOS_ENABLED: "true",
    });
    expect(bootErrors(config).length).toBeGreaterThan(0);
  });
});
