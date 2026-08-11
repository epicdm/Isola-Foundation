/**
 * Binding validation and resolution — the tenant-isolation boundary.
 */
import { describe, expect, it } from "vitest";

import {
  candidateSecrets,
  parseBindings,
  redactBinding,
  resolveBinding,
  StaticBindingStore,
  type Binding,
} from "../src/bindings.js";
import { BOT_ACCESS_TOKEN, BOT_SECRET, makeBinding, placeholder } from "./harness.js";

function json(entries: unknown[]): string {
  return JSON.stringify(entries);
}

describe("parseBindings", () => {
  it("accepts a well-formed binding", () => {
    const result = parseBindings(json([makeBinding()]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.bindings).toHaveLength(1);
    expect(result.bindings[0]?.tenantId).toBe("tenant-acme");
  });

  it("treats an unset or empty value as zero bindings, not as an error", () => {
    for (const value of [undefined, null, "", "   "]) {
      const result = parseBindings(value);
      expect(result).toEqual({ ok: true, bindings: [] });
    }
  });

  it("rejects a value that is not a JSON array", () => {
    expect(parseBindings("{").ok).toBe(false);
    expect(parseBindings('{"a":1}')).toEqual({
      ok: false,
      errors: ["GATEWAY_BINDINGS_JSON must be a JSON array"],
    });
  });

  it("REJECTS a binding whose exposure is not PUBLIC", () => {
    const result = parseBindings(json([{ ...makeBinding(), exposure: "INTERNAL" }]));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join(" ")).toMatch(/must be exactly "PUBLIC"/);
  });

  it("rejects a duplicate (accountId, inboxId) pair", () => {
    const result = parseBindings(
      json([makeBinding(), makeBinding({ tenantId: "tenant-other" })]),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join(" ")).toMatch(/duplicate \(chatwootAccountId, chatwootInboxId\)/);
  });

  it("rejects a binding with no secret or no access token", () => {
    const noSecret = parseBindings(json([{ ...makeBinding(), agentBotSecret: "" }]));
    expect(noSecret.ok).toBe(false);
    const noToken = parseBindings(json([{ ...makeBinding(), agentBotAccessToken: undefined }]));
    expect(noToken.ok).toBe(false);
  });

  it("rejects an unknown status", () => {
    expect(parseBindings(json([{ ...makeBinding(), status: "paused" }])).ok).toBe(false);
  });

  it("accepts a retired binding", () => {
    const result = parseBindings(json([makeBinding({ status: "retired" })]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.bindings[0]?.status).toBe("retired");
  });

  it("never echoes a secret into a validation error", () => {
    const result = parseBindings(
      json([{ ...makeBinding(), chatwootInboxId: "not-a-number" }]),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const joined = result.errors.join(" ");
    expect(joined).not.toContain(BOT_SECRET);
    expect(joined).not.toContain(BOT_ACCESS_TOKEN);
  });

  it("accepts numeric ids given as strings, and an optional escalation team", () => {
    const result = parseBindings(
      json([{ ...makeBinding(), chatwootAccountId: "1", escalationTeamId: "9" }]),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.bindings[0]?.chatwootAccountId).toBe(1);
    expect(result.bindings[0]?.escalationTeamId).toBe(9);
  });
});

describe("resolveBinding", () => {
  const active = makeBinding();

  it("resolves exactly one active PUBLIC binding", () => {
    expect(resolveBinding([active], 1, 7)).toEqual({ kind: "ok", binding: active });
  });

  it("refuses an unknown (account, inbox) pair", () => {
    expect(resolveBinding([active], 1, 8)).toEqual({ kind: "not_found" });
    expect(resolveBinding([active], 2, 7)).toEqual({ kind: "not_found" });
    expect(resolveBinding([active], null, 7)).toEqual({ kind: "not_found" });
  });

  it("refuses a duplicate even though boot validation should have caught it", () => {
    // Defence in depth for a future store (NocoBase, a database) that can
    // return two rows where the env store could not.
    const result = resolveBinding([active, makeBinding({ tenantId: "other" })], 1, 7);
    expect(result).toEqual({ kind: "duplicate", count: 2 });
  });

  it("refuses a retired binding", () => {
    const retired = makeBinding({ status: "retired" });
    expect(resolveBinding([retired], 1, 7)).toEqual({
      kind: "retired",
      tenantId: retired.tenantId,
    });
  });

  it("refuses an INTERNAL binding outright", () => {
    // An INTERNAL employee must never serve a publicly reachable inbox.
    const internal = { ...makeBinding(), exposure: "INTERNAL" } as Binding;
    expect(resolveBinding([internal], 1, 7)).toEqual({
      kind: "not_public",
      tenantId: internal.tenantId,
      exposure: "INTERNAL",
    });
  });
});

describe("candidateSecrets", () => {
  it("returns the secrets for that inbox only", () => {
    const other = makeBinding({
      chatwootInboxId: 8,
      agentBotSecret: placeholder("other-bot"),
    });
    expect(candidateSecrets([makeBinding(), other], 1, 7)).toEqual([BOT_SECRET]);
    expect(candidateSecrets([makeBinding(), other], 1, 9)).toEqual([]);
  });

  it("includes retired bindings so an authentic delivery is not reported as unauthorized", () => {
    expect(candidateSecrets([makeBinding({ status: "retired" })], 1, 7)).toEqual([BOT_SECRET]);
  });
});

describe("redactBinding", () => {
  it("never returns secret material", () => {
    const redacted = redactBinding(makeBinding());
    expect(JSON.stringify(redacted)).not.toContain(BOT_SECRET);
    expect(JSON.stringify(redacted)).not.toContain(BOT_ACCESS_TOKEN);
    expect(redacted["agentBotSecret"]).toBe("[redacted]");
    expect(redacted["agentBotAccessToken"]).toBe("[redacted]");
    expect(redacted["agentBotSecretConfigured"]).toBe(true);
    expect(redacted["tenantId"]).toBe("tenant-acme");
  });
});

describe("StaticBindingStore", () => {
  it("returns what it was given", () => {
    const store = new StaticBindingStore([makeBinding()]);
    expect(store.list()).toHaveLength(1);
  });
});
