import { describe, expect, it } from "vitest";
import {
  FAIL_CLOSED_PROMPT,
  GRACE_MULTIPLIER,
  createInstructionsProvider,
  isUsablePrompt,
  parseBusinessFactsMap,
  parseInstructionsMap,
} from "../src/instructions.js";

// Synthetic ids throughout -- deliberately NOT any real Paperclip agent id. Real
// production candidates for this template (fd2867d1, 5c3277f0, a9dce05a) are exactly
// the ones this correction must not casually treat as "safe example data": fd2867d1 in
// particular was placed under an explicit owner containment instruction ("do not wake,
// promote or reuse") and its runtime callback key was revoked -- see
// defect-isolart-runtime-no-per-tenant-business-knowledge-2026-09-17.
const TEMPLATE = "isola-ai-sales-front-desk-agent@v1";
const PERSONA_AGENT = "aaaaaaaa-0000-4000-8000-000000000001";
const OTHER_TEMPLATE = "isola-internal-manager@v1";
const OTHER_PERSONA_AGENT = "aaaaaaaa-0000-4000-8000-000000000002";
// Two DIFFERENT tenants' agents sharing the SAME TEMPLATE for business-fact purposes.
const AGENT_A = "bbbbbbbb-1111-4111-8111-111111111111";
const AGENT_B = "bbbbbbbb-2222-4222-8222-222222222222";
// A real, mapped agent id -- but authorized for a DIFFERENT template than the one it
// will be invoked under. This is the "spoofed/mismatched identity" case.
const MISMATCHED_AGENT = "bbbbbbbb-3333-4333-8333-333333333333";

const COMPILED_IN = "compiled-in prompt".padEnd(300, ".");
const BUNDLE = "EPIC opens Monday to Friday, 8:00am to 4:00pm.".padEnd(400, ".");
const FACTS_A = "Aurora Boat Yard -- Hull cleaning, EC$450 per visit.";
const FACTS_B = "Zephyr Kite School -- Kite rigging, EC$1,275 per course.";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * A SafeFetch stub that counts calls and can be told to fail. Distinguishes
 * AGENTS.md from BUSINESS.md by URL and, for BUSINESS.md, by WHICH agent id the URL
 * names -- `businessFactsByAgent` supplies content per agent, matching the real shape
 * (each agent has its own bundle).
 */
function stubFetch(behaviour: {
  body?: unknown;
  status?: number;
  throws?: boolean;
  businessFactsByAgent?: Record<string, string>;
}) {
  const state = { calls: 0, urls: [] as string[], ...behaviour };
  const safeFetch = async (input: string | URL): Promise<Response> => {
    state.calls++;
    const url = String(input);
    state.urls.push(url);
    if (state.throws) throw new Error("egress blocked");
    if (url.includes("path=BUSINESS.md")) {
      const match = url.match(/\/agents\/([^/]+)\/instructions-bundle/);
      const agentId = match?.[1] ? decodeURIComponent(match[1]) : "";
      const facts = state.businessFactsByAgent?.[agentId];
      if (facts === undefined) return jsonResponse({ error: "not found" }, 404);
      return jsonResponse({ content: facts }, 200);
    }
    return jsonResponse(state.body ?? { content: BUNDLE }, state.status ?? 200);
  };
  return { safeFetch, state };
}

function makeProvider(
  overrides: Partial<Parameters<typeof createInstructionsProvider>[0]> = {},
  clock = { t: 1_000_000 },
) {
  const { safeFetch, state } = stubFetch({});
  const provider = createInstructionsProvider({
    baseUrl: "https://paperclip.example",
    map: { [TEMPLATE]: PERSONA_AGENT },
    businessFactsMap: {},
    readToken: () => "board-token",
    safeFetch,
    ttlMs: 60_000,
    timeoutMs: 5_000,
    now: () => clock.t,
    ...overrides,
  });
  return { provider, state, clock };
}

describe("parseInstructionsMap", () => {
  it("parses a template -> agent mapping", () => {
    expect(parseInstructionsMap(`{"${TEMPLATE}":"${PERSONA_AGENT}"}`)).toEqual({
      [TEMPLATE]: PERSONA_AGENT,
    });
  });

  it("returns an EMPTY map on anything malformed — never a partial redirect", () => {
    // A parse error must not silently point a template at the wrong agent, and must
    // not half-apply. Empty means "everything keeps its compiled-in prompt".
    expect(parseInstructionsMap("not json")).toEqual({});
    expect(parseInstructionsMap("[1,2,3]")).toEqual({});
    expect(parseInstructionsMap("null")).toEqual({});
    expect(parseInstructionsMap(undefined)).toEqual({});
    expect(parseInstructionsMap("")).toEqual({});
  });

  it("skips non-string and empty entries rather than coercing them", () => {
    expect(parseInstructionsMap('{"a":123,"b":"","":"x","c":"ok"}')).toEqual({ c: "ok" });
  });

  it("STRUCTURAL LIMIT, BY DESIGN -- a templateId maps to exactly ONE persona agent id, and that is deliberate", () => {
    // A template's persona (AGENTS.md) is meant to be the SAME reusable behaviour
    // script for every tenant instantiating that template -- this map is correctly
    // one-agent-per-template and is UNCHANGED by this correction. Business-fact
    // authorization (below) is the map that had to become many-agents-per-template;
    // this one never should.
    const raw = `{"${TEMPLATE}":"${PERSONA_AGENT}","${TEMPLATE}":"${OTHER_PERSONA_AGENT}"}`;
    expect(parseInstructionsMap(raw)).toEqual({ [TEMPLATE]: OTHER_PERSONA_AGENT });
  });
});

describe("parseBusinessFactsMap", () => {
  it("parses an agent -> authorized templateId mapping, and supports MULTIPLE agents under the SAME template", () => {
    // The fix for defect-isolart-runtime-no-per-tenant-business-knowledge-2026-09-17:
    // unlike parseInstructionsMap, this shape is keyed by agent id, so two agents
    // sharing one templateId are both representable, each under their own key.
    const raw = `{"${AGENT_A}":"${TEMPLATE}","${AGENT_B}":"${TEMPLATE}"}`;
    expect(parseBusinessFactsMap(raw)).toEqual({ [AGENT_A]: TEMPLATE, [AGENT_B]: TEMPLATE });
  });

  it("returns an EMPTY map on anything malformed -- absence of authorization, never a guess", () => {
    expect(parseBusinessFactsMap("not json")).toEqual({});
    expect(parseBusinessFactsMap(undefined)).toEqual({});
  });
});

describe("isUsablePrompt", () => {
  it("rejects an empty or trivially short bundle", () => {
    expect(isUsablePrompt("")).toBe(false);
    expect(isUsablePrompt("hi")).toBe(false);
    expect(isUsablePrompt(null)).toBe(false);
    expect(isUsablePrompt(BUNDLE)).toBe(true);
  });
});

describe("resolve -- persona (unchanged mechanism)", () => {
  it("keeps the compiled-in prompt for a template with no Paperclip binding", async () => {
    const { provider, state } = makeProvider({ map: {} });
    const r = await provider.resolve(TEMPLATE, COMPILED_IN, null);
    expect(r.source).toBe("compiled_in");
    expect(r.prompt).toBe(COMPILED_IN);
    expect(state.calls).toBe(0);
  });

  it("fetches the bundle and uses it as the system prompt (no claimed agent -- persona only)", async () => {
    const { provider, state } = makeProvider();
    const r = await provider.resolve(TEMPLATE, COMPILED_IN, null);
    expect(r.source).toBe("paperclip");
    expect(r.prompt).toBe(BUNDLE);
    expect(r.failure).toBeNull();
    expect(r.businessFactsAgentId).toBeNull();
    // Exactly one fetch: no claimed agent id means business facts are never attempted.
    expect(state.calls).toBe(1);
    expect(state.urls[0]).toContain(`/api/agents/${PERSONA_AGENT}/instructions-bundle/file?path=AGENTS.md`);
  });

  it("serves from cache inside the TTL, then re-reads after it", async () => {
    const clock = { t: 1_000_000 };
    const { provider, state } = makeProvider({}, clock);
    await provider.resolve(TEMPLATE, COMPILED_IN, null);
    clock.t += 30_000;
    const cached = await provider.resolve(TEMPLATE, COMPILED_IN, null);
    expect(state.calls).toBe(1);
    expect(cached.cacheAgeMs).toBe(30_000);

    clock.t += 40_000; // now past the 60s TTL
    await provider.resolve(TEMPLATE, COMPILED_IN, null);
    expect(state.calls).toBe(2); // re-fetches persona on cache expiry
  });

  it("invalidate() forces the next reply to re-read Paperclip", async () => {
    const { provider, state } = makeProvider();
    await provider.resolve(TEMPLATE, COMPILED_IN, null);
    provider.invalidate();
    await provider.resolve(TEMPLATE, COMPILED_IN, null);
    expect(state.calls).toBe(2);
  });

  it("FAILS CLOSED when Paperclip cannot be read and nothing is cached", async () => {
    const { safeFetch } = stubFetch({ throws: true });
    const provider = createInstructionsProvider({
      baseUrl: "https://paperclip.example",
      map: { [TEMPLATE]: PERSONA_AGENT },
      businessFactsMap: {},
      readToken: () => "t",
      safeFetch,
      ttlMs: 60_000,
      timeoutMs: 5_000,
    });
    const r = await provider.resolve(TEMPLATE, COMPILED_IN, null);
    expect(r.source).toBe("fail_closed");
    expect(r.prompt).toBe(FAIL_CLOSED_PROMPT);
    expect(r.failure).toContain("egress blocked");
    // The whole point: it must NOT quietly fall back to answering from the old prompt.
    expect(r.prompt).not.toBe(COMPILED_IN);
  });

  it("fails closed on a non-200 and on an empty bundle", async () => {
    for (const behaviour of [{ status: 500 }, { body: { content: "" } }, { body: {} }]) {
      const { safeFetch } = stubFetch(behaviour);
      const provider = createInstructionsProvider({
        baseUrl: "https://paperclip.example",
        map: { [TEMPLATE]: PERSONA_AGENT },
        businessFactsMap: {},
        readToken: () => "t",
        safeFetch,
        ttlMs: 60_000,
        timeoutMs: 5_000,
      });
      const r = await provider.resolve(TEMPLATE, COMPILED_IN, null);
      expect(r.source).toBe("fail_closed");
    }
  });

  it("serves a stale copy through a brief outage, but not an unbounded one", async () => {
    const clock = { t: 1_000_000 };
    const state = { fail: false, calls: 0 };
    const safeFetch = async (input: string | URL): Promise<Response> => {
      state.calls++;
      if (state.fail) throw new Error("paperclip down");
      return jsonResponse({ content: BUNDLE });
    };
    const provider = createInstructionsProvider({
      baseUrl: "https://paperclip.example",
      map: { [TEMPLATE]: PERSONA_AGENT },
      businessFactsMap: {},
      readToken: () => "t",
      safeFetch,
      ttlMs: 60_000,
      timeoutMs: 5_000,
      now: () => clock.t,
    });
    await provider.resolve(TEMPLATE, COMPILED_IN, null);
    state.fail = true;

    clock.t += 120_000; // past TTL, well inside grace
    const stale = await provider.resolve(TEMPLATE, COMPILED_IN, null);
    expect(stale.source).toBe("paperclip");
    expect(stale.prompt).toBe(BUNDLE);
    expect(stale.failure).toContain("paperclip down");

    clock.t += 60_000 * GRACE_MULTIPLIER; // now beyond the grace window
    const gone = await provider.resolve(TEMPLATE, COMPILED_IN, null);
    expect(gone.source).toBe("fail_closed");
  });
});

describe("business facts -- authorized-identity connection (the corrected fix)", () => {
  it("attaches BUSINESS.md when the claimed agent is authorized for the invoked template", async () => {
    const { safeFetch, state } = stubFetch({ businessFactsByAgent: { [AGENT_A]: FACTS_A } });
    const provider = createInstructionsProvider({
      baseUrl: "https://paperclip.example",
      map: { [TEMPLATE]: PERSONA_AGENT },
      businessFactsMap: { [AGENT_A]: TEMPLATE },
      readToken: () => "t",
      safeFetch,
      ttlMs: 60_000,
      timeoutMs: 5_000,
    });
    // credentialAgentId (4th arg) must PROVE AGENT_A -- caller proof is now
    // unconditional for every agent in businessFactsMap, not opt-in.
    const r = await provider.resolve(TEMPLATE, COMPILED_IN, AGENT_A, AGENT_A);
    expect(r.source).toBe("paperclip");
    expect(r.prompt).toContain(BUNDLE);
    expect(r.prompt).toContain(FACTS_A);
    expect(r.businessFactsAgentId).toBe(AGENT_A);
    expect(state.calls).toBe(2); // persona (PERSONA_AGENT) + business facts (AGENT_A)
  });

  it("REQUIRED, NOT OPTIONAL -- an authorized claim with NO matching credential (e.g. no caller secret minted yet) gets NOTHING, never the claim-alone fallback", async () => {
    // The owner-corrected invariant, tested directly: business-facts authorization
    // in the map is no longer sufficient by itself for ANY agent, regardless of
    // whether an operator has separately "opted in" to hardening -- there is no
    // such separate opt-in anymore. credentialAgentId is null here exactly as it
    // would be for a real caller holding only the shared PUBLIC bearer with no
    // agent-bound secret minted for AGENT_A at all.
    const { safeFetch } = stubFetch({ businessFactsByAgent: { [AGENT_A]: FACTS_A } });
    const provider = createInstructionsProvider({
      baseUrl: "https://paperclip.example",
      map: { [TEMPLATE]: PERSONA_AGENT },
      businessFactsMap: { [AGENT_A]: TEMPLATE },
      readToken: () => "t",
      safeFetch,
      ttlMs: 60_000,
      timeoutMs: 5_000,
    });
    const r = await provider.resolve(TEMPLATE, COMPILED_IN, AGENT_A, null);
    expect(r.businessFactsAgentId).toBeNull();
    expect(r.prompt).not.toContain(FACTS_A);
    expect(r.prompt).toBe(BUNDLE);
    expect(r.businessFactsRejectedAgentId).toBe(AGENT_A);
  });

  it("REQUIREMENT 1 -- two agents sharing the SAME template each receive ONLY their own business facts", async () => {
    const { safeFetch, state } = stubFetch({
      businessFactsByAgent: { [AGENT_A]: FACTS_A, [AGENT_B]: FACTS_B },
    });
    const provider = createInstructionsProvider({
      baseUrl: "https://paperclip.example",
      map: { [TEMPLATE]: PERSONA_AGENT }, // ONE shared persona, retained
      businessFactsMap: { [AGENT_A]: TEMPLATE, [AGENT_B]: TEMPLATE }, // BOTH share TEMPLATE
      readToken: () => "t",
      safeFetch,
      ttlMs: 60_000,
      timeoutMs: 5_000,
    });

    const a = await provider.resolve(TEMPLATE, COMPILED_IN, AGENT_A, AGENT_A);
    const b = await provider.resolve(TEMPLATE, COMPILED_IN, AGENT_B, AGENT_B);

    // Same shared template, same persona -- but each invocation's OWN facts only.
    expect(a.prompt).toContain(BUNDLE);
    expect(b.prompt).toContain(BUNDLE);
    expect(a.prompt).toContain(FACTS_A);
    expect(a.prompt).not.toContain(FACTS_B);
    expect(b.prompt).toContain(FACTS_B);
    expect(b.prompt).not.toContain(FACTS_A);
    expect(a.businessFactsAgentId).toBe(AGENT_A);
    expect(b.businessFactsAgentId).toBe(AGENT_B);

    // Structural, not coincidental: the business fetch itself was scoped to each
    // agent's own id.
    const businessUrls = state.urls.filter((u) => u.includes("path=BUSINESS.md"));
    expect(businessUrls).toContain(
      `https://paperclip.example/api/agents/${AGENT_A}/instructions-bundle/file?path=BUSINESS.md`,
    );
    expect(businessUrls).toContain(
      `https://paperclip.example/api/agents/${AGENT_B}/instructions-bundle/file?path=BUSINESS.md`,
    );
  });

  it("IMPERSONATION, UNIT LEVEL -- A's own proven credential cannot be used to claim B's identity, even though both are genuinely authorized for this template", async () => {
    const { safeFetch } = stubFetch({
      businessFactsByAgent: { [AGENT_A]: FACTS_A, [AGENT_B]: FACTS_B },
    });
    const provider = createInstructionsProvider({
      baseUrl: "https://paperclip.example",
      map: { [TEMPLATE]: PERSONA_AGENT },
      businessFactsMap: { [AGENT_A]: TEMPLATE, [AGENT_B]: TEMPLATE },
      readToken: () => "t",
      safeFetch,
      ttlMs: 60_000,
      timeoutMs: 5_000,
    });
    // claimedAgentId = B, but credentialAgentId (what A's real credential proves) = A.
    const r = await provider.resolve(TEMPLATE, COMPILED_IN, AGENT_B, AGENT_A);
    expect(r.businessFactsAgentId).toBeNull();
    expect(r.prompt).not.toContain(FACTS_B);
    expect(r.prompt).not.toContain(FACTS_A);
    expect(r.businessFactsRejectedAgentId).toBe(AGENT_B);
  });

  it("REQUIREMENT 2 & 4 -- an unauthorized claimed agent id gets no facts at all, never falls back to another tenant's", async () => {
    const { safeFetch } = stubFetch({
      businessFactsByAgent: { [AGENT_A]: FACTS_A, [AGENT_B]: FACTS_B },
    });
    const provider = createInstructionsProvider({
      baseUrl: "https://paperclip.example",
      map: { [TEMPLATE]: PERSONA_AGENT },
      businessFactsMap: { [AGENT_A]: TEMPLATE }, // ONLY AGENT_A is authorized
      readToken: () => "t",
      safeFetch,
      ttlMs: 60_000,
      timeoutMs: 5_000,
    });
    // A caller claims AGENT_B, which is real and has real facts, but is NOT in this
    // template's authorization table at all.
    const r = await provider.resolve(TEMPLATE, COMPILED_IN, AGENT_B);
    expect(r.prompt).not.toContain(FACTS_B);
    expect(r.prompt).not.toContain(FACTS_A); // and certainly not someone else's either
    expect(r.businessFactsAgentId).toBeNull();
    expect(r.prompt).toBe(BUNDLE); // persona-only, exactly the safe fallback
    // Observable: this was a REJECTED claim, not merely "nothing uploaded yet".
    expect(r.businessFactsRejectedAgentId).toBe(AGENT_B);
  });

  it("a claim with no authorization table entry at all is rejected the same way, and observably so", async () => {
    const { provider } = makeProvider(); // businessFactsMap: {} by default
    const r = await provider.resolve(TEMPLATE, COMPILED_IN, AGENT_A);
    expect(r.businessFactsAgentId).toBeNull();
    expect(r.businessFactsRejectedAgentId).toBe(AGENT_A);
  });

  it("REQUIREMENT 4 -- a caller claiming NO agent id at all gets no business facts, even when the template has authorized agents", async () => {
    const { safeFetch, state } = stubFetch({ businessFactsByAgent: { [AGENT_A]: FACTS_A } });
    const provider = createInstructionsProvider({
      baseUrl: "https://paperclip.example",
      map: { [TEMPLATE]: PERSONA_AGENT },
      businessFactsMap: { [AGENT_A]: TEMPLATE },
      readToken: () => "t",
      safeFetch,
      ttlMs: 60_000,
      timeoutMs: 5_000,
    });
    const r = await provider.resolve(TEMPLATE, COMPILED_IN, null);
    expect(r.businessFactsAgentId).toBeNull();
    expect(r.prompt).not.toContain(FACTS_A);
    // No business-facts URL is even attempted without a claimed identity.
    expect(state.urls.some((u) => u.includes("path=BUSINESS.md"))).toBe(false);
    // "no claim at all" is the routine case, NOT a rejected/suspicious one.
    expect(r.businessFactsRejectedAgentId).toBeNull();
  });

  it("SPOOFED / MISMATCHED IDENTITY -- a real, authorized agent id claimed under the WRONG template is rejected, not just relocated", async () => {
    // MISMATCHED_AGENT is genuinely authorized -- but for OTHER_TEMPLATE, not TEMPLATE.
    // A request that claims it while invoking TEMPLATE is exactly the forged/stale
    // claim this correction exists to catch.
    const { safeFetch, state } = stubFetch({
      businessFactsByAgent: { [MISMATCHED_AGENT]: "OTHER TENANT'S FACTS -- must never leak here" },
    });
    const provider = createInstructionsProvider({
      baseUrl: "https://paperclip.example",
      map: { [TEMPLATE]: PERSONA_AGENT },
      businessFactsMap: { [MISMATCHED_AGENT]: OTHER_TEMPLATE }, // authorized for a DIFFERENT template
      readToken: () => "t",
      safeFetch,
      ttlMs: 60_000,
      timeoutMs: 5_000,
    });
    const r = await provider.resolve(TEMPLATE, COMPILED_IN, MISMATCHED_AGENT);
    expect(r.businessFactsAgentId).toBeNull();
    expect(r.prompt).not.toContain("OTHER TENANT'S FACTS");
    expect(r.prompt).toBe(BUNDLE);
    // The mismatch is caught before any network call for that agent's facts is made.
    expect(state.urls.some((u) => u.includes(`/agents/${MISMATCHED_AGENT}/`) && u.includes("BUSINESS.md"))).toBe(
      false,
    );
    // Observable and distinguishable from "not authorized at all".
    expect(r.businessFactsRejectedAgentId).toBe(MISMATCHED_AGENT);
  });

  it("falls back cleanly to persona-only when the authorized agent has no BUSINESS.md yet -- absence is not a failure", async () => {
    const { provider } = makeProvider({ businessFactsMap: { [AGENT_A]: TEMPLATE } });
    const r = await provider.resolve(TEMPLATE, COMPILED_IN, AGENT_A); // default stub: 404s
    expect(r.source).toBe("paperclip");
    expect(r.prompt).toBe(BUNDLE);
    expect(r.failure).toBeNull();
    expect(r.businessFactsAgentId).toBeNull();
  });

  it("a BUSINESS.md fetch error never fails the reply -- fail-soft, unlike the persona fetch", async () => {
    const safeFetch = async (input: string | URL): Promise<Response> => {
      if (String(input).includes("path=BUSINESS.md")) throw new Error("business-facts egress blocked");
      return jsonResponse({ content: BUNDLE });
    };
    const provider = createInstructionsProvider({
      baseUrl: "https://paperclip.example",
      map: { [TEMPLATE]: PERSONA_AGENT },
      businessFactsMap: { [AGENT_A]: TEMPLATE },
      readToken: () => "t",
      safeFetch,
      ttlMs: 60_000,
      timeoutMs: 5_000,
    });
    const r = await provider.resolve(TEMPLATE, COMPILED_IN, AGENT_A);
    expect(r.source).toBe("paperclip");
    expect(r.prompt).toBe(BUNDLE);
    expect(r.failure).toBeNull();
    expect(r.businessFactsAgentId).toBeNull();
  });

  it("caches business facts per AGENT id, independent of the shared persona cache", async () => {
    const clock = { t: 1_000_000 };
    const { safeFetch, state } = stubFetch({
      businessFactsByAgent: { [AGENT_A]: FACTS_A, [AGENT_B]: FACTS_B },
    });
    const provider = createInstructionsProvider({
      baseUrl: "https://paperclip.example",
      map: { [TEMPLATE]: PERSONA_AGENT },
      businessFactsMap: { [AGENT_A]: TEMPLATE, [AGENT_B]: TEMPLATE },
      readToken: () => "t",
      safeFetch,
      ttlMs: 60_000,
      timeoutMs: 5_000,
      now: () => clock.t,
    });
    await provider.resolve(TEMPLATE, COMPILED_IN, AGENT_A, AGENT_A); // persona + A's facts: 2 calls
    await provider.resolve(TEMPLATE, COMPILED_IN, AGENT_B, AGENT_B); // persona cached, B's facts: 1 call
    expect(state.calls).toBe(3);

    clock.t += 30_000; // inside TTL
    const cachedA = await provider.resolve(TEMPLATE, COMPILED_IN, AGENT_A, AGENT_A);
    expect(cachedA.prompt).toContain(FACTS_A);
    expect(state.calls).toBe(3); // both persona and A's facts served from cache
  });
});

describe("the fail-closed prompt itself", () => {
  it("instructs the model to escalate rather than answer", () => {
    expect(FAIL_CLOSED_PROMPT).toMatch(/cannot look this up/i);
    expect(FAIL_CLOSED_PROMPT).toMatch(/passing the message to a colleague/i);
    expect(FAIL_CLOSED_PROMPT).toMatch(/Do not answer the question/i);
    expect(FAIL_CLOSED_PROMPT).toMatch(/must not guess/i);
  });
});
