/**
 * Reproducible proof that the ACTUAL, owner-reviewable BUSINESS.md draft prepared
 * for 5c3277f0 (see PR #140, artifacts/isola/charters/pending/NEW-5c3277f0-BUSINESS.md
 * -- test/fixtures/epic-5c3277f0-BUSINESS.md here is byte-identical to that file, not a
 * paraphrase) flows correctly through cd13db9's identity-gated business-facts path to
 * a real, answerable customer question, and is refused to two independent
 * impersonation shapes while an unrelated tenant sharing the same template stays
 * isolated on both sides.
 *
 * This complements, not replaces, the existing "THE EXACT PLANNED DEPLOYMENT
 * CONFIGURATION" describe block in business-facts-identity-e2e.test.ts, which proves
 * the same mechanism with a short placeholder fact string. This file proves it again
 * with the actual multi-section markdown content an operator would really upload,
 * including its SOURCED/INFERRED labels and "do not invent a figure" guardrail, to
 * catch anything that only breaks on real-shaped content (length, markdown syntax,
 * multiple distinct fact strings) that a one-line placeholder cannot.
 *
 * WHAT IS REAL VS MOCKED, EXPLICITLY:
 *  - REAL: isola-runtime's own code at this commit (instructions.ts's
 *    authorizedBusinessAgent, the HTTP route, config parsing) -- nothing under test
 *    is stubbed out.
 *  - REAL: the actual BUSINESS.md content prepared for the owner in PR #140 (fixture
 *    file is byte-identical, verified by CI-visible diff at commit time -- see the
 *    file header above).
 *  - MOCKED: the Paperclip HTTP API itself (`safeFetch` is replaced with an in-memory
 *    stub keyed by agent id -- no network call to any Paperclip instance).
 *  - MOCKED: the downstream LLM (`StubModelClient` returns a fixed string -- no real
 *    DeepSeek/model call). The assertion is on the SYSTEM PROMPT this runtime built,
 *    i.e. "did the real facts reach the point where the model would see them", not on
 *    model output quality.
 *  - LOCAL ONLY: `startServer()` boots this code in-process via Node's HTTP server on
 *    a local port for the duration of the test. This is not run against any deployed
 *    environment, staging or production, and does not require PR139 to be merged.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  PUBLIC_SECRET,
  PUBLIC_TEMPLATE,
  StubModelClient,
  CapturingLogger,
  envConfig,
  invoke,
  placeholder,
  startServer,
  type TestServer,
} from "./harness.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BOARD_TOKEN = placeholder("board");

let server: TestServer | null = null;
afterEach(async () => {
  await server?.close();
  server = null;
});

// Real production identifiers named in PR139's release package and PR #140's
// prepared write. fd2867d1 is deliberately not used anywhere in this file -- see
// defect-fd2867d1-active-vs-contained-contradiction-2026-09-17 (it carries ACTIVE
// production traffic today alongside an unreversed 2026-08-12 containment order;
// it is not a synthetic or retired stand-in and must not be used as one in a test).
const REAL_TARGET_AGENT = "5c3277f0-927d-4a56-bf7b-ba5dc958c66b";
const OTHER_SHARED_TEMPLATE_AGENT = "ffffffff-9999-4999-8999-999999999999";
const AGENTS_MD = "You are the EPIC Communications AI Sales & Front Desk Agent.".padEnd(220, ".");
const OTHER_FACTS = "A DIFFERENT tenant sharing the same template -- must never reach 5c3277f0's caller.";

// Byte-identical to PR #140's artifacts/isola/charters/pending/NEW-5c3277f0-BUSINESS.md
// -- the actual owner-reviewable draft, not a stand-in string.
const REAL_EPIC_BUSINESS_MD = readFileSync(
  path.join(__dirname, "fixtures", "epic-5c3277f0-BUSINESS.md"),
  "utf-8",
);

function invokeBody(agentId: string, runId: string) {
  return {
    templateId: PUBLIC_TEMPLATE,
    exposure: "PUBLIC",
    agentId,
    runId,
    responseMode: "inline",
    context: {
      issueId: `ISSUE-${runId}`,
      message: { role: "customer", content: "what do you offer, and how do I reach you?" },
    },
  };
}

describe("real EPIC BUSINESS.md draft (PR #140) through the identity-gated path for 5c3277f0", () => {
  it("reaches only 5c3277f0's own honest call for a real customer question, and never leaks to an impersonator", async () => {
    const TARGET_SECRET = placeholder("5c3277f0-caller");
    const OTHER_SECRET = placeholder("other-shared-template-caller");
    const logger = new CapturingLogger();
    const model = StubModelClient.returning(
      "We offer internet, VoIP and WhatsApp support. Reach us at +1 767 818 0001.",
    );

    server = await startServer({
      config: envConfig({
        PAPERCLIP_BASE_URL: "https://paperclip.example.test",
        PAPERCLIP_BOARD_TOKEN: BOARD_TOKEN,
        PAPERCLIP_INSTRUCTIONS_MAP: JSON.stringify({
          [PUBLIC_TEMPLATE]: "dddddddd-0000-4000-8000-000000000001",
        }),
        PAPERCLIP_BUSINESS_FACTS_MAP: JSON.stringify({
          [REAL_TARGET_AGENT]: PUBLIC_TEMPLATE,
          [OTHER_SHARED_TEMPLATE_AGENT]: PUBLIC_TEMPLATE,
        }),
        PAPERCLIP_AGENT_CALLER_SECRETS: JSON.stringify({
          [REAL_TARGET_AGENT]: TARGET_SECRET,
          [OTHER_SHARED_TEMPLATE_AGENT]: OTHER_SECRET,
        }),
      }),
      logger: logger.logger,
      modelClient: model,
      // MOCKED Paperclip API -- in-memory stub, no network call.
      safeFetch: async (input: string | URL): Promise<Response> => {
        const url = String(input);
        const jsonRes = (body: unknown, status = 200) =>
          new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
        if (url.includes("path=AGENTS.md")) return jsonRes({ content: AGENTS_MD });
        if (url.includes("path=BUSINESS.md")) {
          const match = url.match(/\/agents\/([^/]+)\/instructions-bundle/);
          const agentId = match?.[1] ? decodeURIComponent(match[1]) : "";
          if (agentId === REAL_TARGET_AGENT) return jsonRes({ content: REAL_EPIC_BUSINESS_MD });
          if (agentId === OTHER_SHARED_TEMPLATE_AGENT) return jsonRes({ content: OTHER_FACTS });
          return jsonRes({ error: "not found" }, 404);
        }
        return jsonRes({ ok: true });
      },
    });

    // HONEST PATH: 5c3277f0's own caller secret, honestly naming itself, asks a real
    // customer question. The composed system prompt must contain the REAL sourced
    // facts from the actual owner-reviewable draft.
    const honest = await invoke(server!.url, {
      bearer: TARGET_SECRET,
      body: invokeBody(REAL_TARGET_AGENT, "real-honest"),
    });
    expect(honest.status).toBe(200);
    const honestPrompt = model.calls[0]?.messages.find((m) => m.role === "system")?.content ?? "";
    expect(honestPrompt).toContain("EPIC Communications Inc");
    expect(honestPrompt).toContain("Roseau, Dominica");
    expect(honestPrompt).toContain("Internet connectivity");
    expect(honestPrompt).toContain("VoIP / telephony");
    expect(honestPrompt).toContain("+1 767 818 0001");
    // Provenance discipline survives the trip: the SOURCED/INFERRED labels and the
    // "do not invent a figure" guard are literally present, not summarized away.
    expect(honestPrompt).toContain("SOURCED");
    expect(honestPrompt).toContain("INFERRED");
    expect(honestPrompt).toContain("do not invent a figure");

    // IMPERSONATION 1: the plain shared PUBLIC bearer claims to be 5c3277f0.
    const bypassClaim = await invoke(server!.url, {
      bearer: PUBLIC_SECRET,
      body: invokeBody(REAL_TARGET_AGENT, "real-bypass"),
    });
    expect(bypassClaim.status).toBe(200);
    const bypassPrompt = model.calls[1]?.messages.find((m) => m.role === "system")?.content ?? "";
    expect(bypassPrompt).not.toContain("EPIC Communications Inc");
    expect(bypassPrompt).not.toContain("+1 767 818 0001");

    // IMPERSONATION 2: a different agent sharing the same template, with its OWN real
    // working credential, claims to be 5c3277f0 -- the exact original exploit shape
    // PR139's cd13db9 correction closes.
    const crossAgent = await invoke(server!.url, {
      bearer: OTHER_SECRET,
      body: invokeBody(REAL_TARGET_AGENT, "real-cross-agent"),
    });
    expect(crossAgent.status).toBe(200);
    const crossPrompt = model.calls[2]?.messages.find((m) => m.role === "system")?.content ?? "";
    expect(crossPrompt).not.toContain("EPIC Communications Inc");
    expect(crossPrompt).not.toContain(OTHER_FACTS);

    // ISOLATION, the other direction: the other tenant's own honest call still works
    // and never sees EPIC's facts.
    const otherHonest = await invoke(server!.url, {
      bearer: OTHER_SECRET,
      body: invokeBody(OTHER_SHARED_TEMPLATE_AGENT, "real-other-honest"),
    });
    expect(otherHonest.status).toBe(200);
    const otherHonestPrompt = model.calls[3]?.messages.find((m) => m.role === "system")?.content ?? "";
    expect(otherHonestPrompt).toContain(OTHER_FACTS);
    expect(otherHonestPrompt).not.toContain("EPIC Communications Inc");
  });
});
