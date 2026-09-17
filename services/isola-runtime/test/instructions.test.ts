import { describe, expect, it } from "vitest";
import {
  FAIL_CLOSED_PROMPT,
  GRACE_MULTIPLIER,
  createInstructionsProvider,
  isUsablePrompt,
  parseInstructionsMap,
} from "../src/instructions.js";

const TEMPLATE = "isola-ai-sales-front-desk-agent@v1";
const AGENT = "fd2867d1-ee43-4032-a1cc-52eb3379a581";
const OTHER_TEMPLATE = "isola-internal-manager@v1";
const OTHER_AGENT = "a60770e9-e0e1-431a-aef5-f2158b963f61";
const COMPILED_IN = "compiled-in prompt".padEnd(300, ".");
const BUNDLE = "EPIC opens Monday to Friday, 8:00am to 4:00pm.".padEnd(400, ".");
const BUSINESS_FACTS = "EPIC Communications Inc. -- Roseau, Dominica. Services: internet, VoIP, IT.";
const OTHER_BUSINESS_FACTS = "A DIFFERENT tenant's own facts -- must never appear in AGENT's reply.";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * A SafeFetch stub that counts calls and can be told to fail. Distinguishes
 * AGENTS.md from BUSINESS.md by URL, since fetchEntry() now requests both --
 * BUSINESS.md defaults to 404 (no file uploaded yet) unless a test supplies one
 * per-agent via `businessFactsByAgent`, matching the real, expected common case.
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
    map: { [TEMPLATE]: AGENT },
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
    expect(parseInstructionsMap(`{"${TEMPLATE}":"${AGENT}"}`)).toEqual({ [TEMPLATE]: AGENT });
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
});

describe("isUsablePrompt", () => {
  it("rejects an empty or trivially short bundle", () => {
    expect(isUsablePrompt("")).toBe(false);
    expect(isUsablePrompt("hi")).toBe(false);
    expect(isUsablePrompt(null)).toBe(false);
    expect(isUsablePrompt(BUNDLE)).toBe(true);
  });
});

describe("resolve", () => {
  it("keeps the compiled-in prompt for a template with no Paperclip binding", async () => {
    const { provider, state } = makeProvider({ map: {} });
    const r = await provider.resolve(TEMPLATE, COMPILED_IN);
    expect(r.source).toBe("compiled_in");
    expect(r.prompt).toBe(COMPILED_IN);
    expect(state.calls).toBe(0);
  });

  it("fetches the bundle and uses it as the system prompt (no BUSINESS.md configured -- persona only)", async () => {
    const { provider, state } = makeProvider();
    const r = await provider.resolve(TEMPLATE, COMPILED_IN);
    expect(r.source).toBe("paperclip");
    expect(r.prompt).toBe(BUNDLE);
    expect(r.failure).toBeNull();
    // Two fetches per resolution now: AGENTS.md (persona) and BUSINESS.md (facts,
    // 404 by default in this stub -- confirmed a real attempt is made, not skipped).
    expect(state.calls).toBe(2);
    expect(state.urls[0]).toContain(`/api/agents/${AGENT}/instructions-bundle/file?path=AGENTS.md`);
    expect(state.urls[1]).toContain(`/api/agents/${AGENT}/instructions-bundle/file?path=BUSINESS.md`);
  });

  it("serves from cache inside the TTL, then re-reads after it", async () => {
    const clock = { t: 1_000_000 };
    const { provider, state } = makeProvider({}, clock);
    await provider.resolve(TEMPLATE, COMPILED_IN);
    clock.t += 30_000;
    const cached = await provider.resolve(TEMPLATE, COMPILED_IN);
    expect(state.calls).toBe(2); // one AGENTS.md + one BUSINESS.md fetch, then cached
    expect(cached.cacheAgeMs).toBe(30_000);

    clock.t += 40_000; // now past the 60s TTL
    await provider.resolve(TEMPLATE, COMPILED_IN);
    expect(state.calls).toBe(4); // re-fetches both on cache expiry
  });

  it("invalidate() forces the next reply to re-read Paperclip", async () => {
    const { provider, state } = makeProvider();
    await provider.resolve(TEMPLATE, COMPILED_IN);
    provider.invalidate();
    await provider.resolve(TEMPLATE, COMPILED_IN);
    expect(state.calls).toBe(4);
  });

  it("FAILS CLOSED when Paperclip cannot be read and nothing is cached", async () => {
    const { safeFetch } = stubFetch({ throws: true });
    const provider = createInstructionsProvider({
      baseUrl: "https://paperclip.example",
      map: { [TEMPLATE]: AGENT },
      readToken: () => "t",
      safeFetch,
      ttlMs: 60_000,
      timeoutMs: 5_000,
    });
    const r = await provider.resolve(TEMPLATE, COMPILED_IN);
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
        map: { [TEMPLATE]: AGENT },
        readToken: () => "t",
        safeFetch,
        ttlMs: 60_000,
        timeoutMs: 5_000,
      });
      const r = await provider.resolve(TEMPLATE, COMPILED_IN);
      expect(r.source).toBe("fail_closed");
    }
  });

  it("serves a stale copy through a brief outage, but not an unbounded one", async () => {
    const clock = { t: 1_000_000 };
    const state = { fail: false, calls: 0 };
    const safeFetch = async (input: string | URL): Promise<Response> => {
      state.calls++;
      if (state.fail) throw new Error("paperclip down");
      if (String(input).includes("path=BUSINESS.md")) return jsonResponse({ error: "not found" }, 404);
      return jsonResponse({ content: BUNDLE });
    };
    const provider = createInstructionsProvider({
      baseUrl: "https://paperclip.example",
      map: { [TEMPLATE]: AGENT },
      readToken: () => "t",
      safeFetch,
      ttlMs: 60_000,
      timeoutMs: 5_000,
      now: () => clock.t,
    });
    await provider.resolve(TEMPLATE, COMPILED_IN);
    state.fail = true;

    clock.t += 120_000; // past TTL, well inside grace
    const stale = await provider.resolve(TEMPLATE, COMPILED_IN);
    expect(stale.source).toBe("paperclip");
    expect(stale.prompt).toBe(BUNDLE);
    expect(stale.failure).toContain("paperclip down");

    clock.t += 60_000 * GRACE_MULTIPLIER; // now beyond the grace window
    const gone = await provider.resolve(TEMPLATE, COMPILED_IN);
    expect(gone.source).toBe("fail_closed");
  });
});

describe("business-facts connection (the previously-missing per-tenant knowledge link)", () => {
  it("appends BUSINESS.md content to the persona when the configured agent has one uploaded", async () => {
    const { safeFetch, state } = stubFetch({ businessFactsByAgent: { [AGENT]: BUSINESS_FACTS } });
    const provider = createInstructionsProvider({
      baseUrl: "https://paperclip.example",
      map: { [TEMPLATE]: AGENT },
      readToken: () => "t",
      safeFetch,
      ttlMs: 60_000,
      timeoutMs: 5_000,
    });
    const r = await provider.resolve(TEMPLATE, COMPILED_IN);
    expect(r.source).toBe("paperclip");
    expect(r.prompt).toContain(BUNDLE);
    expect(r.prompt).toContain(BUSINESS_FACTS);
    expect(state.calls).toBe(2);
  });

  it("falls back cleanly to persona-only when no BUSINESS.md exists yet -- absence is not a failure", async () => {
    const { provider } = makeProvider(); // default stub: BUSINESS.md 404s
    const r = await provider.resolve(TEMPLATE, COMPILED_IN);
    expect(r.source).toBe("paperclip"); // NOT fail_closed -- missing business facts is normal
    expect(r.prompt).toBe(BUNDLE); // exactly the persona, nothing appended
    expect(r.failure).toBeNull();
  });

  it("a BUSINESS.md fetch error never fails the reply -- fail-soft, unlike the persona fetch", async () => {
    const safeFetch = async (input: string | URL): Promise<Response> => {
      if (String(input).includes("path=BUSINESS.md")) throw new Error("business-facts egress blocked");
      return jsonResponse({ content: BUNDLE });
    };
    const provider = createInstructionsProvider({
      baseUrl: "https://paperclip.example",
      map: { [TEMPLATE]: AGENT },
      readToken: () => "t",
      safeFetch,
      ttlMs: 60_000,
      timeoutMs: 5_000,
    });
    const r = await provider.resolve(TEMPLATE, COMPILED_IN);
    expect(r.source).toBe("paperclip");
    expect(r.prompt).toBe(BUNDLE);
    expect(r.failure).toBeNull();
  });

  it("TENANT ISOLATION -- two different templates mapped to two different agents each get ONLY their own agent's business facts, never the other's", async () => {
    const { safeFetch, state } = stubFetch({
      businessFactsByAgent: { [AGENT]: BUSINESS_FACTS, [OTHER_AGENT]: OTHER_BUSINESS_FACTS },
    });
    const provider = createInstructionsProvider({
      baseUrl: "https://paperclip.example",
      map: { [TEMPLATE]: AGENT, [OTHER_TEMPLATE]: OTHER_AGENT },
      readToken: () => "t",
      safeFetch,
      ttlMs: 60_000,
      timeoutMs: 5_000,
    });
    const a = await provider.resolve(TEMPLATE, COMPILED_IN);
    const b = await provider.resolve(OTHER_TEMPLATE, COMPILED_IN);

    expect(a.prompt).toContain(BUSINESS_FACTS);
    expect(a.prompt).not.toContain(OTHER_BUSINESS_FACTS);
    expect(b.prompt).toContain(OTHER_BUSINESS_FACTS);
    expect(b.prompt).not.toContain(BUSINESS_FACTS);

    // The fetch itself was scoped to each agent's own id -- proves isolation is
    // structural (a different URL per agent), not merely coincidental in this fixture.
    const businessUrls = state.urls.filter((u) => u.includes("path=BUSINESS.md"));
    expect(businessUrls).toContain(`https://paperclip.example/api/agents/${AGENT}/instructions-bundle/file?path=BUSINESS.md`);
    expect(businessUrls).toContain(`https://paperclip.example/api/agents/${OTHER_AGENT}/instructions-bundle/file?path=BUSINESS.md`);
  });

  it("TENANT ISOLATION CONTROL -- the caller cannot redirect which agent's facts are fetched; only the config map decides", async () => {
    // Proves the fetch key comes from `map[templateId]` (configuration), never from
    // anything the caller of resolve() supplies -- resolve() takes no agentId
    // parameter at all, so there is no request-suppliable channel to abuse here.
    const { safeFetch } = stubFetch({ businessFactsByAgent: { [OTHER_AGENT]: OTHER_BUSINESS_FACTS } });
    const provider = createInstructionsProvider({
      baseUrl: "https://paperclip.example",
      map: { [TEMPLATE]: AGENT }, // TEMPLATE maps to AGENT, never to OTHER_AGENT
      readToken: () => "t",
      safeFetch,
      ttlMs: 60_000,
      timeoutMs: 5_000,
    });
    const r = await provider.resolve(TEMPLATE, COMPILED_IN);
    expect(r.prompt).not.toContain(OTHER_BUSINESS_FACTS);
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
