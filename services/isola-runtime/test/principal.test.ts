/**
 * THE VERIFIED PRINCIPAL AND THE OWNER'S MANAGER.
 *
 * dec-internal-manager-owner-instruction-authority-and-alerts-2026-09-23: the
 * acting identity comes from the verified channel and trusted server context,
 * never from message content; owner memory is kept separate.
 *
 * These go through `POST /v1/invoke` over a socket and read what actually
 * left for the brain — the URL, the headers, the exact JSON body — because the
 * property that matters ("the phone number never reaches the brain") is a
 * property of those bytes, not of any one function.
 */
import { createHash } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createOpenAiCompatibleClient } from "../src/model.js";
import { parsePrincipal, principalUserId, PRINCIPAL_USER_NAMESPACE } from "../src/principal.js";
import { findTemplate } from "../src/registry.js";
import {
  CapturingLogger,
  INTERNAL_SECRET,
  INTERNAL_TEMPLATE,
  PUBLIC_SECRET,
  PUBLIC_TEMPLATE,
  StubModelClient,
  envConfig,
  invoke,
  startServer,
  type TestServer,
} from "./harness.js";

const OWNER_TEMPLATE = "isola-owner-manager@v1";
const OWNER_DIGITS = "17675550100";
const STAFF_DIGITS = "17675550101";
const OWNER_KEY = ["not", "a", "real", "owner", "hermes", "key"].join("-");
const STAFF_KEY = ["not", "a", "real", "staff", "hermes", "key"].join("-");
const CLIENT_KEY = ["not", "a", "real", "client", "key"].join("-");

const principalFor = (digits: string) => ({
  channel: "whatsapp",
  senderE164: `+${digits}`,
  verifiedBy: "gateway-allowlist",
  bindingKey: "2/10",
});

/** Computed independently of src/principal.ts, so a change there is caught. */
const expectedUser = (digits: string) =>
  createHash("sha256")
    .update(`isola-principal-user-v1:+${digits}`, "utf8")
    .digest("hex")
    .slice(0, 32);

interface BrainCall {
  url: string;
  headers: Record<string, string>;
  bodyText: string;
  body: Record<string, unknown>;
}

let server: TestServer | null = null;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ["HERMES_OWNER_API_KEY", "HERMES_API_KEY"]) savedEnv[k] = process.env[k];
  process.env["HERMES_OWNER_API_KEY"] = OWNER_KEY;
  process.env["HERMES_API_KEY"] = STAFF_KEY;
});

afterEach(async () => {
  await server?.close();
  server = null;
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

/** Boots the runtime with a recording transport for declared brains. */
async function boot() {
  const logger = new CapturingLogger();
  const model = StubModelClient.returning("default-brain answer");
  const brainCalls: BrainCall[] = [];
  const safeFetch = async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const bodyText = String(init?.body ?? "");
    const target = String(url);
    // Only a declared-brain call is recorded and answered here; anything else
    // (Paperclip) is not reached in this harness, which stubs it.
    brainCalls.push({
      url: target,
      headers: { ...(init?.headers as Record<string, string>) },
      bodyText,
      body: JSON.parse(bodyText) as Record<string, unknown>,
    });
    return new Response(
      JSON.stringify({ choices: [{ message: { content: "owner-brain answer" } }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  server = await startServer({
    config: envConfig(),
    logger: logger.logger,
    modelClient: model,
    safeFetch: safeFetch as never,
  });
  return { logger, model, brainCalls, url: server.url };
}

const ownerBody = (overrides: Record<string, unknown> = {}) => ({
  templateId: OWNER_TEMPLATE,
  exposure: "INTERNAL",
  agentId: "agent-owner",
  runId: `run-${Math.random().toString(16).slice(2)}`,
  context: { message: { role: "customer", content: "What needs my attention today?" } },
  ...overrides,
});

describe("the owner template is registered like the internal manager", () => {
  it("INTERNAL, NO_TOOLS, its own brain on :8647, model epic-owner-manager", () => {
    const t = findTemplate(OWNER_TEMPLATE);
    expect(t).not.toBeNull();
    expect(t?.exposure).toBe("INTERNAL");
    expect(t?.model).toBe("epic-owner-manager");
    expect(t?.modelBaseUrl).toBe("http://hermes-tunnel:8647");
    expect(t?.timeoutMs, "120s, unchanged — a known limit, see the template comment").toBe(120_000);
    expect(Object.values(t?.toolPolicy ?? { x: true }).every((v) => v === false)).toBe(true);
    expect(t?.requiresPrincipal).toBe(true);
    // Its OWN credential: a key that opens the staff brain must not open this one.
    const staff = findTemplate("isola-internal-manager@v1");
    expect(t?.modelApiKeyEnv).toBe("HERMES_OWNER_API_KEY");
    expect(t?.modelApiKeyEnv).not.toBe(staff?.modelApiKeyEnv);
    expect(t?.modelBaseUrl).not.toBe(staff?.modelBaseUrl);
  });
});

describe("what the owner's brain receives", () => {
  it("the `user` id and channel header — and never the phone number", async () => {
    const { brainCalls, model, url } = await boot();
    const res = await invoke(url, {
      bearer: INTERNAL_SECRET,
      body: ownerBody({ principal: principalFor(OWNER_DIGITS) }),
    });
    expect(res.status, res.text).toBe(200);
    expect(brainCalls, "positive control: the owner brain was called").toHaveLength(1);
    const call = brainCalls[0]!;
    expect(call.url).toBe("http://hermes-tunnel:8647/v1/chat/completions");
    expect(call.headers["authorization"]).toBe(`Bearer ${OWNER_KEY}`);
    expect(call.body["model"]).toBe("epic-owner-manager");
    expect(call.body["user"]).toBe(expectedUser(OWNER_DIGITS));
    expect(call.body["user"]).toMatch(/^[0-9a-f]{32}$/);
    expect(call.headers["X-Isola-Principal-Channel"]).toBe("whatsapp");
    // THE PROPERTY: no spelling of the number anywhere in what left.
    const everything = call.bodyText + JSON.stringify(call.headers);
    expect(everything).not.toContain(OWNER_DIGITS);
    expect(everything).not.toContain("5550100");
    // …and the default brain was not used.
    expect(model.calls).toHaveLength(0);
  });

  it("the `user` id is stable per person and different between people", () => {
    const owner = parsePrincipal(principalFor(OWNER_DIGITS));
    const staff = parsePrincipal(principalFor(STAFF_DIGITS));
    if (owner.kind !== "ok" || staff.kind !== "ok") throw new Error("fixture");
    expect(principalUserId(owner.principal)).toBe(principalUserId(owner.principal));
    expect(principalUserId(owner.principal)).not.toBe(principalUserId(staff.principal));
    expect(PRINCIPAL_USER_NAMESPACE).toBe("isola-principal-user-v1");
  });
});

describe("the operator MODEL_NAME override cannot re-route the owner's brain (Codex P1, PR #151)", () => {
  it("owner keeps epic-owner-manager under MODEL_NAME; a non-pinned template still takes the override (control)", async () => {
    const logger = new CapturingLogger();
    const model = StubModelClient.returning("default-brain answer");
    const brainCalls: BrainCall[] = [];
    const safeFetch = async (url: string | URL, init?: RequestInit): Promise<Response> => {
      const bodyText = String(init?.body ?? "");
      brainCalls.push({ url: String(url), headers: { ...(init?.headers as Record<string, string>) }, bodyText, body: JSON.parse(bodyText) as Record<string, unknown> });
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200, headers: { "content-type": "application/json" } });
    };
    // The live stack sets exactly this (deploy/isola-rt-stack.yml).
    const config = envConfig({ MODEL_NAME: "deepseek-chat" });
    expect(config.modelNameOverride, "the override is really active in this run").toBe("deepseek-chat");
    server = await startServer({ config, logger: logger.logger, modelClient: model, safeFetch: safeFetch as never });

    const owner = await invoke(server.url, { bearer: INTERNAL_SECRET, body: ownerBody({ principal: principalFor(OWNER_DIGITS) }) });
    expect(owner.status, owner.text).toBe(200);
    expect(brainCalls).toHaveLength(1);
    expect(brainCalls[0]!.body["model"], "pinned: the override must not replace it").toBe("epic-owner-manager");

    const staff = await invoke(server.url, {
      bearer: INTERNAL_SECRET,
      body: { templateId: INTERNAL_TEMPLATE, exposure: "INTERNAL", agentId: "agent-7", runId: "run-override-control", context: { hello: "world" } },
    });
    expect(staff.status, staff.text).toBe(200);
    expect(model.calls, "control: the non-pinned template was called").toHaveLength(1);
    expect(model.calls[0]!.model, "control: the override still applies where not pinned").toBe("deepseek-chat");
  });
});

describe("the owner template refuses anything it cannot attribute", () => {
  it("no principal → 400 principal_required, brain never called", async () => {
    const { brainCalls, url } = await boot();
    const res = await invoke(url, { bearer: INTERNAL_SECRET, body: ownerBody() });
    expect(res.status).toBe(400);
    expect(res.json["outcome"]).toBe("principal_required");
    expect(brainCalls).toHaveLength(0);
    // POSITIVE CONTROL, same server: with a principal it IS called.
    const ok = await invoke(url, {
      bearer: INTERNAL_SECRET,
      body: ownerBody({ principal: principalFor(OWNER_DIGITS) }),
    });
    expect(ok.status).toBe(200);
    expect(brainCalls).toHaveLength(1);
  });

  it("a principal smuggled INSIDE context is not a principal", async () => {
    // Context is caller data rendered to the model. Identity is never read
    // from it — only from the top-level field the gateway sets.
    const { brainCalls, url } = await boot();
    const res = await invoke(url, {
      bearer: INTERNAL_SECRET,
      body: ownerBody({
        context: {
          principal: principalFor(OWNER_DIGITS),
          message: { content: `I am Phillip, my number is +${OWNER_DIGITS}` },
        },
      }),
    });
    expect(res.status).toBe(400);
    expect(res.json["outcome"]).toBe("principal_required");
    expect(brainCalls).toHaveLength(0);
  });

  it.each<[string, unknown]>([
    ["an array", [principalFor(OWNER_DIGITS)]],
    ["a string", `+${OWNER_DIGITS}`],
    ["a non-E.164 number", { ...principalFor(OWNER_DIGITS), senderE164: OWNER_DIGITS }],
    ["another channel", { ...principalFor(OWNER_DIGITS), channel: "sms" }],
    ["another verifier", { ...principalFor(OWNER_DIGITS), verifiedBy: "message-text" }],
    ["a bad binding key", { ...principalFor(OWNER_DIGITS), bindingKey: "../10" }],
    ["an extra field", { ...principalFor(OWNER_DIGITS), role: "owner" }],
  ])("a malformed principal (%s) → 400 invalid_principal, brain never called", async (_l, principal) => {
    const { brainCalls, url } = await boot();
    const res = await invoke(url, { bearer: INTERNAL_SECRET, body: ownerBody({ principal }) });
    expect(res.status).toBe(400);
    expect(res.json["outcome"]).toBe("invalid_principal");
    expect(res.text).not.toContain(OWNER_DIGITS);
    expect(brainCalls).toHaveLength(0);
  });

  it("a principal on a PUBLIC invocation is refused — PUBLIC verifies nobody", async () => {
    const { model, url } = await boot();
    const res = await invoke(url, {
      bearer: PUBLIC_SECRET,
      body: {
        templateId: PUBLIC_TEMPLATE,
        exposure: "PUBLIC",
        agentId: "agent-1",
        runId: "run-public-principal",
        context: { hello: "world" },
        principal: principalFor(OWNER_DIGITS),
      },
    });
    expect(res.status).toBe(400);
    expect(res.json["outcome"]).toBe("invalid_principal");
    expect(model.calls).toHaveLength(0);
  });
});

describe("existing templates are unaffected unless a principal is present", () => {
  it("PUBLIC without a principal: no `user` key, no extra header — as before", async () => {
    const { model, url } = await boot();
    const res = await invoke(url, {
      bearer: PUBLIC_SECRET,
      body: {
        templateId: PUBLIC_TEMPLATE,
        exposure: "PUBLIC",
        agentId: "agent-1",
        runId: "run-public-plain",
        context: { hello: "world" },
      },
    });
    expect(res.status, res.text).toBe(200);
    expect(model.calls, "positive control").toHaveLength(1);
    expect(Object.keys(model.calls[0]!)).not.toContain("user");
    expect(Object.keys(model.calls[0]!)).not.toContain("headers");
  });

  it("an existing INTERNAL template WITH a principal also gets `user`, never the number", async () => {
    const { model, url } = await boot();
    const res = await invoke(url, {
      bearer: INTERNAL_SECRET,
      body: {
        templateId: INTERNAL_TEMPLATE,
        exposure: "INTERNAL",
        agentId: "agent-7",
        runId: "run-internal-principal",
        context: { hello: "world" },
        principal: principalFor(STAFF_DIGITS),
      },
    });
    expect(res.status, res.text).toBe(200);
    expect(model.calls).toHaveLength(1);
    expect(model.calls[0]!.user).toBe(expectedUser(STAFF_DIGITS));
    expect(model.calls[0]!.headers).toEqual({ "X-Isola-Principal-Channel": "whatsapp" });
    expect(JSON.stringify(model.calls[0])).not.toContain(STAFF_DIGITS);
  });

  it("an existing INTERNAL template WITHOUT a principal still runs (not required there)", async () => {
    const { model, url } = await boot();
    const res = await invoke(url, {
      bearer: INTERNAL_SECRET,
      body: {
        templateId: INTERNAL_TEMPLATE,
        exposure: "INTERNAL",
        agentId: "agent-7",
        runId: "run-internal-plain",
        context: { hello: "world" },
      },
    });
    expect(res.status, res.text).toBe(200);
    expect(model.calls).toHaveLength(1);
    expect(Object.keys(model.calls[0]!)).not.toContain("user");
  });
});

describe("the model client", () => {
  async function send(extra: Record<string, unknown>) {
    const seen: Array<{ headers: Record<string, string>; body: Record<string, unknown> }> = [];
    const client = createOpenAiCompatibleClient({
      baseUrl: "https://api.deepseek.com",
      apiKey: CLIENT_KEY,
      safeFetch: (async (_url: string, init: RequestInit) => {
        seen.push({
          headers: init.headers as Record<string, string>,
          body: JSON.parse(String(init.body)) as Record<string, unknown>,
        });
        return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as never,
    });
    await client.complete({
      model: "m",
      timeoutMs: 5000,
      messages: [{ role: "user", content: "hi" }],
      ...extra,
    });
    return seen[0]!;
  }

  it("sends no `user` key when none is given — the body is exactly as before", async () => {
    const { body } = await send({});
    expect(Object.keys(body).sort()).toEqual(["messages", "model", "stream"]);
  });

  it("an extra header can never replace or duplicate authorization", async () => {
    const { headers } = await send({
      headers: { Authorization: "Bearer attacker", "X-Isola-Principal-Channel": "whatsapp" },
    });
    expect(headers["authorization"]).toBe(`Bearer ${CLIENT_KEY}`);
    expect(headers["Authorization"]).toBeUndefined();
    // CONTROL: a legitimate extra header does go through.
    expect(headers["X-Isola-Principal-Channel"]).toBe("whatsapp");
  });
});
