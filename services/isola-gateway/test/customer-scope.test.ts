/**
 * `src/customer-scope.ts` — the resolver contract, the fixture resolver and the
 * boot-time selection.
 *
 * Every refusal carries its positive twin in the same file (Laws 19, 28): an
 * "unknown number is unresolved" test would pass vacuously if the fixture
 * resolver refused everything, so the matching number is asserted to VERIFY in
 * the same block.
 */
import { describe, expect, it } from "vitest";

import {
  createFailClosedCustomerScopeResolver,
  createFixtureCustomerScopeResolver,
  customerScopeFromEnv,
  resolveCustomerScope,
  type CustomerScopeQuery,
  type CustomerScopeResolver,
} from "../src/customer-scope.js";

const QUERY: CustomerScopeQuery = {
  tenantId: "tenant-acme",
  chatwootAccountId: 1,
  chatwootInboxId: 7,
  chatwootConversationId: 42,
  channelSubject: "+1 (767) 555-0101",
};

const FIXTURE = {
  // a fixture is declared for ONE (tenant, account, inbox): the same ones QUERY carries
  tenantId: "tenant-acme",
  chatwootAccountId: 1,
  chatwootInboxId: 7,
  senderPhone: "+17675550101",
  customerId: "fixture-owner-test-account",
  serviceIds: ["fixture-line-1"],
  liteAccountId: "fixture-owner-test-account",
  magnusUserId: null,
  odooPartnerId: null,
};

describe("resolveCustomerScope — a resolver's failure or surprise is never an answer", () => {
  const asResolver = (impl: () => unknown): CustomerScopeResolver => ({
    resolve: (async () => impl()) as unknown as CustomerScopeResolver["resolve"],
  });

  it("CONTROL: a well-formed verified verdict passes through, ids intact", async () => {
    const out = await resolveCustomerScope(
      asResolver(() => ({ kind: "verified", customerId: "c1", serviceIds: ["s1"], odooPartnerId: null })),
      QUERY,
    );
    expect(out).toEqual({
      verdict: { kind: "verified", customerId: "c1", serviceIds: ["s1"], odooPartnerId: null },
      reason: null,
    });
  });

  it("a rejecting resolver is unresolved with reason resolver_failed (never anonymous)", async () => {
    const out = await resolveCustomerScope(
      asResolver(() => {
        throw new Error("customer directory down");
      }),
      QUERY,
    );
    expect(out.verdict).toEqual({ kind: "unresolved" });
    expect(out.reason).toBe("resolver_failed");
  });

  it.each([
    ["null", null],
    ["a string", "verified"],
    ["an unknown kind", { kind: "admin" }],
    ["verified with no customerId", { kind: "verified", serviceIds: [] }],
    ["verified with an empty customerId", { kind: "verified", customerId: " ", serviceIds: [] }],
    ["verified with non-array serviceIds", { kind: "verified", customerId: "c", serviceIds: "s" }],
    ["verified with a non-string service id", { kind: "verified", customerId: "c", serviceIds: [1] }],
  ])("%s is unresolved with reason resolver_returned_invalid_verdict", async (_label, bad) => {
    const out = await resolveCustomerScope(asResolver(() => bad), QUERY);
    expect(out.verdict).toEqual({ kind: "unresolved" });
    expect(out.reason).toBe("resolver_returned_invalid_verdict");
  });

  it("extra properties on a verdict are DROPPED — a resolver (or an HTTP body) cannot smuggle a claim into the run context", async () => {
    const out = await resolveCustomerScope(
      asResolver(() => ({
        kind: "verified",
        customerId: "c1",
        serviceIds: ["s1"],
        isAdmin: true,
        claimedCustomer: "cust-victim-bob",
      })),
      QUERY,
    );
    expect(JSON.stringify(out.verdict)).not.toContain("isAdmin");
    expect(JSON.stringify(out.verdict)).not.toContain("cust-victim-bob");
    expect(out.verdict).toEqual({ kind: "verified", customerId: "c1", serviceIds: ["s1"] });
  });

  it("an explicit anonymous verdict is passed through (it is the resolver's call, not a default)", async () => {
    const out = await resolveCustomerScope(asResolver(() => ({ kind: "anonymous" })), QUERY);
    expect(out).toEqual({ verdict: { kind: "anonymous" }, reason: null });
  });
});

describe("the fail-closed default resolver", () => {
  it("answers unresolved for everyone", async () => {
    const r = createFailClosedCustomerScopeResolver();
    expect(await r.resolve(QUERY)).toEqual({ kind: "unresolved" });
    expect(await r.resolve({ ...QUERY, channelSubject: null })).toEqual({ kind: "unresolved" });
  });
});

describe("the FIXTURE resolver — a known fixture account or nothing", () => {
  const resolver = createFixtureCustomerScopeResolver([FIXTURE]);

  it("CONTROL: the fixture's number (any formatting) verifies, with the fixture's ids", async () => {
    const out = await resolver.resolve(QUERY);
    expect(out).toMatchObject({
      kind: "verified",
      customerId: "fixture-owner-test-account",
      serviceIds: ["fixture-line-1"],
      liteAccountId: "fixture-owner-test-account",
      magnusUserId: null,
      odooPartnerId: null,
    });
  });

  it("an UNKNOWN number is unresolved, NOT anonymous: an API-channel identifier is caller-supplied", async () => {
    expect(await resolver.resolve({ ...QUERY, channelSubject: "+17675550199" })).toEqual({
      kind: "unresolved",
    });
  });

  it("a number that merely ENDS like the fixture's does not match (no suffix matching)", async () => {
    expect(await resolver.resolve({ ...QUERY, channelSubject: "99917675550101" })).toEqual({
      kind: "unresolved",
    });
  });

  it("no sender phone, and a too-short one, are unresolved", async () => {
    expect(await resolver.resolve({ ...QUERY, channelSubject: null })).toEqual({ kind: "unresolved" });
    expect(await resolver.resolve({ ...QUERY, channelSubject: "0101" })).toEqual({ kind: "unresolved" });
  });

  it("refuses two fixtures that share a number, and an unusable number (the ambiguity the production rule refuses)", () => {
    expect(() =>
      createFixtureCustomerScopeResolver([FIXTURE, { ...FIXTURE, customerId: "other" }]),
    ).toThrow(/share one phone number/);
    expect(() => createFixtureCustomerScopeResolver([{ ...FIXTURE, senderPhone: "12" }])).toThrow(
      /usable phone/,
    );
  });
});

describe("customerScopeFromEnv — a typo never reads as 'off'", () => {
  it("unset / empty / off: no resolver (today's behaviour)", () => {
    for (const env of [{}, { GATEWAY_CUSTOMER_SCOPE_MODE: "" }, { GATEWAY_CUSTOMER_SCOPE_MODE: "off" }]) {
      const out = customerScopeFromEnv(env);
      expect(out).toEqual({ ok: true, resolver: undefined, mode: "off" });
    }
  });

  it("fail_closed: a resolver that answers unresolved", async () => {
    const out = customerScopeFromEnv({ GATEWAY_CUSTOMER_SCOPE_MODE: "fail_closed" });
    expect(out.ok).toBe(true);
    if (out.ok) expect(await out.resolver!.resolve(QUERY)).toEqual({ kind: "unresolved" });
  });

  it("fixture: a valid list builds a resolver that verifies the fixture and nobody else", async () => {
    const out = customerScopeFromEnv({
      GATEWAY_CUSTOMER_SCOPE_MODE: "fixture",
      GATEWAY_CUSTOMER_SCOPE_FIXTURES_JSON: JSON.stringify([FIXTURE]),
    });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.mode).toBe("fixture");
      expect((await out.resolver!.resolve(QUERY)).kind).toBe("verified");
      expect((await out.resolver!.resolve({ ...QUERY, channelSubject: "+17675550199" })).kind).toBe(
        "unresolved",
      );
    }
  });

  it.each([
    ["an unrecognised mode", { GATEWAY_CUSTOMER_SCOPE_MODE: "fixtures" }],
    ["fixture mode with no list", { GATEWAY_CUSTOMER_SCOPE_MODE: "fixture" }],
    ["fixture mode with invalid JSON", { GATEWAY_CUSTOMER_SCOPE_MODE: "fixture", GATEWAY_CUSTOMER_SCOPE_FIXTURES_JSON: "{nope" }],
    ["fixture mode with an empty list", { GATEWAY_CUSTOMER_SCOPE_MODE: "fixture", GATEWAY_CUSTOMER_SCOPE_FIXTURES_JSON: "[]" }],
    ["fixture mode with a fixture missing its customerId", { GATEWAY_CUSTOMER_SCOPE_MODE: "fixture", GATEWAY_CUSTOMER_SCOPE_FIXTURES_JSON: JSON.stringify([{ senderPhone: "+17675550101", serviceIds: [] }]) }],
    ["fixture mode with a duplicate number", { GATEWAY_CUSTOMER_SCOPE_MODE: "fixture", GATEWAY_CUSTOMER_SCOPE_FIXTURES_JSON: JSON.stringify([FIXTURE, FIXTURE]) }],
  ])("REFUSES to boot on %s", (_label, env) => {
    const out = customerScopeFromEnv(env);
    expect(out.ok).toBe(false);
  });

  it("a refusal message never contains a fixture value", () => {
    const out = customerScopeFromEnv({
      GATEWAY_CUSTOMER_SCOPE_MODE: "fixture",
      GATEWAY_CUSTOMER_SCOPE_FIXTURES_JSON: JSON.stringify([FIXTURE, FIXTURE]),
    });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error).not.toContain("7675550101");
      expect(out.error).not.toContain("fixture-owner-test-account");
    }
  });
});
