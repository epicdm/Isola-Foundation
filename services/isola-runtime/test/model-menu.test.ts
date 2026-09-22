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

import { createAgnoClient } from "../src/agno-client.js";
import { createOpenAiCompatibleClient } from "../src/model.js";
import { allTemplates, findTemplate } from "../src/registry.js";

/**
 * Mirrors app.ts's selection rule exactly, INCLUDING the modelClientKind
 * check that must run BEFORE the "no override" guarantee — an agno template
 * must never fall through to the default client just because its env-sourced
 * modelBaseUrl happens to be unset in this environment (see the agno-branded
 * describe block below). Kept here rather than importing the whole server so
 * the property can be exercised in isolation; the shape is asserted against
 * the real registry, so a template drifting from it fails.
 */
function makeSelector(safeFetch: typeof fetch, defaultBase: string, defaultKey: string | null) {
  const base = createOpenAiCompatibleClient({
    baseUrl: defaultBase,
    apiKey: defaultKey,
    safeFetch: safeFetch as never,
  });
  const cache = new Map<string, unknown>();
  return {
    base,
    pick(templateId: string) {
      const t = findTemplate(templateId)!;
      if (t.modelClientKind === "agno") {
        const override = t.modelBaseUrl;
        if (override === undefined || override.trim().length === 0) {
          throw new Error(`template ${t.id} requires an agno modelBaseUrl but none is configured`);
        }
        const key = `agno:${override}`;
        const hit = cache.get(key);
        if (hit) return hit;
        const made = createAgnoClient({
          baseUrl: override,
          apiKey: "test-key",
          safeFetch: safeFetch as never,
        });
        cache.set(key, made);
        return made;
      }
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
    // Filtered on modelClientKind too: the agno template's modelBaseUrl is
    // ALSO undefined in this environment (its env var is unset here), but it
    // does not inherit — see the dedicated describe block below for why.
    for (const t of allTemplates().filter(
      (x) => x.modelBaseUrl === undefined && x.modelClientKind === undefined,
    )) {
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

describe("the agno-brained template never silently inherits the default client", () => {
  /**
   * The exact trap the "6737 and 3742 are untouched" test above guards
   * against, from the OTHER direction: a template that DOES declare a brain
   * must not fall back to it just because its own configuration is
   * incomplete. `t.modelBaseUrl` is undefined here (AGNO_WORKER_BASE_URL is
   * unset in this test environment) — the OLD selector shape (before this
   * file's modelClientKind check existed) would have read that as "no
   * override" and silently sent the run to the default DeepSeek client.
   */
  it("an unconfigured agno base URL throws rather than falling back to the default", () => {
    const { f } = recordingFetch();
    const sel = makeSelector(f as never, "https://api.deepseek.com", "k");
    expect(() => sel.pick("isola-agno-proof-worker@v1")).toThrow(
      /requires an agno modelBaseUrl/,
    );
  });

  it("with a base URL configured, it goes to Agno's own endpoint, not DeepSeek's", async () => {
    const template = findTemplate("isola-agno-proof-worker@v1")!;
    const configuredBaseUrl = "http://isola-agno-s1-agentos:3000";
    // Exercises the client construction directly (mirrors what
    // clientForTemplate() does once AGNO_WORKER_BASE_URL is set) rather than
    // reaching into the registry module's own env-read state.
    const client = createAgnoClient({
      baseUrl: configuredBaseUrl,
      apiKey: "test-key",
      safeFetch: (async (url: string, init: RequestInit) => {
        expect(url).toBe(`${configuredBaseUrl}/agents/${template.model}/runs`);
        expect((init.headers as Record<string, string>)?.["authorization"]).toBe(
          "Bearer test-key",
        );
        expect((init.headers as Record<string, string>)?.["content-type"]).toBe(
          "application/x-www-form-urlencoded",
        );
        return new Response(
          JSON.stringify({ status: "COMPLETED", content: "ok", run_id: "r1" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as never,
    });
    const res = await client.complete({
      model: template.model,
      timeoutMs: 5000,
      messages: [{ role: "user", content: "hi" }],
      sessionId: "session-1",
      userId: "user-1",
    });
    expect(res.content).toBe("ok");
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
