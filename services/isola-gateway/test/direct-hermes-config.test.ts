/**
 * STEP A (direct Hermes path), commit 4a: configuration, boot refusals and the failure vocabulary.
 *
 * The direct path is OFF by default (no agent id listed = today's behaviour, no Hermes host in the
 * egress allowlist). Once an employee is listed, a misconfiguration REFUSES to boot (a rule that
 * says "refuse" needs a mechanism that can: bootErrors). Names only: no message ever carries a
 * credential value.
 *
 * SOCKET-FREE. Every refusal has its positive twin (Laws 11, 19, 23, 28).
 */
import { describe, expect, it } from "vitest";

import { bootErrors, bootWarnings, loadConfig } from "../src/config.js";
import { HERMES_OUTCOMES } from "../src/hermes-runtime.js";
import { explainFailure } from "../src/pipeline.js";
import { BASE_ENV, envConfig, makeBinding, bindingsJson } from "./harness.js";

const BEARER = ["not", "a", "real", "hermes", "credential", "0".repeat(16)].join("-");
const enabledEnv: Record<string, string> = {
  GATEWAY_LEDGER_URL: "postgres://ledger.test/db",
  GATEWAY_HERMES_AGENT_IDS: "agent-1",
  GATEWAY_HERMES_BASE_URL: "http://isola_hermes-public:8642",
  GATEWAY_HERMES_BEARER: BEARER,
};
const cfg = (extra: Record<string, string> = {}, drop: string[] = []) => {
  const env: Record<string, string | undefined> = { ...BASE_ENV, ...enabledEnv, ...extra };
  for (const key of drop) delete env[key];
  return loadConfig(env);
};

describe("default OFF", () => {
  it("nothing listed: no Hermes agent, no boot error, and the Hermes host is NOT allowed out", () => {
    const config = envConfig();
    expect(config.hermes.agentIds).toEqual([]);
    expect(bootErrors(config)).toEqual([]);
    expect(config.egressAllowlist).not.toContain("isola_hermes-public");
  });

  it("CONTROL: a valid enabled configuration boots, with the documented defaults, and only then is the host allowed out", () => {
    const config = cfg();
    expect(bootErrors(config)).toEqual([]);
    expect(config.hermes).toMatchObject({
      agentIds: ["agent-1"],
      baseUrl: "http://isola_hermes-public:8642",
      runDeadlineMs: 75_000,
      pollIntervalMs: 1_000,
      requestTimeoutMs: 20_000,
      maxInflight: 8,
      rateLimitBackoffMs: 1_000,
      historyMaxTurns: 20,
      historyMaxChars: 8_000,
    });
    expect(config.egressAllowlist).toContain("isola_hermes-public");
    // the measured timings (a first run after idle takes ~10 s, a status GET can wait ~6 s) are accepted
    expect(config.hermes.requestTimeoutMs).toBeGreaterThanOrEqual(15_000);
  });

  it("the Paperclip path is untouched: no Paperclip agent listed, still off", () => {
    expect(cfg().paperclip.agentIds).toEqual([]);
  });
});

describe("an enabled direct path that is misconfigured REFUSES to boot (names only, never a value)", () => {
  it.each([
    ["no base URL", {}, ["GATEWAY_HERMES_BASE_URL"], "GATEWAY_HERMES_BASE_URL"],
    ["no credential", {}, ["GATEWAY_HERMES_BEARER"], "GATEWAY_HERMES_BEARER"],
    ["a base URL with userinfo", { GATEWAY_HERMES_BASE_URL: "http://user:pw@isola_hermes-public:8642" }, [], "GATEWAY_HERMES_BASE_URL"],
    ["a base URL with a query", { GATEWAY_HERMES_BASE_URL: "http://isola_hermes-public:8642?x=1" }, [], "GATEWAY_HERMES_BASE_URL"],
    ["a base URL with a fragment", { GATEWAY_HERMES_BASE_URL: "http://isola_hermes-public:8642#x" }, [], "GATEWAY_HERMES_BASE_URL"],
    ["a non-http scheme", { GATEWAY_HERMES_BASE_URL: "ftp://isola_hermes-public:8642" }, [], "GATEWAY_HERMES_BASE_URL"],
    ["a host that is not on an explicit egress allowlist", { EGRESS_ALLOWLIST: "chatwoot.example.test" }, [], "EGRESS_ALLOWLIST"],
    ["no ledger (the transcript lives in it)", {}, ["GATEWAY_LEDGER_URL"], "GATEWAY_LEDGER_URL"],
    ["a deadline above the 85 s ceiling", { GATEWAY_HERMES_RUN_DEADLINE_MS: "86000", GATEWAY_RUNTIME_TIMEOUT_MS: "120000" }, [], "GATEWAY_HERMES_RUN_DEADLINE_MS"],
    ["a deadline not inside the runtime timeout", { GATEWAY_HERMES_RUN_DEADLINE_MS: "80000", GATEWAY_RUNTIME_TIMEOUT_MS: "70000" }, [], "GATEWAY_HERMES_RUN_DEADLINE_MS"],
    ["a deadline not inside the turn budget", { GATEWAY_HERMES_RUN_DEADLINE_MS: "80000", GATEWAY_TURN_BUDGET_MS: "80000", GATEWAY_RUNTIME_TIMEOUT_MS: "70000" }, [], "GATEWAY_HERMES_RUN_DEADLINE_MS"],
    ["a request timeout not inside the turn budget", { GATEWAY_HERMES_REQUEST_TIMEOUT_MS: "280000", GATEWAY_LEDGER_LEASE_MS: "600000", GATEWAY_TURN_BUDGET_MS: "270000" }, [], "GATEWAY_HERMES_REQUEST_TIMEOUT_MS"],
    ["a deadline plus a request timeout that do not fit inside the ledger lease", { GATEWAY_HERMES_RUN_DEADLINE_MS: "80000", GATEWAY_HERMES_REQUEST_TIMEOUT_MS: "40000", GATEWAY_LEDGER_LEASE_MS: "120000", GATEWAY_TURN_BUDGET_MS: "90000", GATEWAY_RUNTIME_TIMEOUT_MS: "85000" }, [], "GATEWAY_HERMES_RUN_DEADLINE_MS"],
    ["more in-flight runs than Hermes' own cap of 10", { GATEWAY_HERMES_MAX_INFLIGHT: "11" }, [], "GATEWAY_HERMES_MAX_INFLIGHT"],
    ["a history window larger than the transcript store keeps", { GATEWAY_HERMES_HISTORY_MAX_TURNS: "21" }, [], "GATEWAY_HERMES_HISTORY_MAX_TURNS"],
    ["a history character cap larger than the transcript store keeps", { GATEWAY_HERMES_HISTORY_MAX_CHARS: "9000" }, [], "GATEWAY_HERMES_HISTORY_MAX_CHARS"],
    ["a poll interval shorter than 100 ms", { GATEWAY_HERMES_POLL_INTERVAL_MS: "50" }, [], "GATEWAY_HERMES_POLL_INTERVAL_MS"],
  ] as Array<[string, Record<string, string>, string[], string]>)("%s", (_name, extra, drop, mention) => {
    const errors = bootErrors(cfg(extra, drop));
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors.join(" ")).toContain(mention);
    expect(errors.join(" ")).not.toContain(BEARER);
  });

  it.each([
    ["the privileged operator gateway port 8645", "http://hermes.example.test:8645"],
    ["the hermes-tunnel host", "http://hermes-tunnel:8642"],
    ["the isolahb_bridge host", "http://isolahb_bridge:8642"],
    ["the isola-hermes-bridge host", "http://isola-hermes-bridge:8642"],
  ])("NOTHING customer-facing may route through %s (the owner-privileged toolset)", (_name, baseUrl) => {
    const errors = bootErrors(cfg({ GATEWAY_HERMES_BASE_URL: baseUrl }));
    expect(errors.join(" ")).toContain("owner-privileged");
  });

  it("ONE EXECUTION OWNER: the same employee cannot be enabled for BOTH Hermes and Paperclip", () => {
    const errors = bootErrors(
      cfg({
        GATEWAY_PAPERCLIP_AGENT_IDS: "agent-1",
        GATEWAY_PAPERCLIP_BASE_URL: "https://paperclip.example.test",
        GATEWAY_PAPERCLIP_COMPANY_ID: "company-1",
        GATEWAY_PAPERCLIP_BEARER: "another-not-a-real-credential",
      }),
    );
    expect(errors.join(" ")).toContain("both");
    // CONTROL: two DIFFERENT employees, one each, boot fine
    const ok = bootErrors(
      loadConfig({
        ...BASE_ENV,
        ...enabledEnv,
        GATEWAY_BINDINGS_JSON: bindingsJson([makeBinding(), makeBinding({ chatwootInboxId: 8, chatwootAgentBotId: 4, paperclipAgentId: "agent-2" })]),
        GATEWAY_PAPERCLIP_AGENT_IDS: "agent-2",
        GATEWAY_PAPERCLIP_BASE_URL: "https://paperclip.example.test",
        GATEWAY_PAPERCLIP_COMPANY_ID: "company-1",
        GATEWAY_PAPERCLIP_BEARER: "another-not-a-real-credential",
      }),
    );
    expect(ok).toEqual([]);
  });

  it("a PUBLIC employee only: an enabled binding whose exposure is INTERNAL is refused", () => {
    const env = { ...enabledEnv, GATEWAY_BINDINGS_JSON: bindingsJson([makeBinding({ exposure: "INTERNAL" })]) };
    const errors = bootErrors(loadConfig({ ...BASE_ENV, ...env }));
    expect(errors.join(" ")).toContain("PUBLIC");
  });

  it("the credential is read from the environment by NAME and no boot message echoes it", () => {
    const errors = bootErrors(cfg({ GATEWAY_HERMES_BASE_URL: "ftp://x" }));
    expect(errors.join(" ")).not.toContain(BEARER);
  });
});

describe("a request timeout below the measured start-up wait is a WARNING, not a refusal", () => {
  it("under 15 s: warned (the API server answers nothing for ~6 s while a run starts); at 20 s: no warning", () => {
    const warned = bootWarnings(cfg({ GATEWAY_HERMES_REQUEST_TIMEOUT_MS: "5000" }));
    expect(warned.join(" ")).toContain("GATEWAY_HERMES_REQUEST_TIMEOUT_MS");
    expect(bootErrors(cfg({ GATEWAY_HERMES_REQUEST_TIMEOUT_MS: "5000" }))).toEqual([]);
    expect(bootWarnings(cfg()).join(" ")).not.toContain("GATEWAY_HERMES_REQUEST_TIMEOUT_MS");
  });
});

describe("every outcome the direct runtime can return is explained to the colleague who picks the conversation up", () => {
  const unknown = explainFailure("zz_unknown_outcome");
  it.each(Object.entries(HERMES_OUTCOMES))("%s -> %s has its own explanation (not the generic fallback)", (_name, outcome) => {
    expect(explainFailure(outcome)).not.toBe(unknown);
  });
});
