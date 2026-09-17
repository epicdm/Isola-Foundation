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

async function bootWithAuthorization(
  businessFactsMap: Record<string, string>,
  agentCallerSecrets: Record<string, string> = {},
) {
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
      PAPERCLIP_AGENT_CALLER_SECRETS: JSON.stringify(agentCallerSecrets),
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

  it("SERVES an authorized agent's own facts, and only its own, over the same real HTTP path -- each using ITS OWN caller secret, required unconditionally", async () => {
    const AGENT_A_SECRET = placeholder("agent-a-serves");
    const AGENT_B_SECRET = placeholder("agent-b-serves");
    const { model } = await bootWithAuthorization(
      { [AGENT_A]: PUBLIC_TEMPLATE, [AGENT_B]: PUBLIC_TEMPLATE },
      { [AGENT_A]: AGENT_A_SECRET, [AGENT_B]: AGENT_B_SECRET },
    );
    const resA = await invoke(server!.url, { bearer: AGENT_A_SECRET, body: invokeBody(AGENT_A, "run-a") });
    const resB = await invoke(server!.url, { bearer: AGENT_B_SECRET, body: invokeBody(AGENT_B, "run-b") });
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
    // Two agents share the template; only A is authorized AND has a caller secret
    // (so its cache genuinely populates with real facts, proving this test means
    // something -- not just "B was never authorized"). B is real, has real fetchable
    // content in Paperclip, but has no businessFactsMap entry at all -- proving the
    // authorization check runs on every call, not once at startup, and that cached
    // content never leaks to an agent it was never fetched for.
    const AGENT_A_SECRET = placeholder("agent-a-cache");
    const { model } = await bootWithAuthorization(
      { [AGENT_A]: PUBLIC_TEMPLATE }, // only A authorized
      { [AGENT_A]: AGENT_A_SECRET },
    );
    await invoke(server!.url, { bearer: AGENT_A_SECRET, body: invokeBody(AGENT_A, "run-x1") }); // populates A's cache for real
    await invoke(server!.url, { bearer: PUBLIC_SECRET, body: invokeBody(AGENT_B, "run-x2") }); // B: real content exists in Paperclip, never authorized
    await invoke(server!.url, { bearer: PUBLIC_SECRET, body: invokeBody(AGENT_B, "run-x3") }); // repeat: still not authorized
    expect(model.calls).toHaveLength(3);
    const promptA = model.calls[0]?.messages.find((m) => m.role === "system")?.content ?? "";
    const promptB1 = model.calls[1]?.messages.find((m) => m.role === "system")?.content ?? "";
    const promptB2 = model.calls[2]?.messages.find((m) => m.role === "system")?.content ?? "";
    expect(promptA).toContain(FACTS_A); // A's cache genuinely populated
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

  it("OWNER CORRECTION -- with NO agent-bound secrets configured at all, an authorized agent's facts are DENIED, not served on the claim alone (the pre-fix vulnerability is no longer a permitted default for ANY agent in businessFactsMap)", async () => {
    // An earlier version of this fix made caller-proof opt-in per agent, so an
    // authorized-but-not-yet-hardened agent still fell back to the pre-fix
    // claim-alone path. Ruled unacceptable regardless of content sensitivity: this
    // test now proves the corrected, unconditional default -- authorization in
    // businessFactsMap with no matching caller secret gets NOTHING, for every
    // agent, always, with no backward-compatible exception.
    const { model } = await bootWithAuthorization({ [AGENT_A]: PUBLIC_TEMPLATE, [AGENT_B]: PUBLIC_TEMPLATE });
    const asA = await invoke(server!.url, { bearer: PUBLIC_SECRET, body: invokeBody(AGENT_A, "run-imp-a") });
    const asB = await invoke(server!.url, { bearer: PUBLIC_SECRET, body: invokeBody(AGENT_B, "run-imp-b") });
    expect(asA.status).toBe(200);
    expect(asB.status).toBe(200);
    const promptAsA = model.calls[0]?.messages.find((m) => m.role === "system")?.content ?? "";
    const promptAsB = model.calls[1]?.messages.find((m) => m.role === "system")?.content ?? "";
    expect(promptAsA).not.toContain(FACTS_A);
    expect(promptAsB).not.toContain(FACTS_B);
    expect(promptAsA).toBe(AGENTS_MD);
    expect(promptAsB).toBe(AGENTS_MD);
  });

  it("CALLER-PROOF IS UNCONDITIONAL, NOT A SEPARATE OPT-IN -- hardening A's secret has no effect on B; B stays denied (not 'unaffected and still working') until B ALSO gets its own caller secret", async () => {
    const AGENT_A_SECRET = placeholder("agent-a-caller-2");
    const { model } = await bootWithAuthorization(
      { [AGENT_A]: PUBLIC_TEMPLATE, [AGENT_B]: PUBLIC_TEMPLATE },
      { [AGENT_A]: AGENT_A_SECRET }, // only A has a caller secret; B does not
    );
    // B, still with no caller secret of its own, is denied -- the plain shared
    // bearer no longer reaches B's facts just because B lacks hardening.
    const asB = await invoke(server!.url, { bearer: PUBLIC_SECRET, body: invokeBody(AGENT_B, "run-b-unhardened") });
    expect(asB.status).toBe(200);
    const promptB = model.calls[0]?.messages.find((m) => m.role === "system")?.content ?? "";
    expect(promptB).not.toContain(FACTS_B);

    // A, using its OWN real caller secret (not the plain shared bearer), still works.
    const asA = await invoke(server!.url, { bearer: AGENT_A_SECRET, body: invokeBody(AGENT_A, "run-a-hardened") });
    expect(asA.status).toBe(200);
    const promptA = model.calls[1]?.messages.find((m) => m.role === "system")?.content ?? "";
    expect(promptA).toContain(FACTS_A);
  });

  it("THE FIX, RE-VERIFIED BY RE-RUNNING THE ACTUAL IMPERSONATION ATTEMPT -- once agent-bound secrets are configured, A's own real credential cannot be used to claim B's identity, even naming a genuinely authorized (agentId, templateId) pair", async () => {
    const AGENT_A_SECRET = placeholder("agent-a-caller");
    const AGENT_B_SECRET = placeholder("agent-b-caller");
    const { model } = await bootWithAuthorization(
      { [AGENT_A]: PUBLIC_TEMPLATE, [AGENT_B]: PUBLIC_TEMPLATE },
      { [AGENT_A]: AGENT_A_SECRET, [AGENT_B]: AGENT_B_SECRET },
    );

    // THE EXACT ATTACK: A's own real, working credential (its own agent-bound
    // secret -- "the actual caller authentication available to A"), presenting a
    // genuinely authorized (agentId, templateId) pair -- but for B, not itself.
    const impersonationAttempt = await invoke(server!.url, {
      bearer: AGENT_A_SECRET,
      body: invokeBody(AGENT_B, "run-fixed-impersonation"),
    });
    expect(impersonationAttempt.status).toBe(200); // still answers -- fails closed to persona-only, not an error
    const impersonationPrompt =
      model.calls[0]?.messages.find((m) => m.role === "system")?.content ?? "";
    expect(impersonationPrompt).not.toContain(FACTS_B);
    expect(impersonationPrompt).not.toContain(FACTS_A); // A's own facts don't leak in either -- the claim named B, and B is what was checked

    // Confirm the harness itself is sound (a real negative control, not a
    // vacuously-passing test): A's own secret, honestly naming ITSELF, still works.
    const honestCall = await invoke(server!.url, {
      bearer: AGENT_A_SECRET,
      body: invokeBody(AGENT_A, "run-fixed-honest"),
    });
    expect(honestCall.status).toBe(200);
    const honestPrompt = model.calls[1]?.messages.find((m) => m.role === "system")?.content ?? "";
    expect(honestPrompt).toContain(FACTS_A);

    // Negative control on the credential itself: the WRONG shared bearer (a
    // different exposure class entirely) is rejected outright, proving this test
    // harness actually enforces authentication rather than accepting anything.
    const wrongExposure = await invoke(server!.url, {
      bearer: "not-a-real-bearer-at-all",
      body: invokeBody(AGENT_B, "run-should-not-run"),
    });
    expect(wrongExposure.status).toBe(401);
  });
});

describe("THE EXACT PLANNED DEPLOYMENT CONFIGURATION -- 5c3277f0 on isola-ai-sales-front-desk-agent@v1, protected", () => {
  // Real production identifiers, not synthetic stand-ins: the actual Paperclip
  // agent id and templateId named in PR139's release package. PUBLIC_TEMPLATE
  // (harness.ts) already equals the real "isola-ai-sales-front-desk-agent@v1".
  // fd2867d1 and a9dce05a are deliberately NOT used anywhere in this file -- see
  // defect-fd2867d1-active-vs-contained-contradiction-2026-09-17; the "another
  // agent sharing this template" role below is a fresh synthetic id instead.
  const REAL_TARGET_AGENT = "5c3277f0-927d-4a56-bf7b-ba5dc958c66b";
  const OTHER_SHARED_TEMPLATE_AGENT = "ffffffff-9999-4999-8999-999999999999";
  const REAL_FACTS = "EPIC Communications Inc -- Roseau, Dominica. Internet, VoIP, IT support.";
  const OTHER_FACTS = "A DIFFERENT tenant sharing the same template -- must never reach 5c3277f0's caller.";

  /** A fetch stub keyed by THIS block's own agent ids, not the shared A/B fixtures above. */
  function realShapeFetch(): (input: string | URL) => Promise<Response> {
    return async (input: string | URL): Promise<Response> => {
      const url = String(input);
      const jsonRes = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
      if (url.includes("path=AGENTS.md")) return jsonRes({ content: AGENTS_MD });
      if (url.includes("path=BUSINESS.md")) {
        const match = url.match(/\/agents\/([^/]+)\/instructions-bundle/);
        const agentId = match?.[1] ? decodeURIComponent(match[1]) : "";
        if (agentId === REAL_TARGET_AGENT) return jsonRes({ content: REAL_FACTS });
        if (agentId === OTHER_SHARED_TEMPLATE_AGENT) return jsonRes({ content: OTHER_FACTS });
        return jsonRes({ error: "not found" }, 404);
      }
      return jsonRes({ ok: true });
    };
  }

  it("with the release package's exact PAPERCLIP_BUSINESS_FACTS_MAP + a minted caller secret for 5c3277f0, the honest path works and impersonation from another agent sharing the same template is refused", async () => {
    const TARGET_SECRET = placeholder("5c3277f0-caller");
    const OTHER_SECRET = placeholder("other-shared-template-caller");
    const logger = new CapturingLogger();
    const model = StubModelClient.returning("stub answer");
    server = await startServer({
      config: envConfig({
        PAPERCLIP_BASE_URL: "https://paperclip.example.test",
        PAPERCLIP_BOARD_TOKEN: BOARD_TOKEN,
        PAPERCLIP_INSTRUCTIONS_MAP: JSON.stringify({
          [PUBLIC_TEMPLATE]: "dddddddd-0000-4000-8000-000000000001",
        }),
        // Exactly the release package's config value (real target agent id, real templateId).
        PAPERCLIP_BUSINESS_FACTS_MAP: JSON.stringify({
          [REAL_TARGET_AGENT]: PUBLIC_TEMPLATE,
          [OTHER_SHARED_TEMPLATE_AGENT]: PUBLIC_TEMPLATE,
        }),
        // The operator action this test proves is necessary: minting 5c3277f0 its
        // own caller secret is what makes the release package actually protected,
        // not merely authorized. OTHER_SHARED_TEMPLATE_AGENT ALSO has a real,
        // genuinely valid caller secret -- so the impersonation attempt below uses
        // a real, working credential, not an unrecognised bearer (401 would prove
        // nothing about business-facts identity; it must reach that check and be
        // refused there).
        PAPERCLIP_AGENT_CALLER_SECRETS: JSON.stringify({
          [REAL_TARGET_AGENT]: TARGET_SECRET,
          [OTHER_SHARED_TEMPLATE_AGENT]: OTHER_SECRET,
        }),
      }),
      logger: logger.logger,
      modelClient: model,
      safeFetch: realShapeFetch(),
    });

    // HONEST PATH: 5c3277f0's own real caller secret, honestly naming itself.
    const honest = await invoke(server!.url, {
      bearer: TARGET_SECRET,
      body: invokeBody(REAL_TARGET_AGENT, "run-real-honest"),
    });
    expect(honest.status).toBe(200);
    const honestPrompt = model.calls[0]?.messages.find((m) => m.role === "system")?.content ?? "";
    expect(honestPrompt).toContain(REAL_FACTS);

    // IMPERSONATION: the plain shared PUBLIC bearer (what a caller bypassing the
    // gateway would hold) claims to BE 5c3277f0 -- refused.
    const bypassClaim = await invoke(server!.url, {
      bearer: PUBLIC_SECRET,
      body: invokeBody(REAL_TARGET_AGENT, "run-real-bypass"),
    });
    expect(bypassClaim.status).toBe(200);
    const bypassPrompt = model.calls[1]?.messages.find((m) => m.role === "system")?.content ?? "";
    expect(bypassPrompt).not.toContain(REAL_FACTS);

    // IMPERSONATION: a DIFFERENT agent's OWN real, valid, working credential (also
    // sharing this exact template) claims to BE 5c3277f0 -- refused. This is the
    // exact original exploit shape, re-run against the exact planned deployment
    // configuration.
    const crossAgent = await invoke(server!.url, {
      bearer: OTHER_SECRET,
      body: invokeBody(REAL_TARGET_AGENT, "run-real-cross-agent"),
    });
    expect(crossAgent.status).toBe(200);
    const crossPrompt = model.calls[2]?.messages.find((m) => m.role === "system")?.content ?? "";
    expect(crossPrompt).not.toContain(REAL_FACTS);
    expect(crossPrompt).not.toContain(OTHER_FACTS);

    // And OTHER_SHARED_TEMPLATE_AGENT's own honest call, with its own credential,
    // still works -- proving the refusal above is identity-specific, not a
    // blanket failure.
    const otherHonest = await invoke(server!.url, {
      bearer: OTHER_SECRET,
      body: invokeBody(OTHER_SHARED_TEMPLATE_AGENT, "run-real-other-honest"),
    });
    expect(otherHonest.status).toBe(200);
    const otherHonestPrompt = model.calls[3]?.messages.find((m) => m.role === "system")?.content ?? "";
    expect(otherHonestPrompt).toContain(OTHER_FACTS);
  });
});
