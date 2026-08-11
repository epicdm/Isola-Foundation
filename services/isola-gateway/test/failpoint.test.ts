/**
 * The failpoint must be impossible to arm by accident, and inert when it is
 * not armed. It exists to make ONE crash window deterministic; it must not
 * change anything else, and it must not be able to reach production silently.
 */
import { describe, expect, it, vi } from "vitest";

import { bootWarnings, loadConfig } from "../src/config.js";
import {
  createFailpoint,
  DISARMED,
  FAILPOINTS,
  isFailpointName,
} from "../src/failpoint.js";
import { CapturingLogger, bindingsJson, makeBinding } from "./harness.js";

const PROD_ENV = {
  CHATWOOT_BASE_URL: "https://chatwoot.example.test",
  RUNTIME_BASE_URL: "http://isola_isola-runtime:3000",
  GATEWAY_BINDINGS_JSON: bindingsJson([makeBinding()]),
  GATEWAY_LEDGER_URL: "postgres://ledger.invalid/db",
};

describe("a production-shaped environment leaves the failpoint disarmed", () => {
  it("is null when GATEWAY_FAILPOINT is absent", () => {
    expect(loadConfig(PROD_ENV).failpoint).toBeNull();
  });

  it("is null for an empty or whitespace value", () => {
    expect(loadConfig({ ...PROD_ENV, GATEWAY_FAILPOINT: "" }).failpoint).toBeNull();
    expect(loadConfig({ ...PROD_ENV, GATEWAY_FAILPOINT: "   " }).failpoint).toBeNull();
  });

  it("refuses an unknown name instead of ignoring it", () => {
    // A typo must not be indistinguishable from disarmed in either direction.
    for (const bad of ["true", "1", "on", "after_chatwoot_commit", "AFTER_CHATWOOT_COMMIT_BEFORE_LEDGER_COMPLETE"]) {
      expect(loadConfig({ ...PROD_ENV, GATEWAY_FAILPOINT: bad }).failpoint).toBe(
        "unrecognised",
      );
    }
  });

  it("accepts only the exact known name", () => {
    expect(
      loadConfig({
        ...PROD_ENV,
        GATEWAY_FAILPOINT: "after_chatwoot_commit_before_ledger_complete",
      }).failpoint,
    ).toBe("after_chatwoot_commit_before_ledger_complete");
    expect(FAILPOINTS).toEqual(["after_chatwoot_commit_before_ledger_complete"]);
    expect(isFailpointName("nope")).toBe(false);
  });
});

describe("an armed failpoint is impossible to miss", () => {
  it("warns loudly at boot", () => {
    const warnings = bootWarnings(
      loadConfig({
        ...PROD_ENV,
        GATEWAY_FAILPOINT: "after_chatwoot_commit_before_ledger_complete",
      }),
    ).join(" ");
    expect(warnings).toMatch(/ARMED/);
    expect(warnings).toMatch(/TEST-ONLY/);
    expect(warnings).toMatch(/never be set on a production deployment/);
  });

  it("warns that an unrecognised name refuses the boot", () => {
    const warnings = bootWarnings(
      loadConfig({ ...PROD_ENV, GATEWAY_FAILPOINT: "typo" }),
    ).join(" ");
    expect(warnings).toMatch(/not a known failpoint/);
    expect(warnings).toMatch(/refuse to start/);
  });
});

describe("the disarmed failpoint is a pure no-op", () => {
  it("reports armed: null and returns immediately", async () => {
    expect(DISARMED.armed).toBeNull();
    const before = Date.now();
    await DISARMED.trip("after_chatwoot_commit_before_ledger_complete", {});
    expect(Date.now() - before).toBeLessThan(50);
  });

  it("createFailpoint({armed: null}) IS the disarmed singleton", () => {
    const logger = new CapturingLogger();
    expect(createFailpoint({ armed: null, logger: logger.logger })).toBe(DISARMED);
  });
});

describe("an armed failpoint terminates, and only at its own name", () => {
  it("does nothing for a name it is not armed for", async () => {
    const logger = new CapturingLogger();
    const terminate = vi.fn();
    const fp = createFailpoint({
      armed: "after_chatwoot_commit_before_ledger_complete",
      logger: logger.logger,
      terminate,
    });
    // There is currently one name, so assert the guard directly rather than
    // inventing a second one: tripping with a different string must not fire.
    await fp.trip("some_other_point" as never, {});
    expect(terminate).not.toHaveBeenCalled();
  });

  it("terminates and alerts on its own name, and never returns", async () => {
    const logger = new CapturingLogger();
    const terminate = vi.fn();
    const fp = createFailpoint({
      armed: "after_chatwoot_commit_before_ledger_complete",
      logger: logger.logger,
      terminate,
    });

    let returned = false;
    void fp
      .trip("after_chatwoot_commit_before_ledger_complete", { action: "reply" })
      .then(() => {
        returned = true;
      });
    await new Promise((r) => setTimeout(r, 20));

    expect(terminate).toHaveBeenCalledWith(97);
    // Must not resolve: a test must never observe the post-failpoint path as
    // though the process had survived.
    expect(returned).toBe(false);

    const alert = logger.lines.find((l) => l["alertCode"] === "failpoint_tripped");
    expect(alert).toBeDefined();
    expect(alert?.["failpoint"]).toBe("after_chatwoot_commit_before_ledger_complete");
    expect(alert?.["action"]).toBe("reply");
  });
});
