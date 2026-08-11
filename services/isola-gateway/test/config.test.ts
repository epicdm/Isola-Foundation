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

  it("warns loudly when the durable delivery ledger is not configured", () => {
    // Replaces the old "responseMode inline is not implemented" warning: the
    // runtime shipped contract v1, and the open dependency is now the ledger.
    const config = loadConfig({ GATEWAY_BINDINGS_JSON: bindingsJson([makeBinding()]) });
    const warnings = bootWarnings(config).join(" ");
    expect(warnings).toMatch(/GATEWAY_LEDGER_URL is unset/);
    expect(warnings).toMatch(/refuse to start/);
  });

  it("warns when the ledger lease is not longer than the runtime timeout", () => {
    // A lease shorter than a legitimate run lets the sweeper steal a healthy
    // delivery and process it twice.
    const config = loadConfig({
      GATEWAY_BINDINGS_JSON: bindingsJson([makeBinding()]),
      GATEWAY_LEDGER_URL: "postgres://ledger.invalid/db",
      GATEWAY_LEDGER_LEASE_MS: "1000",
      GATEWAY_RUNTIME_TIMEOUT_MS: "90000",
    });
    expect(bootWarnings(config).join(" ")).toMatch(
      /GATEWAY_LEDGER_LEASE_MS is not longer than the runtime timeout/,
    );
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
