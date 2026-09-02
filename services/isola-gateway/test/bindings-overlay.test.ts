/**
 * THE ADDITIVE BOOT-TIME BINDING OVERLAY.
 *
 * The overlay exists because adding a fifth binding used to mean re-minting the
 * one secret that carries the credentials of the LIVE front desk. That
 * operation was refused, and the refusal ratified, on 2026-08-18. So the whole
 * point of this file is to prove two things at once:
 *
 *   1. an overlay binding can be ADDED, and
 *   2. an overlay binding can NEVER replace, shadow or edit a boot binding.
 *
 * Every refusal test below is paired with the happy-path tests at the top of the
 * file, which are its positive control: without them a broken resolver would
 * make every "refuses" test pass for the wrong reason — the overlay would be
 * refusing EVERYTHING, and the suite would read as green.
 *
 * The credential values here are generated sentinels. If one of them ever
 * appears in a response, a log line or an error string, that is a leak, and the
 * assertions at the bottom of this file are what would catch it.
 */
import { describe, expect, it } from "vitest";

import { secretEnvName, StaticBindingStore } from "../src/bindings.js";
import {
  ADMIN_TOKEN,
  BASE_ENV,
  bindingsJson,
  CapturingLogger,
  envConfig,
  get,
  makeBinding,
  placeholder,
  startServer,
} from "./harness.js";

// Unmistakable, and nothing like a real credential shape by accident.
const SENTINEL_SECRET = placeholder("overlay-sentinel-secret");
const SENTINEL_TOKEN = placeholder("overlay-sentinel-token");
const SENTINELS = [SENTINEL_SECRET, SENTINEL_TOKEN];

const SECRET_REF = "canary-a";
const TOKEN_REF = "canary-a.token";

/** The environment `entrypoint.sh` would have materialised from two secret files. */
const SECRET_ENV = {
  [secretEnvName(SECRET_REF)]: SENTINEL_SECRET,
  [secretEnvName(TOKEN_REF)]: SENTINEL_TOKEN,
};

/**
 * An overlay record: an ordinary binding with the two credential fields removed
 * and replaced by logical references. Note what is NOT here — no path, no root,
 * no URL. The manifest cannot name a file even if its author wants to.
 */
function overlayRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const { agentBotSecret, agentBotAccessToken, ...rest } = makeBinding({
    tenantId: "tenant-canary",
    chatwootInboxId: 6,
  }) as unknown as Record<string, unknown>;
  void agentBotSecret;
  void agentBotAccessToken;
  return {
    ...rest,
    agentBotSecretRef: SECRET_REF,
    agentBotAccessTokenRef: TOKEN_REF,
    ...overrides,
  };
}

/** Load a config with an overlay and the secrets it references. */
function withOverlay(
  records: unknown[],
  envOverrides: Record<string, string | undefined> = {},
): ReturnType<typeof envConfig> {
  return envConfig({
    ...SECRET_ENV,
    GATEWAY_BINDINGS_OVERLAY_JSON: JSON.stringify(records),
    ...envOverrides,
  });
}

/** Every error string a failed parse produced, joined for scanning. */
function errorsOf(config: ReturnType<typeof envConfig>): string {
  expect(config.bindings.ok).toBe(false);
  return config.bindings.ok ? "" : config.bindings.errors.join(" | ");
}

// ───────────────────────────────────────────────────────────────────────────
// BACKWARD COMPATIBILITY — the overlay must be invisible when unused
// ───────────────────────────────────────────────────────────────────────────

describe("with no overlay configured, nothing changes", () => {
  it("parses the existing bundle to exactly the same bindings", () => {
    const config = envConfig();
    expect(config.bindings.ok).toBe(true);
    if (!config.bindings.ok) return;
    expect(config.bindings.bindings).toHaveLength(1);
    expect(config.bindings.bindings[0]).toEqual(makeBinding());
  });

  it("an absent overlay and an empty overlay are the same thing", () => {
    for (const value of [undefined, "", "   ", "[]"]) {
      const config = envConfig({ GATEWAY_BINDINGS_OVERLAY_JSON: value });
      expect(config.bindings.ok).toBe(true);
      if (!config.bindings.ok) continue;
      expect(config.bindings.bindings).toEqual([makeBinding()]);
    }
  });

  it("requires no new secret to be configured", () => {
    // No GATEWAY_BINDING_SECRET_* set anywhere, and boot is still clean.
    const config = envConfig();
    expect(config.bindings.ok).toBe(true);
  });

  it("still refuses an invalid boot bundle", () => {
    const config = envConfig({ GATEWAY_BINDINGS_JSON: "{not json" });
    expect(errorsOf(config)).toContain("GATEWAY_BINDINGS_JSON is not valid JSON");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// THE POSITIVE CONTROL — the overlay genuinely works
// ───────────────────────────────────────────────────────────────────────────

describe("a valid overlay adds bindings", () => {
  it("loads one overlay binding and resolves its credentials", () => {
    const config = withOverlay([overlayRecord()]);
    expect(config.bindings.ok).toBe(true);
    if (!config.bindings.ok) return;
    expect(config.bindings.bindings).toHaveLength(2);
    const added = config.bindings.bindings[1];
    expect(added?.tenantId).toBe("tenant-canary");
    expect(added?.chatwootInboxId).toBe(6);
    // The reference resolved to the secret's CONTENT, and the reference fields
    // did not survive into the binding.
    expect(added?.agentBotSecret).toBe(SENTINEL_SECRET);
    expect(added?.agentBotAccessToken).toBe(SENTINEL_TOKEN);
    expect(added).not.toHaveProperty("agentBotSecretRef");
  });

  it("loads several overlay bindings", () => {
    const config = withOverlay([
      overlayRecord(),
      overlayRecord({ tenantId: "tenant-canary-2", chatwootInboxId: 11 }),
    ]);
    expect(config.bindings.ok).toBe(true);
    if (!config.bindings.ok) return;
    expect(config.bindings.bindings.map((b) => b.tenantId)).toEqual([
      "tenant-acme",
      "tenant-canary",
      "tenant-canary-2",
    ]);
  });

  it("puts boot bindings first, and the combined list is immutable", () => {
    const config = withOverlay([overlayRecord()]);
    if (!config.bindings.ok) throw new Error("expected a valid config");
    const store = new StaticBindingStore(config.bindings.bindings);
    expect(store.list()[0]?.tenantId).toBe("tenant-acme");
    expect(Object.isFrozen(store.list())).toBe(true);
  });

  it("strips only a terminal newline from the secret file's contents", () => {
    const config = withOverlay([overlayRecord()], {
      [secretEnvName(SECRET_REF)]: `${SENTINEL_SECRET}\n`,
    });
    if (!config.bindings.ok) throw new Error("expected a valid config");
    expect(config.bindings.bindings[1]?.agentBotSecret).toBe(SENTINEL_SECRET);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// AN OVERLAY MAY ADD. IT MAY NEVER REPLACE.
// ───────────────────────────────────────────────────────────────────────────

describe("an overlay binding cannot shadow a boot binding", () => {
  it("refuses a tenantId already declared by a boot binding", () => {
    const config = withOverlay([overlayRecord({ tenantId: "tenant-acme", chatwootInboxId: 99 })]);
    expect(errorsOf(config)).toContain("never replace one");
  });

  it("refuses the (account, inbox) routing key of a boot binding", () => {
    const config = withOverlay([overlayRecord({ chatwootInboxId: 7 })]);
    expect(errorsOf(config)).toContain("already declared by a boot binding");
  });

  it("refuses a duplicate inside the overlay itself", () => {
    const config = withOverlay([overlayRecord(), overlayRecord()]);
    expect(errorsOf(config)).toContain("overlay[1]");
  });

  it("leaves the boot binding's own credentials untouched when it refuses", () => {
    // The refusal must not be a partial application. Nothing loads at all.
    const config = withOverlay([overlayRecord({ chatwootInboxId: 7 })]);
    expect(config.bindings.ok).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// THE MANIFEST IS NOT SECRET MATERIAL, AND CANNOT NAME A FILE
// ───────────────────────────────────────────────────────────────────────────

describe("the overlay refuses credential material and anything path-shaped", () => {
  it("refuses an inline agentBotSecret even when it would be valid", () => {
    const config = withOverlay([overlayRecord({ agentBotSecret: SENTINEL_SECRET })]);
    const errors = errorsOf(config);
    expect(errors).toContain("must not contain the inline credential field");
    // And the refusal must not quote the thing it refused.
    for (const s of SENTINELS) expect(errors).not.toContain(s);
  });

  it("refuses an inline agentBotAccessToken", () => {
    const config = withOverlay([overlayRecord({ agentBotAccessToken: SENTINEL_TOKEN })]);
    expect(errorsOf(config)).toContain("must not contain the inline credential field");
  });

  it("refuses a missing reference", () => {
    const record = overlayRecord();
    delete record["agentBotSecretRef"];
    expect(errorsOf(withOverlay([record]))).toContain("agentBotSecretRef is required");
  });

  it("refuses an absolute path as a reference", () => {
    const config = withOverlay([overlayRecord({ agentBotSecretRef: "/run/secrets/canary" })]);
    expect(errorsOf(config)).toContain("not a valid secret reference");
  });

  it("refuses a relative path and a traversal attempt", () => {
    for (const ref of ["../secrets/x", "..", "a/b", "a\\b", "./x"]) {
      const config = withOverlay([overlayRecord({ agentBotSecretRef: ref })]);
      expect(errorsOf(config)).toContain("not a valid secret reference");
    }
  });

  it("refuses a token-bearing URL as a reference", () => {
    const config = withOverlay([
      overlayRecord({ agentBotSecretRef: "https://host.test/?token=abc" }),
    ]);
    expect(errorsOf(config)).toContain("not a valid secret reference");
  });

  it("refuses characters outside the allowlist", () => {
    for (const ref of ["bad ref", "ref$", "ref;rm", "réf", "x".repeat(65)]) {
      expect(errorsOf(withOverlay([overlayRecord({ agentBotSecretRef: ref })]))).toContain(
        "not a valid secret reference",
      );
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// A MISSING CREDENTIAL IS A BOOT REFUSAL, NEVER A SKIPPED BINDING
// ───────────────────────────────────────────────────────────────────────────

describe("credential resolution fails closed", () => {
  it("refuses a reference to a secret that was never configured", () => {
    const config = withOverlay([overlayRecord({ agentBotSecretRef: "never-provisioned" })]);
    const errors = errorsOf(config);
    expect(errors).toContain("references a secret that is not configured");
    // The error names the VARIABLE an operator must set, never a value.
    expect(errors).toContain("GATEWAY_BINDING_SECRET_NEVER_PROVISIONED");
  });

  it("distinguishes an ABSENT secret from a BLANK one, and refuses both", () => {
    // Two different operator mistakes: the variable was never set, or it was set
    // to nothing. Both fail closed, and the message says which, because the fix
    // is different in each case.
    const blank = withOverlay([overlayRecord()], { [secretEnvName(SECRET_REF)]: "" });
    expect(errorsOf(blank)).toContain("references a secret that is empty");

    const absent = withOverlay([overlayRecord({ agentBotSecretRef: "never-provisioned" })]);
    expect(errorsOf(absent)).toContain("references a secret that is not configured");
  });

  it("refuses a secret that is only a newline", () => {
    const config = withOverlay([overlayRecord()], { [secretEnvName(SECRET_REF)]: "\n" });
    expect(errorsOf(config)).toContain("references a secret that is empty");
  });

  it("refuses an oversized secret", () => {
    const config = withOverlay([overlayRecord()], {
      [secretEnvName(SECRET_REF)]: "x".repeat(4097),
    });
    expect(errorsOf(config)).toContain("longer than 4096 characters");
  });

  it("refuses a malformed overlay document", () => {
    expect(errorsOf(envConfig({ GATEWAY_BINDINGS_OVERLAY_JSON: "{not json" }))).toContain(
      "GATEWAY_BINDINGS_OVERLAY_JSON is not valid JSON",
    );
    expect(errorsOf(envConfig({ GATEWAY_BINDINGS_OVERLAY_JSON: '{"a":1}' }))).toContain(
      "must be a JSON array",
    );
  });

  it("applies the SAME schema rules a boot binding gets", () => {
    // Delegated to parseBindings, so an overlay binding cannot be laxer.
    const config = withOverlay([overlayRecord({ exposure: "SOMETHING-ELSE" })]);
    expect(errorsOf(config)).toContain("overlay[0]");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// NOTHING LEAKS
// ───────────────────────────────────────────────────────────────────────────

describe("overlay credentials never leave the process", () => {
  const config = withOverlay([overlayRecord()]);

  it("GET /v1/bindings redacts the overlay binding exactly like a boot one", async () => {
    const server = await startServer({ config });
    try {
      const res = await get(server.url, "/v1/bindings", ADMIN_TOKEN);
      expect(res.status).toBe(200);
      for (const s of SENTINELS) expect(res.text).not.toContain(s);
      const bindings = res.json["bindings"] as Array<Record<string, unknown>>;
      expect(bindings).toHaveLength(2);
      const overlay = bindings[1];
      expect(overlay?.["tenantId"]).toBe("tenant-canary");
      expect(overlay?.["agentBotSecret"]).toBe("[redacted]");
      expect(overlay?.["agentBotAccessToken"]).toBe("[redacted]");
      expect(overlay?.["agentBotSecretConfigured"]).toBe(true);
      expect(overlay?.["agentBotAccessTokenConfigured"]).toBe(true);
      // The reference itself is operational metadata, but it is not something
      // the audit view promises, and it must not smuggle the value either.
      expect(res.text).not.toContain(SENTINEL_SECRET);
    } finally {
      await server.close();
    }
  });

  it("/healthz counts the overlay binding and says nothing else about it", async () => {
    const server = await startServer({ config });
    try {
      const res = await get(server.url, "/healthz");
      expect(res.json["bindings"]).toEqual({ total: 2, active: 2, retired: 0 });
      for (const s of SENTINELS) expect(res.text).not.toContain(s);
      expect(res.text).not.toContain("tenant-canary");
    } finally {
      await server.close();
    }
  });

  it("no boot log line carries either sentinel", async () => {
    const capture = new CapturingLogger();
    const server = await startServer({ config, logger: capture.logger });
    try {
      await get(server.url, "/healthz");
      await get(server.url, "/v1/bindings", ADMIN_TOKEN);
      await get(server.url, "/v1/bindings");
      await get(server.url, "/no-such-route");
    } finally {
      await server.close();
    }
    const lines = JSON.stringify(capture.lines);
    for (const s of SENTINELS) expect(lines).not.toContain(s);
  });

  it("no refusal message quotes the credential it refused", () => {
    // Every failure mode that has a real secret in scope, scanned together.
    const cases = [
      withOverlay([overlayRecord({ chatwootInboxId: 7 })]),
      withOverlay([overlayRecord({ agentBotSecret: SENTINEL_SECRET })]),
      withOverlay([overlayRecord(), overlayRecord()]),
      withOverlay([overlayRecord()], { [secretEnvName(SECRET_REF)]: "x".repeat(4097) }),
    ];
    for (const c of cases) {
      const errors = errorsOf(c);
      for (const s of SENTINELS) expect(errors).not.toContain(s);
      expect(errors).not.toContain("xxxxxxxxxx");
    }
  });

  it("the sentinels are genuinely reachable, so the scans above are not vacuous", () => {
    // Positive control for this whole describe block: if the resolver silently
    // returned nothing, every "not.toContain" above would pass for the wrong
    // reason. This proves the value really is in the loaded binding.
    if (!config.bindings.ok) throw new Error("expected a valid config");
    expect(config.bindings.bindings[1]?.agentBotSecret).toBe(SENTINEL_SECRET);
    expect(bindingsJson(config.bindings.bindings)).toContain(SENTINEL_SECRET);
    expect(BASE_ENV["GATEWAY_BINDINGS_JSON"]).not.toContain(SENTINEL_SECRET);
  });
});
