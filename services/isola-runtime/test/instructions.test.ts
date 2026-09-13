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
const COMPILED_IN = "compiled-in prompt".padEnd(300, ".");
const BUNDLE = "EPIC opens Monday to Friday, 8:00am to 4:00pm.".padEnd(400, ".");

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A SafeFetch stub that counts calls, records headers, and can be told to fail. */
function stubFetch(behaviour: { body?: unknown; status?: number; throws?: boolean }) {
  const state = { calls: 0, urls: [] as string[], authHeaders: [] as string[], ...behaviour };
  const safeFetch = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    state.calls++;
    state.urls.push(String(input));
    const headers = new Headers(init?.headers);
    state.authHeaders.push(headers.get("Authorization") ?? "");
    if (state.throws) throw new Error("egress blocked");
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

  it("fetches the bundle and uses it as the system prompt", async () => {
    const { provider, state } = makeProvider();
    const r = await provider.resolve(TEMPLATE, COMPILED_IN);
    expect(r.source).toBe("paperclip");
    expect(r.prompt).toBe(BUNDLE);
    expect(r.failure).toBeNull();
    expect(state.calls).toBe(1);
    expect(state.urls[0]).toContain(`/api/agents/${AGENT}/instructions-bundle/file?path=AGENTS.md`);
  });

  it("serves from cache inside the TTL, then re-reads after it", async () => {
    const clock = { t: 1_000_000 };
    const { provider, state } = makeProvider({}, clock);
    await provider.resolve(TEMPLATE, COMPILED_IN);
    clock.t += 30_000;
    const cached = await provider.resolve(TEMPLATE, COMPILED_IN);
    expect(state.calls).toBe(1);
    expect(cached.cacheAgeMs).toBe(30_000);

    clock.t += 40_000; // now past the 60s TTL
    await provider.resolve(TEMPLATE, COMPILED_IN);
    expect(state.calls).toBe(2);
  });

  it("invalidate() forces the next reply to re-read Paperclip", async () => {
    const { provider, state } = makeProvider();
    await provider.resolve(TEMPLATE, COMPILED_IN);
    provider.invalidate();
    await provider.resolve(TEMPLATE, COMPILED_IN);
    expect(state.calls).toBe(2);
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
    const safeFetch = async (): Promise<Response> => {
      state.calls++;
      if (state.fail) throw new Error("paperclip down");
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

describe("resolve — exposure-aware readToken", () => {
  it("passes the caller's exposure through to readToken", async () => {
    const seen: (string | undefined)[] = [];
    const { safeFetch } = stubFetch({});
    const provider = createInstructionsProvider({
      baseUrl: "https://paperclip.example",
      map: { [TEMPLATE]: AGENT },
      readToken: (exposure) => {
        seen.push(exposure);
        return "whichever-token";
      },
      safeFetch,
      ttlMs: 60_000,
      timeoutMs: 5_000,
    });
    await provider.resolve(TEMPLATE, COMPILED_IN, "PUBLIC");
    expect(seen).toEqual(["PUBLIC"]);
  });

  it("passes undefined through when the caller supplies no exposure", async () => {
    const seen: (string | undefined)[] = [];
    const { safeFetch } = stubFetch({});
    const provider = createInstructionsProvider({
      baseUrl: "https://paperclip.example",
      map: { [TEMPLATE]: AGENT },
      readToken: (exposure) => {
        seen.push(exposure);
        return "whichever-token";
      },
      safeFetch,
      ttlMs: 60_000,
      timeoutMs: 5_000,
    });
    // Caller omits the third argument entirely — exercises the same call shape as
    // any pre-existing caller that has not been updated to pass exposure.
    await provider.resolve(TEMPLATE, COMPILED_IN);
    expect(seen).toEqual([undefined]);
  });

  it("sends the Bearer value readToken returns for the given exposure, not a fixed token", async () => {
    const { safeFetch, state } = stubFetch({});
    const provider = createInstructionsProvider({
      baseUrl: "https://paperclip.example",
      map: { [TEMPLATE]: AGENT },
      readToken: (exposure) => (exposure === "PUBLIC" ? "agent-key-value" : "board-token-value"),
      safeFetch,
      ttlMs: 60_000,
      timeoutMs: 5_000,
    });
    await provider.resolve(TEMPLATE, COMPILED_IN, "PUBLIC");
    expect(state.authHeaders).toEqual(["Bearer agent-key-value"]);
  });

  it("falls back to the board-token branch of readToken for an INTERNAL template", async () => {
    const { safeFetch, state } = stubFetch({});
    const provider = createInstructionsProvider({
      baseUrl: "https://paperclip.example",
      map: { [TEMPLATE]: AGENT },
      readToken: (exposure) => (exposure === "PUBLIC" ? "agent-key-value" : "board-token-value"),
      safeFetch,
      ttlMs: 60_000,
      timeoutMs: 5_000,
    });
    await provider.resolve(TEMPLATE, COMPILED_IN, "INTERNAL");
    expect(state.authHeaders).toEqual(["Bearer board-token-value"]);
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
