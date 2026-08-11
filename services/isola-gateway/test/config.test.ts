import { describe, expect, it } from "vitest";

import {
  approvedLabels,
  bootWarnings,
  configuredBindings,
  DEFAULT_CHATWOOT_BASE_URL,
  DEFAULT_RUNTIME_BASE_URL,
  loadConfig,
} from "../src/config.js";
import { bindingsJson, makeBinding } from "./harness.js";

describe("loadConfig defaults", () => {
  it("uses the verified Chatwoot host and the private runtime host", () => {
    const config = loadConfig({});
    expect(config.chatwootBaseUrl).toBe(DEFAULT_CHATWOOT_BASE_URL);
    expect(config.runtimeBaseUrl).toBe(DEFAULT_RUNTIME_BASE_URL);
    expect(config.runtimeInvokePath).toBe("/v1/invoke");
    expect(config.port).toBe(3000);
    expect(config.replayWindowSec).toBe(300);
    expect(config.maxRequestBytes).toBe(1024 * 1024);
    expect(config.applyLabels).toBe(true);
    expect(config.answeredLabel).toBe("isola-ai-answered");
    expect(config.escalatedLabel).toBe("isola-ai-escalated");
  });

  it("strips a trailing slash off both base urls", () => {
    const config = loadConfig({
      CHATWOOT_BASE_URL: "https://chat.example.test/",
      RUNTIME_BASE_URL: "http://runtime:3000//",
    });
    expect(config.chatwootBaseUrl).toBe("https://chat.example.test");
    expect(config.runtimeBaseUrl).toBe("http://runtime:3000");
  });

  it("treats an explicitly empty label as 'do not label'", () => {
    const config = loadConfig({ GATEWAY_LABEL_ANSWERED: "" });
    expect(config.answeredLabel).toBeNull();
    expect(config.escalatedLabel).toBe("isola-ai-escalated");
  });

  it("ignores a nonsense numeric value rather than taking zero", () => {
    const config = loadConfig({ PORT: "not-a-port", GATEWAY_REPLAY_WINDOW_SEC: "-5" });
    expect(config.port).toBe(3000);
    expect(config.replayWindowSec).toBe(300);
  });
});

describe("binding validation is a boot gate", () => {
  it("reports the errors as data rather than throwing", () => {
    const config = loadConfig({
      GATEWAY_BINDINGS_JSON: JSON.stringify([{ ...makeBinding(), exposure: "INTERNAL" }]),
    });
    expect(config.bindings.ok).toBe(false);
    expect(configuredBindings(config)).toEqual([]);
    expect(bootWarnings(config).join(" ")).toMatch(/refuse to start/);
  });

  it("boots with zero bindings and says so", () => {
    const config = loadConfig({});
    expect(config.bindings.ok).toBe(true);
    expect(bootWarnings(config).join(" ")).toMatch(/no inbox is bound/);
  });

  it("always warns about the open responseMode dependency", () => {
    const config = loadConfig({ GATEWAY_BINDINGS_JSON: bindingsJson([makeBinding()]) });
    expect(bootWarnings(config).join(" ")).toMatch(/inline/);
    expect(bootWarnings(config).join(" ")).toMatch(/runtime_no_text/);
  });

  it("warns when every binding is retired", () => {
    const config = loadConfig({
      GATEWAY_BINDINGS_JSON: bindingsJson([makeBinding({ status: "retired" })]),
    });
    expect(bootWarnings(config).join(" ")).toMatch(/Every configured binding is retired/);
  });

  it("warns when the runtime bearer or the admin token is missing", () => {
    const warnings = bootWarnings(loadConfig({})).join(" ");
    expect(warnings).toMatch(/RUNTIME_SECRET_PUBLIC is unset/);
    expect(warnings).toMatch(/GATEWAY_ADMIN_TOKEN is unset/);
  });
});

describe("approvedLabels", () => {
  it("is the two configured labels plus any per-binding extras", () => {
    const config = loadConfig({});
    expect(approvedLabels(config)).toEqual(["isola-ai-answered", "isola-ai-escalated"]);
    expect(approvedLabels(config, makeBinding({ labels: ["vip-lane"] }))).toContain("vip-lane");
  });
});
