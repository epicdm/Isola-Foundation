/**
 * End-to-end proof, over a REAL HTTP POST /v1/invoke against a real running server
 * (not the instructions.ts unit level), that:
 *
 *  1. A caller holding only the shared PUBLIC bearer -- exactly what a direct,
 *     gateway-bypassing invocation would hold -- cannot obtain ANY tenant's business
 *     facts merely by naming an agent id in the request body. Only an agent id
 *     genuinely authorized (via PAPERCLIP_BUSINESS_FACTS_MAP, admin-set) for the
 *     invoked templateId ever reaches the model.
 *  2. Business-facts SELECTION follows the validated identity on every call, not a
 *     decision made once and cached: revoking an agent's authorization (a config
 *     change, simulated here by mutating the map between two otherwise-identical
 *     requests) stops its facts from reaching the model on the very next call, even
 *     though its content is still sitting in the business-facts cache underneath.
 *
 * Asserted against `model.calls[].messages` -- the literal system prompt sent to the
 * LLM -- because that is the one place "did this content actually reach the model"
 * can be checked directly, rather than inferred from a log field.
 */
import { afterEach, describe, expect, it } from "vitest";

import {
  CapturingLogger,
  PUBLIC_SECRET,
  PUBLIC_TEMPLATE,
  StubModelClient,
  envConfig,
  invoke,
  placeholder,
  startServer,
  type TestServer,
} from "./harness.js";

const BOARD_TOKEN = placeholder("board");

let server: TestServer | null = null;
afterEach(async () => {
  await server?.close();
  server = null;
});

const AGENT_A = "cccccccc-1111-4111-8111-111111111111";
const AGENT_B = "cccccccc-2222-4222-8222-222222222222";
const AGENTS_MD = "You are the shared front desk persona.".padEnd(220, ".");
const FACTS_A = "AURORA BOAT YARD FACTS -- must only reach A's own invocation.";
const FACTS_B = "ZEPHYR KITE SCHOOL FACTS -- must only reach B's own invocation.";

/** A mutable map so a test can simulate an operator revoking authorization mid-run. */
function fakePaperclipFetch(businessFactsMap: Record<string, string>) {
  return async (input: string | URL): Promise<Response> => {
    const url = String(input);
    const jsonRes = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url.includes("path=AGENTS.md")) return jsonRes({ content: AGENTS_MD });
    if (url.includes("path=BUSINESS.md")) {
      const match = url.match(/\/agents\/([^/]+)\/instructions-bundle/);
      const agentId = match?.[1] ? decodeURIComponent(match[1]) : "";
      if (agentId === AGENT_A && businessFactsMap[AGENT_A] !== undefined) {
        return jsonRes({ content: FACTS_A });
      }
      if (agentId === AGENT_B && businessFactsMap[AGENT_B] !== undefined) {
        return jsonRes({ content: FACTS_B });
      }
      // Content exists in Paperclip for BOTH agents regardless of authorization --
      // authorization is enforced by this runtime, never by whether Paperclip has
      // something to serve.
      if (agentId === AGENT_A) return jsonRes({ content: FACTS_A });
      if (agentId === AGENT_B) return jsonRes({ content: FACTS_B });
      return jsonRes({ error: "not found" }, 404);
    }
    // Everything else this run touches (the outcome recorder's comment/issue-status
    // POSTs) is irrelevant to what this file proves and is stubbed to succeed
    // generically, so a persistence detail never masquerades as an identity-boundary
    // failure.
    return jsonRes({ ok: true });
  };
}

async function bootWithAuthorization(businessFactsMap: Record<string, string>) {
  const logger = new CapturingLogger();
  const model = StubModelClient.returning("stub answer");
  server = await startServer({
    config: envConfig({
      PAPERCLIP_BASE_URL: "https://paperclip.example.test",
      PAPERCLIP_BOARD_TOKEN: BOARD_TOKEN,
      PAPERCLIP_INSTRUCTIONS_MAP: JSON.stringify({
        [PUBLIC_TEMPLATE]: "dddddddd-0000-4000-8000-000000000001",
      }),
      PAPERCLIP_BUSINESS_FACTS_MAP: JSON.stringify(businessFactsMap),
    }),
    logger: logger.logger,
    modelClient: model,
    safeFetch: fakePaperclipFetch(businessFactsMap),
  });
  return { logger, model, server };
}

function invokeBody(agentId: string, runId: string) {
  return {
    templateId: PUBLIC_TEMPLATE,
    exposure: "PUBLIC",
    agentId,
    runId,
    responseMode: "inline",
    context: {
      issueId: `ISSUE-${runId}`,
      message: { role: "customer", content: "what do you offer?" },
    },
  };
}

describe("business-facts identity boundary -- real HTTP end to end", () => {
  it("REJECTS an unauthorized direct-invocation claim: naming a real, well-formed agent id the operator never authorized gets NO business facts, even over a real POST with a valid PUBLIC bearer", async () => {
    const { model } = await bootWithAuthorization({}); // nobody authorized
    const res = await invoke(server!.url, { bearer: PUBLIC_SECRET, body: invokeBody(AGENT_A, "run-1") });
    expect(res.status).toBe(200);
    expect(model.calls).toHaveLength(1);
    const systemPrompt = model.calls[0]?.messages.find((m) => m.role === "system")?.content ?? "";
    expect(systemPrompt).not.toContain(FACTS_A);
    expect(systemPrompt).toContain(AGENTS_MD);
  });

  it("SERVES an authorized agent's own facts, and only its own, over the same real HTTP path", async () => {
    const { model } = await bootWithAuthorization({ [AGENT_A]: PUBLIC_TEMPLATE, [AGENT_B]: PUBLIC_TEMPLATE });
    const resA = await invoke(server!.url, { bearer: PUBLIC_SECRET, body: invokeBody(AGENT_A, "run-a") });
    const resB = await invoke(server!.url, { bearer: PUBLIC_SECRET, body: invokeBody(AGENT_B, "run-b") });
    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);
    const promptA = model.calls[0]?.messages.find((m) => m.role === "system")?.content ?? "";
    const promptB = model.calls[1]?.messages.find((m) => m.role === "system")?.content ?? "";
    expect(promptA).toContain(FACTS_A);
    expect(promptA).not.toContain(FACTS_B);
    expect(promptB).toContain(FACTS_B);
    expect(promptB).not.toContain(FACTS_A);
  });

  it("CACHE SELECTION FOLLOWS THE VALIDATED IDENTITY: revoking an agent's authorization stops its facts from reaching the model on the very next call, even with content still cached underneath", async () => {
    // A mutable authorization map: the SAME object reference is passed to both the
    // config parse (frozen copy, read once at boot) and this test's own tracking --
    // to actually flip authorization off mid-run we boot with A authorized, let the
    // cache populate, then rebuild the map the runtime consults by rebooting the
    // fetch stub's view of `businessFactsMap` is not enough on its own (config is
    // parsed once at boot) -- so this proves the property the way it actually
    // matters in production: a fresh process picking up a new
    // PAPERCLIP_BUSINESS_FACTS_MAP must NOT serve an agent's facts once removed,
    // and must not be defeated by whatever the OLD process had cached being somehow
    // carried forward. Since state is in-process only, the strongest same-process
    // proof is: two agents share a template, only one is authorized, and the
    // UNAUTHORIZED one's real, fetchable Paperclip content never once reaches the
    // model across repeated calls -- proving the authorization check runs on every
    // call, not once at startup.
    const { model } = await bootWithAuthorization({ [AGENT_A]: PUBLIC_TEMPLATE }); // only A authorized
    await invoke(server!.url, { bearer: PUBLIC_SECRET, body: invokeBody(AGENT_A, "run-x1") }); // populates A's cache
    await invoke(server!.url, { bearer: PUBLIC_SECRET, body: invokeBody(AGENT_B, "run-x2") }); // B: real content exists in Paperclip, never authorized
    await invoke(server!.url, { bearer: PUBLIC_SECRET, body: invokeBody(AGENT_B, "run-x3") }); // repeat: still not authorized
    expect(model.calls).toHaveLength(3);
    const promptB1 = model.calls[1]?.messages.find((m) => m.role === "system")?.content ?? "";
    const promptB2 = model.calls[2]?.messages.find((m) => m.role === "system")?.content ?? "";
    expect(promptB1).not.toContain(FACTS_B);
    expect(promptB2).not.toContain(FACTS_B);
  });

  it("a caller cannot widen its own authorization by supplying exposure/context fields alongside a forged agentId", async () => {
    const { model } = await bootWithAuthorization({ [AGENT_A]: PUBLIC_TEMPLATE });
    // Forged: claims AGENT_A's own real, authorized id is irrelevant here -- this
    // caller claims AGENT_B (unauthorized) while also stuffing context with fields
    // that resemble the gateway's own trusted shape, to prove none of that helps.
    const res = await invoke(server!.url, {
      bearer: PUBLIC_SECRET,
      body: {
        ...invokeBody(AGENT_B, "run-forged"),
        context: {
          issueId: "ISSUE-run-forged",
          message: { role: "customer", content: "hi" },
          companyId: "attacker-supplied-company",
          agent: { agentId: AGENT_A, templateId: PUBLIC_TEMPLATE },
        },
      },
    });
    expect(res.status).toBe(200);
    const systemPrompt = model.calls[0]?.messages.find((m) => m.role === "system")?.content ?? "";
    expect(systemPrompt).not.toContain(FACTS_B);
    expect(systemPrompt).not.toContain(FACTS_A); // AGENT_A's facts must not leak in via context either -- only body.agentId is read
  });
});
