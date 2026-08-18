/**
 * WHICH BRAIN SERVES WHICH TEMPLATE.
 *
 * The runtime menu used to bind only at the Paperclip layer: anything reachable
 * over WhatsApp got this process's single model endpoint, whatever Paperclip
 * said the agent's runtime was. On 2026-08-17 the 9043 internal line answered in
 * the CUSTOMER front desk's voice, on DeepSeek, while carrying the manager's
 * agent id — fluent, plausible, and the wrong runtime.
 *
 * THE TEST THAT MATTERS IS THE ONE ABOUT TEMPLATES THAT CHANGED NOTHING.
 * "6737 and 3742 are untouched" is not a hope about a diff; it is a property,
 * and it is asserted here at the level that decides it — which client object is
 * used, and what it sends.
 */
import { describe, expect, it, vi } from "vitest";

import { createOpenAiCompatibleClient } from "../src/model.js";
import { allTemplates, findTemplate } from "../src/registry.js";

/**
 * Mirrors app.ts's selection rule exactly. Kept here rather than importing the
 * whole server so the property can be exercised in isolation; the shape is
 * asserted against the real registry, so a template drifting from it fails.
 */
function makeSelector(safeFetch: typeof fetch, defaultBase: string, defaultKey: string | null) {
  const base = createOpenAiCompatibleClient({
    baseUrl: defaultBase,
    apiKey: defaultKey,
    safeFetch: safeFetch as never,
  });
  const cache = new Map<string, ReturnType<typeof createOpenAiCompatibleClient>>();
  return {
    base,
    pick(templateId: string) {
      const t = findTemplate(templateId)!;
      const override = t.modelBaseUrl;
      if (override === undefined) return base; // <-- THE GUARANTEE
      const hit = cache.get(override);
      if (hit) return hit;
      const made = createOpenAiCompatibleClient({
        baseUrl: override,
        apiKey: "test-key",
        safeFetch: safeFetch as never,
      });
      cache.set(override, made);
      return made;
    },
  };
}

function recordingFetch() {
  const calls: Array<{ url: string; auth: string | undefined }> = [];
  const f = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, auth: (init.headers as Record<string, string>)?.["authorization"] });
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  });
  return { f, calls };
}

const ask = (c: { complete: (r: never) => Promise<unknown> }) =>
  c.complete({ model: "m", timeoutMs: 5000, messages: [{ role: "user", content: "hi" }] } as never);

describe("ABSENT OVERRIDE = BYTE-IDENTICAL CURRENT BEHAVIOUR", () => {
  it("a template with no brain declared returns THE SAME client object", () => {
    const { f } = recordingFetch();
    const sel = makeSelector(f as never, "https://api.deepseek.com", "k");
    // Object identity, not equality: nothing new is constructed for these.
    expect(sel.pick("isola-ai-sales-front-desk-agent@v1")).toBe(sel.base);
    expect(sel.pick("epic-staff-operations-coordinator@v1")).toBe(sel.base);
  });

  it("and it sends to the SAME endpoint with the SAME credential as before", async () => {
    const { f, calls } = recordingFetch();
    const sel = makeSelector(f as never, "https://api.deepseek.com", "default-key");
    await ask(sel.pick("isola-ai-sales-front-desk-agent@v1") as never);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url, "6737's endpoint must not move").toBe(
      "https://api.deepseek.com/v1/chat/completions",
    );
    expect(calls[0]!.auth).toBe("Bearer default-key");
  });

  it("EVERY inherited template behaves this way — not just the two named above", async () => {
    // A template added later that forgets to declare a brain must also inherit,
    // rather than this test passing because it only checked the ones it knew.
    for (const t of allTemplates().filter((x) => x.modelBaseUrl === undefined)) {
      const { f, calls } = recordingFetch();
      const sel = makeSelector(f as never, "https://api.deepseek.com", "default-key");
      expect(sel.pick(t.id), t.id).toBe(sel.base);
      await ask(sel.pick(t.id) as never);
      expect(calls[0]!.url, t.id).toBe("https://api.deepseek.com/v1/chat/completions");
    }
  });
});

describe("a declared brain is actually used", () => {
  it("the internal manager goes to the Hermes tunnel, not to DeepSeek", async () => {
    const { f, calls } = recordingFetch();
    const sel = makeSelector(f as never, "https://api.deepseek.com", "default-key");
    const client = sel.pick("isola-internal-manager@v1");
    expect(client, "must NOT be the default client").not.toBe(sel.base);
    await ask(client as never);
    expect(calls[0]!.url).toBe("http://hermes-tunnel:8646/v1/chat/completions");
    expect(calls[0]!.auth, "and not the DeepSeek credential").toBe("Bearer test-key");
  });

  it("clients are cached per endpoint, so a template does not build one per request", () => {
    const { f } = recordingFetch();
    const sel = makeSelector(f as never, "https://api.deepseek.com", "k");
    expect(sel.pick("isola-internal-manager@v1")).toBe(sel.pick("isola-internal-manager@v1"));
  });
});

describe("the declared host must be reachable through the GUARD, not around it", () => {
  /**
   * A raw fetch() from inside the container reached the Hermes tunnel and
   * returned 200, while the real call path — which goes through safeFetch — would
   * have been refused: the runtime's egress allowlist was ["api.deepseek.com"].
   * A GREEN PROBE AGAINST THE WRONG CODE PATH IS NOT REACHABILITY.
   */
  it("a blocked egress surfaces as an error rather than a silent fallback", async () => {
    const blocked = vi.fn(async () => {
      throw new Error("EgressBlocked: host not on allowlist");
    });
    const sel = makeSelector(blocked as never, "https://api.deepseek.com", "k");
    await expect(ask(sel.pick("isola-internal-manager@v1") as never)).rejects.toBeTruthy();
    // The point: it FAILS. It does not quietly answer from the customer brain.
  });
});
