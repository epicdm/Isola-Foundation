/**
 * CODEX FIX ROUND 1 (review of 92ddc6c): D3 + D6.
 *
 *   D3 (P1)  the global GATEWAY_PAPERCLIP_COMPANY_ID overrode the binding's own
 *            paperclipCompanyId with no refusal: a company-B customer's scope was
 *            sent to /api/companies/<company-A>/issues. DECISION: the gateway
 *            REFUSES. Boot refuses when any ENABLED binding declares a different
 *            company, and — as defence in depth — the runtime itself refuses to send
 *            a turn whose context company is not the configured one. Refusing is
 *            safer than "the binding wins": one gateway process then talks to
 *            exactly one Paperclip company, and a mismatch is a loud config defect,
 *            never a quiet re-route of a customer's data.
 *   D6 (P2)  an ftp:// base URL, or a base URL whose host is excluded by an explicit
 *            EGRESS_ALLOWLIST, booted fine and then failed every turn after startup
 *            (and was mis-reported as an UNCERTAIN create). Boot now refuses both,
 *            and an egress block is a config defect, not an uncertain send.
 *
 * Tested ONLY against the local STUB Paperclip; every refusal has its positive twin
 * in the same harness (Laws 11, 19, 23, 28). The assembled-gateway test goes through
 * the REAL production assembly in createGateway (no injected runtime), Law 20.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createGateway } from "../src/app.js";
import { bootErrors, loadConfig, type GatewayConfig } from "../src/config.js";
import { EgressBlockedError } from "../src/errors.js";
import { inMemoryIssueStore, PAPERCLIP_OUTCOMES, PaperclipAgentRuntime } from "../src/paperclip-runtime.js";
import type { AgentRuntimeRequest } from "../src/runtime.js";
import {
  BASE_ENV,
  bindingsJson,
  CUSTOMER_MESSAGE,
  FakeLedger,
  InMemoryOwnershipGate,
  makeBinding,
  postWebhook,
  signRequest,
  StubChatwootApi,
} from "./harness.js";
import { StubPaperclip } from "./paperclip-stub.js";

const BEARER = ["not", "a", "real", "credential", "paperclip", "0".repeat(16)].join("-");
const DELIVERY = "11111111-2222-3333-4444-555555555555";
const KEY = "isolagw:tenant-acme|binding-1|1|7|delivery:abc-123|answer";
const ANSWER = { isola: 1, disposition: "reply", text: "Here is your answer from Paperclip." };

const enabledEnv = {
  GATEWAY_PAPERCLIP_AGENT_IDS: "agent-1",
  GATEWAY_PAPERCLIP_BASE_URL: "https://paperclip.example.test",
  GATEWAY_PAPERCLIP_COMPANY_ID: "company-1",
  GATEWAY_PAPERCLIP_BEARER: BEARER,
};
const cfg = (extra: Record<string, string> = {}): GatewayConfig =>
  loadConfig({ ...BASE_ENV, ...enabledEnv, ...extra });
const withBindingCompany = (company: string, agent = "agent-1"): Record<string, string> => ({
  GATEWAY_BINDINGS_JSON: bindingsJson([makeBinding({ paperclipCompanyId: company, paperclipAgentId: agent })]),
});

describe("D3 (boot): an enabled binding in another Paperclip company REFUSES to boot", () => {
  it("CONTROL: the binding's company equals GATEWAY_PAPERCLIP_COMPANY_ID -> boots", () => {
    expect(bootErrors(cfg(withBindingCompany("company-1")))).toEqual([]);
  });

  it("REFUSES: the binding declares company-b, the gateway is configured for company-1 (Codex probe: bootErrors() was [])", () => {
    const errors = bootErrors(cfg(withBindingCompany("company-b")));
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors.join(" ")).toContain("GATEWAY_PAPERCLIP_COMPANY_ID");
    expect(errors.join(" ")).not.toContain(BEARER);
  });

  it("CONTROL for the scope of the rule: a binding in another company whose employee is NOT enabled for Paperclip is irrelevant", () => {
    expect(bootErrors(cfg(withBindingCompany("company-b", "some-other-agent")))).toEqual([]);
  });

  it("CONTROL: with the Paperclip path OFF a company mismatch is not a boot concern at all (default OFF is untouched)", () => {
    const off = loadConfig({ ...BASE_ENV, ...withBindingCompany("company-b") });
    expect(off.paperclip.agentIds).toEqual([]);
    expect(bootErrors(off)).toEqual([]);
  });
});

describe("D3 (runtime): a turn for another company is NEVER sent", () => {
  let stub: StubPaperclip;
  beforeEach(async () => {
    stub = new StubPaperclip();
    await stub.start();
  });
  afterEach(async () => {
    await stub.stop();
  });

  function runtimeFor(companyId: string): PaperclipAgentRuntime {
    return new PaperclipAgentRuntime({
      baseUrl: stub.url,
      companyId,
      auth: { headers: () => ({ authorization: `Bearer ${BEARER}` }) },
      safeFetch: async (input, init) => fetch(input, init),
      issueStore: inMemoryIssueStore(),
      pollDeadlineMs: 800,
      pollIntervalMs: 15,
      requestTimeoutMs: 300,
    });
  }
  function request(contextCompany: string | undefined): AgentRuntimeRequest {
    return {
      templateId: "tpl@v1",
      exposure: "PUBLIC",
      agentId: "agent-1",
      runId: "delivery-1",
      idempotencyKey: KEY,
      context: {
        source: "chatwoot",
        ...(contextCompany === undefined ? {} : { companyId: contextCompany }),
        customerScope: { kind: "verified", customerId: "cust-b", serviceIds: ["svc-b"] },
        chatwoot: { accountId: 1, inboxId: 7, conversationDisplayId: 42, messageId: 9001 },
        message: { role: "customer", content: "What does the 600 minute plan cost?" },
      },
    };
  }

  it("CONTROL: the turn's company equals the configured company -> the issue is created under that company and answered", async () => {
    stub.replyOnCreate(ANSWER);
    const result = await runtimeFor("company-1").invoke(request("company-1"));
    expect(result.outcome).toBe("ok");
    expect(stub.creates).toHaveLength(1);
    expect(stub.creates[0]!.url).toContain("/api/companies/company-1/issues");
  });

  it("REFUSES: a company-b turn on a gateway configured for company-1 -> config defect and ZERO requests reach Paperclip", async () => {
    stub.replyOnCreate(ANSWER);
    const result = await runtimeFor("company-1").invoke(request("company-b"));
    expect(result.outcome).toBe(PAPERCLIP_OUTCOMES.configDefect);
    expect(result.text).toBeNull();
    expect(stub.log).toHaveLength(0);
  });

  it("REFUSES (fail closed): a turn that does not say which company it is for cannot be verified -> config defect, nothing sent", async () => {
    stub.replyOnCreate(ANSWER);
    const result = await runtimeFor("company-1").invoke(request(undefined));
    expect(result.outcome).toBe(PAPERCLIP_OUTCOMES.configDefect);
    expect(stub.log).toHaveLength(0);
  });
});

describe("D3 (assembled gateway, Law 20): signed webhook -> REAL production assembly -> stub Paperclip", () => {
  let stub: StubPaperclip;
  beforeEach(async () => {
    stub = new StubPaperclip();
    await stub.start();
  });
  afterEach(async () => {
    await stub.stop();
  });

  async function assembled(bindingCompany: string): Promise<{
    url: string;
    chatwoot: StubChatwootApi;
    drain: () => Promise<void>;
    close: () => Promise<void>;
  }> {
    const config = cfg({
      GATEWAY_PAPERCLIP_BASE_URL: stub.url,
      GATEWAY_PAPERCLIP_COMPANY_ID: "company-1",
      ...withBindingCompany(bindingCompany),
    });
    const chatwoot = new StubChatwootApi();
    // NO `runtime` dependency: the runtime is built by createGateway from the config.
    const gateway = createGateway({
      config,
      chatwoot,
      ledger: new FakeLedger(),
      ownership: new InMemoryOwnershipGate(),
      safeFetch: async (input, init) => fetch(input, init),
    });
    const server: Server = createServer(gateway.handler);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    return {
      url: `http://127.0.0.1:${address.port}`,
      chatwoot,
      drain: () => gateway.drain(),
      close: async () => {
        await gateway.drain();
        await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
      },
    };
  }

  it("CONTROL: binding and gateway agree on company-1 -> one issue under company-1, one reply", async () => {
    stub.replyOnCreate(ANSWER);
    const gw = await assembled("company-1");
    try {
      const res = await postWebhook(gw.url, signRequest({ deliveryId: DELIVERY }));
      expect(res.status).toBe(200);
      await gw.drain();
      expect(stub.creates).toHaveLength(1);
      expect(stub.creates[0]!.url).toContain("/api/companies/company-1/issues");
      expect(gw.chatwoot.customerMessages).toHaveLength(1);
    } finally {
      await gw.close();
    }
  });

  it("MISMATCH (boot checks bypassed on purpose): the company-b turn reaches NO Paperclip company and the customer gets no AI message", async () => {
    stub.replyOnCreate(ANSWER);
    const gw = await assembled("company-b");
    try {
      await postWebhook(gw.url, signRequest({ deliveryId: DELIVERY }));
      await gw.drain();
      expect(stub.log, "company-b data was sent to a Paperclip company").toHaveLength(0);
      expect(gw.chatwoot.customerMessages).toHaveLength(0);
      expect(CUSTOMER_MESSAGE.length).toBeGreaterThan(0);
    } finally {
      await gw.close();
    }
  });
});

describe("D6 (boot): an unusable Paperclip destination REFUSES to boot", () => {
  it("CONTROL: https and plain http (container network) base URLs boot", () => {
    expect(bootErrors(cfg({ GATEWAY_PAPERCLIP_BASE_URL: "https://paperclip.example.test" }))).toEqual([]);
    expect(bootErrors(cfg({ GATEWAY_PAPERCLIP_BASE_URL: "http://isola_ai:3100" }))).toEqual([]);
  });

  it.each(["ftp://paperclip.example.test", "file://paperclip.example.test/x", "ws://paperclip.example.test"])(
    "REFUSES the scheme in %s (safeFetch blocks everything but http/https)",
    (url) => {
      const errors = bootErrors(cfg({ GATEWAY_PAPERCLIP_BASE_URL: url }));
      expect(errors.length).toBeGreaterThanOrEqual(1);
      expect(errors.join(" ")).toContain("GATEWAY_PAPERCLIP_BASE_URL");
    },
  );

  it("CONTROL: an explicit EGRESS_ALLOWLIST that INCLUDES the Paperclip host boots", () => {
    const errors = bootErrors(
      cfg({ EGRESS_ALLOWLIST: "chatwoot.example.test,isola_isola-runtime,paperclip.example.test" }),
    );
    expect(errors).toEqual([]);
  });

  it("REFUSES: an explicit EGRESS_ALLOWLIST that EXCLUDES the Paperclip host (every request would be blocked after boot)", () => {
    const errors = bootErrors(cfg({ EGRESS_ALLOWLIST: "chatwoot.example.test,isola_isola-runtime" }));
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors.join(" ")).toContain("EGRESS_ALLOWLIST");
    expect(errors.join(" ")).not.toContain(BEARER);
  });

  it("CONTROL: with the Paperclip path OFF an allowlist that omits the host is irrelevant", () => {
    const off = loadConfig({ ...BASE_ENV, EGRESS_ALLOWLIST: "chatwoot.example.test,isola_isola-runtime" });
    expect(bootErrors(off)).toEqual([]);
  });
});

describe("D6 (runtime): an egress block is a CONFIG DEFECT (nothing left the process), not an uncertain create", () => {
  function runtimeWith(safeFetch: (input: string | URL, init?: RequestInit) => Promise<Response>) {
    const store = inMemoryIssueStore();
    return {
      store,
      runtime: new PaperclipAgentRuntime({
        baseUrl: "https://paperclip.example.test",
        companyId: "company-1",
        auth: { headers: () => ({ authorization: `Bearer ${BEARER}` }) },
        safeFetch,
        issueStore: store,
        pollDeadlineMs: 500,
        pollIntervalMs: 15,
        requestTimeoutMs: 200,
      }),
    };
  }
  const req = (): AgentRuntimeRequest => ({
    templateId: "tpl@v1",
    exposure: "PUBLIC",
    agentId: "agent-1",
    runId: "delivery-1",
    idempotencyKey: KEY,
    context: {
      source: "chatwoot",
      companyId: "company-1",
      customerScope: { kind: "verified", customerId: "cust-a", serviceIds: ["svc-1"] },
      chatwoot: { accountId: 1, inboxId: 7, conversationDisplayId: 42, messageId: 9001 },
      message: { role: "customer", content: "hello" },
    },
  });

  it("an EgressBlockedError on create -> paperclip_config_defect and NOT remembered as uncertain", async () => {
    const { runtime, store } = runtimeWith(async () => {
      throw new EgressBlockedError("paperclip.example.test");
    });
    const result = await runtime.invoke(req());
    expect(result.outcome).toBe(PAPERCLIP_OUTCOMES.configDefect);
    expect(await store.isUncertain(KEY)).toBe(false);
  });

  it("CONTROL: a genuine transport failure on create is still an UNCERTAIN create (the send may have happened)", async () => {
    const { runtime, store } = runtimeWith(async () => {
      throw new TypeError("fetch failed");
    });
    const result = await runtime.invoke(req());
    expect(result.outcome).toBe(PAPERCLIP_OUTCOMES.createUncertain);
    expect(await store.isUncertain(KEY)).toBe(true);
  });
});
