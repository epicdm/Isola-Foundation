/**
 * Provider status (src/provider-status.ts) and GET /v1/provider-status.
 *
 * Every provider request here goes through the REAL createSafeFetch with a fake
 * transport underneath, so these tests exercise the egress guard as well as the
 * parser: nothing reaches the network, and nothing bypasses the allowlist.
 *
 * Every absence assertion ("the key is not in the body") is paired with a
 * positive control in the same test proving the key WAS in play (it was sent as
 * the provider's bearer) — otherwise a check that never touched the key would
 * pass vacuously.
 */
import { afterEach, describe, expect, it } from "vitest";

import { bootErrors, bootWarnings } from "../src/config.js";
import { createSafeFetch, type FetchLike } from "../src/egress.js";
import {
  buildPushUrl,
  createProviderStatusChecker,
  pushMessage,
  pushProviderStatus,
  startProviderStatusMonitor,
  type ProviderStatusResult,
} from "../src/provider-status.js";
import {
  CapturingLogger,
  INTERNAL_SECRET,
  PUBLIC_SECRET,
  StubModelClient,
  envConfig,
  get,
  placeholder,
  startServer,
  type TestServer,
} from "./harness.js";

const MODEL_KEY = placeholder("model");
const PUSH_TOKEN = placeholder("kuma-push-token");
const PUSH_URL = `https://kuma.example.test/api/push/${PUSH_TOKEN}?status=up&msg=OK&ping=`;

interface Seen {
  url: string;
  authorization: string | null;
  method: string;
}

/** A fake transport. Records each request and replies from `reply`. */
function fakeTransport(reply: (url: string) => Response | Promise<Response>): {
  transport: FetchLike;
  seen: Seen[];
} {
  const seen: Seen[] = [];
  const transport: FetchLike = async (input, init) => {
    const url = typeof input === "string" ? input : input.toString();
    const headers = new Headers(init?.headers);
    seen.push({
      url,
      authorization: headers.get("authorization"),
      method: init?.method ?? "GET",
    });
    return reply(url);
  };
  return { transport, seen };
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const AVAILABLE_BODY = {
  is_available: true,
  balance_infos: [
    { currency: "USD", total_balance: "44.79", granted_balance: "0.00", topped_up_balance: "44.79" },
  ],
};

function checkerFor(
  reply: (url: string) => Response | Promise<Response>,
  opts: { apiKey?: string | null; allowlist?: string[]; now?: () => number } = {},
) {
  const { transport, seen } = fakeTransport(reply);
  const logs = new CapturingLogger();
  const checker = createProviderStatusChecker({
    provider: "deepseek",
    modelBaseUrl: "https://api.deepseek.com",
    apiKey: opts.apiKey === undefined ? MODEL_KEY : opts.apiKey,
    safeFetch: createSafeFetch({
      allowlist: opts.allowlist ?? ["api.deepseek.com"],
      transport,
    }),
    logger: logs.logger,
    now: opts.now ?? (() => Date.parse("2026-09-23T12:00:00Z")),
  });
  return { checker, seen, logs };
}

describe("provider status: parsing the documented balance API", () => {
  it("available with a balance -> ok, sanitized, via GET <origin>/user/balance with the model key", async () => {
    const { checker, seen, logs } = checkerFor(() => json(200, AVAILABLE_BODY));
    const result = await checker.check();

    expect(result).toEqual({
      provider: "deepseek",
      checkedAt: "2026-09-23T12:00:00.000Z",
      available: true,
      balances: [{ currency: "USD", total: "44.79" }],
      status: "ok",
      httpStatus: 200,
    });
    // Positive control: the key really was used, as the provider bearer.
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe("https://api.deepseek.com/user/balance");
    expect(seen[0]!.method).toBe("GET");
    expect(seen[0]!.authorization).toBe(`Bearer ${MODEL_KEY}`);
    // ...and it is absent from the result and from every log line.
    expect(JSON.stringify(result)).not.toContain(MODEL_KEY);
    expect(logs.raw.join("\n")).not.toContain(MODEL_KEY);
    // Granted / topped-up split is not part of the result.
    expect(JSON.stringify(result)).not.toContain("topped_up");

    const line = logs.lines.find((l) => l["event"] === "provider_status");
    expect(line).toMatchObject({ outcome: "ok", available: true, balances: ["USD 44.79"] });
  });

  it("a base URL ending in /v1 still targets the origin", async () => {
    const { transport, seen } = fakeTransport(() => json(200, AVAILABLE_BODY));
    const checker = createProviderStatusChecker({
      provider: "deepseek",
      modelBaseUrl: "https://api.deepseek.com/v1",
      apiKey: MODEL_KEY,
      safeFetch: createSafeFetch({ allowlist: ["api.deepseek.com"], transport }),
      logger: new CapturingLogger().logger,
      now: () => 0,
    });
    await checker.check();
    expect(seen[0]!.url).toBe("https://api.deepseek.com/user/balance");
  });

  it("is_available=false -> unavailable, available:false", async () => {
    const { checker } = checkerFor(() =>
      json(200, { is_available: false, balance_infos: [{ currency: "USD", total_balance: "0.00" }] }),
    );
    const result = await checker.check();
    expect(result.status).toBe("unavailable");
    expect(result.available).toBe(false);
    expect(result.balances).toEqual([{ currency: "USD", total: "0.00" }]);
    expect(result.failureCategory).toBe("is_available_false");
  });

  it("provider HTTP 402 -> unavailable, available:false, httpStatus 402, body never echoed", async () => {
    const { checker, logs } = checkerFor(
      () => new Response(`{"error":{"message":"Insufficient Balance ${MODEL_KEY}"}}`, { status: 402 }),
    );
    const result = await checker.check();
    expect(result).toMatchObject({
      status: "unavailable",
      available: false,
      httpStatus: 402,
      failureCategory: "insufficient_balance",
      balances: [],
    });
    expect(JSON.stringify(result)).not.toContain("Insufficient");
    expect(logs.raw.join("\n")).not.toContain(MODEL_KEY);
  });

  it("a non-JSON body -> check_failed, NEVER available:true", async () => {
    const { checker } = checkerFor(
      () => new Response("<html>gateway says hi</html>", { status: 200 }),
    );
    const result = await checker.check();
    expect(result.status).toBe("check_failed");
    expect(result.available).toBeNull();
    expect(result.failureCategory).toBe("non_json_body");
  });

  const unexpectedShapes: Array<[string, unknown]> = [
    ["is_available as a string", { is_available: "true", balance_infos: [] }],
    ["is_available missing", { balance_infos: [] }],
    ["balance_infos missing", { is_available: true }],
    ["a JSON array", [AVAILABLE_BODY]],
    ["JSON null", null],
    ["a non-numeric total", { is_available: true, balance_infos: [{ currency: "USD", total_balance: "lots" }] }],
    ["a bogus currency", { is_available: true, balance_infos: [{ currency: "<script>", total_balance: "1.00" }] }],
  ];
  for (const [label, body] of unexpectedShapes) {
    it(`unexpected shape (${label}) -> check_failed, NEVER available:true`, async () => {
      const { checker } = checkerFor(() => json(200, body));
      const result = await checker.check();
      expect(result.status).toBe("check_failed");
      expect(result.available).toBeNull();
      expect(result.failureCategory).toBe("unexpected_shape");
      expect(result.balances).toEqual([]);
    });
  }

  it("other provider HTTP errors -> check_failed with the status and a category", async () => {
    const { checker } = checkerFor(() => new Response("nope", { status: 401 }));
    const result = await checker.check();
    expect(result).toMatchObject({
      status: "check_failed",
      available: null,
      httpStatus: 401,
      failureCategory: "provider_auth_rejected",
    });
  });

  it("network error -> check_failed; the transport's message (which carries a URL) is not logged", async () => {
    const { checker, logs } = checkerFor(() => {
      throw new TypeError(`fetch failed for https://api.deepseek.com/user/balance?k=${MODEL_KEY}`);
    });
    const result = await checker.check();
    expect(result).toMatchObject({ status: "check_failed", available: null, failureCategory: "network_error" });
    expect(logs.raw.join("\n")).not.toContain(MODEL_KEY);
    expect(logs.raw.join("\n")).not.toContain("fetch failed");
  });

  it("goes through the egress guard: a host not on the allowlist is refused before the transport", async () => {
    const { checker, seen } = checkerFor(() => json(200, AVAILABLE_BODY), {
      allowlist: ["paperclip.example.test"],
    });
    const result = await checker.check();
    expect(result).toMatchObject({ status: "check_failed", failureCategory: "egress_blocked" });
    expect(seen).toHaveLength(0);
  });

  it("no MODEL_API_KEY -> not_configured, and the provider is never called", async () => {
    const { checker, seen } = checkerFor(() => json(200, AVAILABLE_BODY), { apiKey: null });
    const result = await checker.check();
    expect(result.status).toBe("not_configured");
    expect(result.available).toBeNull();
    expect(seen).toHaveLength(0);
  });
});

describe("provider status: cache", () => {
  it("two checks within 60s -> one provider request; after 60s -> a fresh one", async () => {
    let clock = 1_000_000;
    const { checker, seen } = checkerFor(() => json(200, AVAILABLE_BODY), { now: () => clock });
    await checker.check();
    clock += 59_999;
    await checker.check();
    expect(seen).toHaveLength(1);
    clock += 1;
    await checker.check();
    expect(seen).toHaveLength(2);
  });

  it("concurrent checks share one in-flight request", async () => {
    const { checker, seen } = checkerFor(() => json(200, AVAILABLE_BODY));
    const [a, b] = await Promise.all([checker.check(), checker.check()]);
    expect(seen).toHaveLength(1);
    expect(a).toEqual(b);
  });

  it("a failed check is cached too, so a failing provider is not hammered", async () => {
    const clock = 5_000_000;
    const { checker, seen } = checkerFor(() => new Response("x", { status: 500 }), { now: () => clock });
    await checker.check();
    await checker.check();
    expect(seen).toHaveLength(1);
  });
});

describe("GET /v1/provider-status", () => {
  let server: TestServer | null = null;
  afterEach(async () => {
    await server?.close();
    server = null;
  });

  async function start(env: Record<string, string | undefined> = {}) {
    const { transport, seen } = fakeTransport(() => json(200, AVAILABLE_BODY));
    const config = envConfig(env);
    const logs = new CapturingLogger();
    server = await startServer({
      config,
      logger: logs.logger,
      modelClient: StubModelClient.returning("unused"),
      safeFetch: createSafeFetch({ allowlist: config.egressAllowlist, transport }),
    });
    return { url: server.url, seen, logs };
  }

  it("401 without a bearer; 200 with the INTERNAL bearer (control: same request, credentials added)", async () => {
    const { url, seen, logs } = await start();

    const anonymous = await get(url, "/v1/provider-status");
    expect(anonymous.status).toBe(401);
    expect(anonymous.json["outcome"]).toBe("unauthorized");
    expect(seen).toHaveLength(0);

    const wrong = await get(url, "/v1/provider-status", placeholder("wrong"));
    expect(wrong.status).toBe(401);

    const authed = await get(url, "/v1/provider-status", INTERNAL_SECRET);
    expect(authed.status).toBe(200);
    expect(authed.json).toMatchObject({
      ok: true,
      provider: "deepseek",
      status: "ok",
      available: true,
      balances: [{ currency: "USD", total: "44.79" }],
    });
    // Positive control: the model key really was sent to the provider...
    expect(seen).toHaveLength(1);
    expect(seen[0]!.authorization).toBe(`Bearer ${MODEL_KEY}`);
    // ...and appears in neither the response nor any log line.
    expect(authed.text).not.toContain(MODEL_KEY);
    expect(logs.raw.join("\n")).not.toContain(MODEL_KEY);
  });

  it("the PUBLIC credential is refused with 403 — operator/internal only", async () => {
    const { url, seen } = await start();
    const res = await get(url, "/v1/provider-status", PUBLIC_SECRET);
    expect(res.status).toBe(403);
    expect(res.json["outcome"]).toBe("exposure_mismatch");
    expect(seen).toHaveLength(0);
    // Control: the same PUBLIC bearer is a valid credential for /v1/templates.
    const templates = await get(url, "/v1/templates", PUBLIC_SECRET);
    expect(templates.status).toBe(200);
  });

  it("no runtime credential configured -> same status as /v1/templates (503)", async () => {
    const { url } = await start({ RUNTIME_SECRET_INTERNAL: undefined, RUNTIME_SECRET_PUBLIC: undefined });
    const status = await get(url, "/v1/provider-status", INTERNAL_SECRET);
    const templates = await get(url, "/v1/templates", INTERNAL_SECRET);
    expect(status.status).toBe(503);
    expect(status.status).toBe(templates.status);
    expect(status.json["outcome"]).toBe(templates.json["outcome"]);
  });

  it("MODEL_API_KEY unset -> 200 with status not_configured", async () => {
    const { url, seen } = await start({ MODEL_API_KEY: undefined });
    const res = await get(url, "/v1/provider-status", INTERNAL_SECRET);
    expect(res.status).toBe(200);
    expect(res.json["status"]).toBe("not_configured");
    expect(seen).toHaveLength(0);
  });
});

describe("monitoring push (Uptime Kuma)", () => {
  const OK: ProviderStatusResult = {
    provider: "deepseek",
    checkedAt: "2026-09-23T12:00:00.000Z",
    available: true,
    balances: [{ currency: "USD", total: "44.79" }],
    status: "ok",
    httpStatus: 200,
  };
  const DOWN_402: ProviderStatusResult = {
    provider: "deepseek",
    checkedAt: "2026-09-23T12:00:00.000Z",
    available: false,
    balances: [],
    status: "unavailable",
    httpStatus: 402,
    failureCategory: "insufficient_balance",
  };
  const DOWN_FLAG: ProviderStatusResult = {
    ...OK,
    available: false,
    status: "unavailable",
    failureCategory: "is_available_false",
    balances: [{ currency: "USD", total: "0.00" }],
  };
  const FAILED: ProviderStatusResult = {
    provider: "deepseek",
    checkedAt: "2026-09-23T12:00:00.000Z",
    available: null,
    balances: [],
    status: "check_failed",
    failureCategory: "network_error",
  };

  it("messages are short human sentences", () => {
    expect(pushMessage(OK)).toBe("DeepSeek available, balance USD 44.79");
    expect(pushMessage(DOWN_402)).toBe("DeepSeek UNAVAILABLE (402)");
    expect(pushMessage(DOWN_FLAG)).toBe("DeepSeek UNAVAILABLE (is_available=false), balance USD 0.00");
    expect(pushMessage(FAILED)).toBe("DeepSeek status CHECK FAILED (network_error)");
  });

  it("builds status/msg on the configured URL and drops ping", () => {
    const up = new URL(buildPushUrl(PUSH_URL, OK)!);
    expect(up.searchParams.get("status")).toBe("up");
    expect(up.searchParams.get("msg")).toBe("DeepSeek available, balance USD 44.79");
    expect(up.searchParams.has("ping")).toBe(false);
    expect(up.pathname).toBe(`/api/push/${PUSH_TOKEN}`);
    // Anything that is not positively available is down.
    for (const r of [DOWN_402, DOWN_FLAG, FAILED]) {
      expect(new URL(buildPushUrl(PUSH_URL, r)!).searchParams.get("status")).toBe("down");
    }
  });

  it("pushes up/down through the egress guard and logs only the host, never the token path", async () => {
    const { transport, seen } = fakeTransport(() => new Response('{"ok":true}', { status: 200 }));
    const logs = new CapturingLogger();
    const safeFetch = createSafeFetch({ allowlist: ["kuma.example.test"], transport });

    expect(await pushProviderStatus(OK, { pushUrl: PUSH_URL, safeFetch, logger: logs.logger })).toBe(true);
    expect(await pushProviderStatus(DOWN_402, { pushUrl: PUSH_URL, safeFetch, logger: logs.logger })).toBe(true);

    // Positive control: the token really was in the request that was sent.
    expect(seen).toHaveLength(2);
    expect(seen[0]!.url).toContain(PUSH_TOKEN);
    expect(new URL(seen[0]!.url).searchParams.get("status")).toBe("up");
    expect(new URL(seen[1]!.url).searchParams.get("status")).toBe("down");
    expect(new URL(seen[1]!.url).searchParams.get("msg")).toBe("DeepSeek UNAVAILABLE (402)");

    const all = logs.raw.join("\n");
    expect(all).not.toContain(PUSH_TOKEN);
    expect(all).not.toContain("/api/push");
    const pushes = logs.lines.filter((l) => l["event"] === "provider_status_push");
    expect(pushes).toHaveLength(2);
    expect(pushes[0]).toMatchObject({ outcome: "push_ok", pushHost: "kuma.example.test", pushed: "up" });
    expect(pushes[1]).toMatchObject({ outcome: "push_ok", pushed: "down" });
  });

  it("a push host missing from the allowlist is refused, not widened, and still not logged", async () => {
    const { transport, seen } = fakeTransport(() => new Response("", { status: 200 }));
    const logs = new CapturingLogger();
    const safeFetch = createSafeFetch({ allowlist: ["api.deepseek.com"], transport });
    expect(await pushProviderStatus(OK, { pushUrl: PUSH_URL, safeFetch, logger: logs.logger })).toBe(false);
    expect(seen).toHaveLength(0);
    expect(logs.lines.at(-1)).toMatchObject({ outcome: "push_egress_blocked", pushHost: "kuma.example.test" });
    expect(logs.raw.join("\n")).not.toContain(PUSH_TOKEN);
  });

  it("the monitor is off at interval 0, and pushes once immediately when on", async () => {
    const { transport, seen } = fakeTransport((url) =>
      url.startsWith("https://api.deepseek.com") ? json(200, AVAILABLE_BODY) : new Response("", { status: 200 }),
    );
    const logs = new CapturingLogger();
    const safeFetch = createSafeFetch({ allowlist: ["api.deepseek.com", "kuma.example.test"], transport });
    const checker = createProviderStatusChecker({
      provider: "deepseek",
      modelBaseUrl: "https://api.deepseek.com",
      apiKey: MODEL_KEY,
      safeFetch,
      logger: logs.logger,
      now: () => Date.now(),
    });

    const off = startProviderStatusMonitor({ checker, intervalMs: 0, pushUrl: PUSH_URL, safeFetch, logger: logs.logger });
    off();
    await new Promise((r) => setTimeout(r, 20));
    expect(seen).toHaveLength(0);

    const stop = startProviderStatusMonitor({ checker, intervalMs: 60_000, pushUrl: PUSH_URL, safeFetch, logger: logs.logger });
    await new Promise((r) => setTimeout(r, 50));
    stop();
    expect(seen.map((s) => new URL(s.url).hostname)).toEqual(["api.deepseek.com", "kuma.example.test"]);
    expect(new URL(seen[1]!.url).searchParams.get("status")).toBe("up");
    expect(logs.raw.join("\n")).not.toContain(PUSH_TOKEN);
    expect(logs.raw.join("\n")).not.toContain(MODEL_KEY);
  });
});

describe("provider status: configuration", () => {
  it("boot does not fail when the push URL and interval are unset (off by default)", () => {
    const config = envConfig();
    expect(config.providerStatusIntervalMs).toBe(0);
    expect(config.providerStatusPushUrl).toBeNull();
    expect(bootErrors(config)).toEqual([]);
  });

  it("boot does not fail with a push URL whose host is off the allowlist; it warns with the host only", () => {
    const config = envConfig({
      PROVIDER_STATUS_INTERVAL_MS: "300000",
      PROVIDER_STATUS_PUSH_URL: PUSH_URL,
      EGRESS_ALLOWLIST: "api.deepseek.com,paperclip.example.test",
    });
    expect(bootErrors(config)).toEqual([]);
    // Not auto-widened.
    expect(config.egressAllowlist).not.toContain("kuma.example.test");
    const warnings = bootWarnings(config).join("\n");
    expect(warnings).toContain("kuma.example.test");
    expect(warnings).not.toContain(PUSH_TOKEN);
  });

  it("control: with the push host allowlisted, there is no allowlist warning", () => {
    const config = envConfig({
      PROVIDER_STATUS_INTERVAL_MS: "300000",
      PROVIDER_STATUS_PUSH_URL: PUSH_URL,
      EGRESS_ALLOWLIST: "api.deepseek.com,paperclip.example.test,kuma.example.test",
    });
    expect(bootWarnings(config).join("\n")).not.toContain("PROVIDER_STATUS_PUSH_URL host");
  });
});
