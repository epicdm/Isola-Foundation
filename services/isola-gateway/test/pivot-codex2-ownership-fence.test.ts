/**
 * CODEX FIX ROUND 2 (review of 9799a84): R3 — the ownership authority goes STALE.
 *   ALL TESTS HERE ARE SOCKET-FREE (the pipeline runs against the gateway's own fakes),
 *   so a sandbox that cannot bind a loopback port can run them.
 *
 * What Codex demonstrated, and what the existing `pivot-inflight-takeover` suite
 * missed (sabotaging the post-scope recheck still passed 14/14 there):
 *
 *   1. verified scope + a passing ownership recheck, then a human takes the
 *      conversation DURING `readTurnHistory()`: the runtime still ran, and with the
 *      Paperclip runtime a Paperclip issue was CREATED for a conversation a person held;
 *   2. the runtime returns `request_human`, the post-run recheck passes, a human takes
 *      the conversation while the reply is being posted: the private note, the status
 *      change, the team assignment, the label write and the attribute write ALL still
 *      happened;
 *   3. the same for a takeover BETWEEN the escalation's own writes, and for the plain
 *      "replied" label/attribute annotation.
 *
 * The window is not "one network round trip": a reply plus its annotations is up to
 * five HTTP operations, an escalation up to seven. The contract pinned here: ownership
 * is re-read immediately BEFORE the runtime call and immediately BEFORE EACH write
 * (reply, note, status, assignment, labels, attributes, acknowledgement), and a
 * conversation a person holds receives none of the remaining writes. What no re-read
 * can remove is the final read-to-send interval of the single write in flight: the
 * tests assert that one write (the reply that was already being posted) is the ONLY
 * thing that lands.
 *
 * Laws 11/19/23/28: every "did not happen" test has its positive twin in the same
 * harness (the very same flow with no takeover DOES perform every write), and the
 * mid-flow takeover is proven to have taken effect.
 */
import { describe, expect, it } from "vitest";

import { bindingIdentity } from "../src/deliveryref.js";
import { DISARMED } from "../src/failpoint.js";
import type { ChatwootTarget } from "../src/chatwoot.js";
import type { ConversationRef } from "../src/ownership.js";
import { inMemoryIssueStore, PaperclipAgentRuntime } from "../src/paperclip-runtime.js";
import { processDelivery, type DeliveryJob, type PipelineDeps } from "../src/pipeline.js";
import type { AgentRuntimeResult } from "../src/runtime.js";
import { parseWebhookPayload } from "../src/webhook.js";
import {
  ACCOUNT_ID,
  attachmentOnlyPayload,
  CONVERSATION_DISPLAY_ID,
  CapturingLogger,
  envConfig,
  FakeLedger,
  INBOX_ID,
  InMemoryOwnershipGate,
  makeBinding,
  messageCreatedPayload,
  StubAgentRuntime,
  StubChatwootApi,
  TENANT_ID,
} from "./harness.js";

const REF: ConversationRef = {
  tenantId: TENANT_ID,
  chatwootAccountId: ACCOUNT_ID,
  chatwootConversationId: CONVERSATION_DISPLAY_ID,
};
const TEAM_ID = 9;
const BEARER = ["not", "a", "real", "credential", "paperclip", "0".repeat(16)].join("-");

function makeJob(mode: "answer" | "handoff" = "answer"): DeliveryJob {
  const binding = makeBinding({ escalationTeamId: TEAM_ID });
  const payloadBody = mode === "handoff" ? attachmentOnlyPayload(["image"]) : messageCreatedPayload();
  return {
    correlationId: "corr-fence",
    deliveryId: "delivery-fence-1",
    identity: {
      tenantId: TENANT_ID,
      bindingId: bindingIdentity(binding),
      chatwootAccountId: ACCOUNT_ID,
      chatwootInboxId: INBOX_ID,
      eventId: "delivery:fence-1",
    },
    digest: "digest-fence-1",
    binding,
    payload: parseWebhookPayload(Buffer.from(JSON.stringify(payloadBody)))!,
    conversationId: CONVERSATION_DISPLAY_ID,
    startedAtMs: 0,
    mode,
    classification:
      mode === "handoff"
        ? { reason: "attachment_or_unsupported_content", attachmentCount: 1, attachmentTypes: ["image"], contentType: "text" }
        : null,
  };
}

const REPLY: AgentRuntimeResult = {
  text: "Here is your answer.",
  action: null,
  actionUnrecognised: false,
  actionReason: null,
  outcome: "ok",
  correlationId: "runtime-correlation-id",
  completionState: "completed",
  contractVersion: 1,
};
const REQUEST_HUMAN: AgentRuntimeResult = {
  ...REPLY,
  text: "I am bringing in a colleague.",
  action: "request_human",
  actionReason: "explicit_human_request",
  contractVersion: 2,
};

/** A Chatwoot double that lets a test act as the human AT a chosen point of the writes. */
class HookedChatwoot extends StubChatwootApi {
  afterCustomerMessage: (() => Promise<void>) | null = null;
  afterPrivateNote: (() => Promise<void>) | null = null;
  afterOpen: (() => Promise<void>) | null = null;
  afterAssign: (() => Promise<void>) | null = null;
  override async postMessage(
    target: ChatwootTarget,
    content: string,
    isPrivate: boolean,
    deliveryRef?: string,
  ): Promise<number | null> {
    const id = await super.postMessage(target, content, isPrivate, deliveryRef);
    await (isPrivate ? this.afterPrivateNote : this.afterCustomerMessage)?.();
    return id;
  }
  override async openConversation(target: ChatwootTarget): Promise<void> {
    await super.openConversation(target);
    await this.afterOpen?.();
  }
  override async assignTeam(target: ChatwootTarget, teamId: number): Promise<void> {
    await super.assignTeam(target, teamId);
    await this.afterAssign?.();
  }
}

function makeDeps(overrides: Partial<PipelineDeps> = {}) {
  const chatwoot = (overrides.chatwoot as HookedChatwoot | undefined) ?? new HookedChatwoot();
  const capture = new CapturingLogger();
  const ledger = new FakeLedger();
  const ownership = (overrides.ownership as InMemoryOwnershipGate | undefined) ?? new InMemoryOwnershipGate();
  const runtime = (overrides.runtime as StubAgentRuntime | undefined) ?? StubAgentRuntime.answering(REPLY.text as string);
  const deps: PipelineDeps = {
    config: envConfig(),
    chatwoot,
    runtime,
    logger: capture.logger,
    ledger,
    ownership,
    failpoint: DISARMED,
    now: () => 0,
    ...overrides,
  };
  return { deps, chatwoot: chatwoot as HookedChatwoot, ownership, capture, ledger, runtime };
}

/** The human takes the conversation NOW: a state that suppresses the AI, in the CURRENT episode. */
async function humanTakesOver(ownership: InMemoryOwnershipGate): Promise<void> {
  const current = await ownership.read(REF);
  ownership.seed(REF, "HUMAN_OWNED", current.episode);
}

const WRITE_KINDS = new Set(["message", "toggle_status", "assignment", "labels_write", "attributes_write"]);
function writes(chatwoot: StubChatwootApi): string[] {
  return chatwoot.calls
    .filter((c) => WRITE_KINDS.has(c.kind))
    .map((c) => `${c.kind}${c.private === true ? ":private" : ""}`);
}

async function reserve(ledger: FakeLedger, job: DeliveryJob): Promise<void> {
  await ledger.reserve({
    identity: job.identity,
    digest: job.digest,
    correlationId: job.correlationId,
    conversationId: job.conversationId,
    messageId: job.payload.messageId,
    mode: job.mode,
    leaseMs: 60_000,
  });
}

const FULL_ESCALATION = ["message", "message:private", "toggle_status", "assignment", "labels_write", "attributes_write"];

describe("CONTROLS: the harness can produce every write the takeover tests forbid", () => {
  it("CONTROL: a request_human turn with NO takeover performs the full sequence (reply, note, status, assignment, labels, attributes)", async () => {
    const { deps, chatwoot } = makeDeps({ runtime: new StubAgentRuntime(async () => REQUEST_HUMAN) });
    const result = await processDelivery(deps, makeJob());
    expect(result.escalated).toBe(true);
    for (const kind of FULL_ESCALATION) expect(writes(chatwoot)).toContain(kind);
  });

  it("CONTROL: a plain reply with NO takeover posts the reply AND the 'answered' label and attributes", async () => {
    const { deps, chatwoot } = makeDeps();
    const result = await processDelivery(deps, makeJob());
    expect(result.outcome).toBe("replied");
    expect(writes(chatwoot)).toEqual(["message", "labels_write", "attributes_write"]);
  });

  it("CONTROL: the mid-flow takeover provably takes effect (the store reads HUMAN_OWNED afterwards)", async () => {
    const { deps, chatwoot, ownership } = makeDeps();
    chatwoot.afterCustomerMessage = () => humanTakesOver(ownership);
    await processDelivery(deps, makeJob());
    expect((await ownership.read(REF)).state).toBe("HUMAN_OWNED");
  });
});

describe("R3.1: a takeover DURING readTurnHistory() must not reach the runtime", () => {
  /** A turn store whose read IS the moment the human acts. */
  function takeoverDuringHistory(ownership: InMemoryOwnershipGate) {
    return {
      query: async () => {
        await humanTakesOver(ownership);
        return { rows: [] };
      },
    } as unknown as PipelineDeps["turnStore"];
  }

  it("the runtime is NOT called, nothing is written, the delivery ends suppressed_in_flight and its row is closed", async () => {
    const ownership = new InMemoryOwnershipGate();
    const { deps, chatwoot, runtime, ledger } = makeDeps({ ownership, turnStore: takeoverDuringHistory(ownership) });
    const job = makeJob();
    await reserve(ledger, job);

    const result = await processDelivery(deps, job);

    expect((await ownership.read(REF)).state).toBe("HUMAN_OWNED"); // the takeover happened
    expect(runtime.requests, "the model was invoked for a conversation a person had just taken").toHaveLength(0);
    expect(result.outcome).toBe("suppressed_in_flight");
    expect(writes(chatwoot)).toEqual([]);
    expect([...ledger.rows.values()].map((r) => r.state)).toEqual(["completed"]);
  });

  it("CONTROL: the same history read with NO takeover reaches the runtime exactly once and replies", async () => {
    const ownership = new InMemoryOwnershipGate();
    const store = { query: async () => ({ rows: [] }) } as unknown as PipelineDeps["turnStore"];
    const { deps, runtime, chatwoot } = makeDeps({ ownership, turnStore: store });
    const result = await processDelivery(deps, makeJob());
    expect(runtime.requests).toHaveLength(1);
    expect(result.outcome).toBe("replied");
    expect(chatwoot.customerMessages).toHaveLength(1);
  });

  it("with the PAPERCLIP runtime: NO issue is created after the takeover (Codex demonstrated a create)", async () => {
    const creates: string[] = [];
    const paperclip = (): PaperclipAgentRuntime =>
      new PaperclipAgentRuntime({
        baseUrl: "https://paperclip.example.test",
        companyId: "company-1",
        auth: { headers: () => ({ authorization: `Bearer ${BEARER}` }) },
        safeFetch: async (input, init) => {
          const url = String(input);
          if ((init?.method ?? "GET").toUpperCase() === "POST" && url.endsWith("/issues")) {
            creates.push(url);
            return new Response(JSON.stringify({ id: "iss-1" }), { status: 201 });
          }
          return new Response(
            JSON.stringify([
              { id: "c1", body: JSON.stringify({ isola: 1, disposition: "reply", text: "ok" }), authorAgentId: "agent-1" },
            ]),
            { status: 200 },
          );
        },
        issueStore: inMemoryIssueStore(),
        pollDeadlineMs: 2_000,
        pollIntervalMs: 10,
        requestTimeoutMs: 1_000,
      });

    // CONTROL first, in the same harness: with no takeover exactly one issue IS created.
    const control = makeDeps({
      turnStore: { query: async () => ({ rows: [] }) } as unknown as PipelineDeps["turnStore"],
      runtime: paperclip() as unknown as StubAgentRuntime,
    });
    await processDelivery(control.deps, makeJob());
    expect(creates).toHaveLength(1);

    creates.length = 0;
    const ownership = new InMemoryOwnershipGate();
    const { deps } = makeDeps({
      ownership,
      turnStore: takeoverDuringHistory(ownership),
      runtime: paperclip() as unknown as StubAgentRuntime,
    });
    const result = await processDelivery(deps, makeJob());
    expect(creates, "a Paperclip issue was created for a conversation a person held").toHaveLength(0);
    expect(result.outcome).toBe("suppressed_in_flight");
  });
});

describe("R3.2: a takeover while the REPLY is being posted stops every later write", () => {
  it("request_human: the reply (already in flight) lands; the note, status, assignment, labels and attributes DO NOT", async () => {
    const { deps, chatwoot, ownership } = makeDeps({ runtime: new StubAgentRuntime(async () => REQUEST_HUMAN) });
    chatwoot.afterCustomerMessage = () => humanTakesOver(ownership);

    await processDelivery(deps, makeJob());

    expect((await ownership.read(REF)).state).toBe("HUMAN_OWNED");
    // The ONE write that was already in flight is the only thing that lands.
    expect(writes(chatwoot)).toEqual(["message"]);
  });

  it("a plain reply: the 'answered' label and the attributes are NOT written onto a conversation a person now holds", async () => {
    const { deps, chatwoot, ownership } = makeDeps();
    chatwoot.afterCustomerMessage = () => humanTakesOver(ownership);

    await processDelivery(deps, makeJob());

    expect(writes(chatwoot)).toEqual(["message"]);
  });

  it("a runtime FAILURE escalation: a takeover during the (failed-turn) path writes nothing at all", async () => {
    const ownership = new InMemoryOwnershipGate();
    const { deps, chatwoot } = makeDeps({ ownership, runtime: StubAgentRuntime.failing("provider_error") });
    // The human acts the moment the escalation begins to publish (the private note is
    // the first Chatwoot write of the failure path).
    chatwoot.afterPrivateNote = () => humanTakesOver(ownership);

    await processDelivery(deps, makeJob());

    expect(writes(chatwoot)).toEqual(["message:private"]);
  });
});

describe("R3.3: a takeover BETWEEN the escalation's own writes stops the rest", () => {
  it("after the private note: no status change, no assignment, no labels, no attributes", async () => {
    const { deps, chatwoot, ownership } = makeDeps({ runtime: new StubAgentRuntime(async () => REQUEST_HUMAN) });
    chatwoot.afterPrivateNote = () => humanTakesOver(ownership);

    await processDelivery(deps, makeJob());

    expect(writes(chatwoot)).toEqual(["message", "message:private"]);
  });

  it("after the status change: no assignment (it would override the person who just took it), no labels, no attributes", async () => {
    const { deps, chatwoot, ownership } = makeDeps({ runtime: new StubAgentRuntime(async () => REQUEST_HUMAN) });
    chatwoot.afterOpen = () => humanTakesOver(ownership);

    await processDelivery(deps, makeJob());

    expect(writes(chatwoot)).toEqual(["message", "message:private", "toggle_status"]);
  });

  it("after the assignment: no labels, no attributes", async () => {
    const { deps, chatwoot, ownership } = makeDeps({ runtime: new StubAgentRuntime(async () => REQUEST_HUMAN) });
    chatwoot.afterAssign = () => humanTakesOver(ownership);

    await processDelivery(deps, makeJob());

    expect(writes(chatwoot)).toEqual(["message", "message:private", "toggle_status", "assignment"]);
  });

  it("the delivery is CLOSED (suppressed), not left for a sweeper to re-run into a held conversation", async () => {
    const { deps, chatwoot, ownership, ledger } = makeDeps({ runtime: new StubAgentRuntime(async () => REQUEST_HUMAN) });
    chatwoot.afterOpen = () => humanTakesOver(ownership);
    const job = makeJob();
    await reserve(ledger, job);

    const result = await processDelivery(deps, job);

    expect(result.needsRetry).toBe(false);
    // no row is left in progress: the delivery and every write it claimed are resolved
    expect([...ledger.rows.values()].every((r) => r.state === "completed" || r.state === "failed")).toBe(true);
    ledger.expireAllLeases();
    expect(await ledger.dueForRecovery(10)).toHaveLength(0);
  });
});

describe("R3.5: a takeover DURING customer-scope resolution (socket-free twin of Codex round 1's D5 route test)", () => {
  const SUBJECT = "+17675550101";
  /** A signed sender bound to the channel, so the resolver is actually consulted. */
  function scopedJob(): DeliveryJob {
    const job = makeJob();
    return {
      ...job,
      payload: parseWebhookPayload(
        Buffer.from(
          JSON.stringify(
            messageCreatedPayload({
              content: "my invoice 348 says unpaid",
              sender: { type: "contact", id: 55, phone_number: SUBJECT },
              conversation: {
                id: CONVERSATION_DISPLAY_ID,
                status: "pending",
                meta: { assignee: null },
                contact_inbox: { id: 9, contact_id: 55, inbox_id: INBOX_ID, source_id: SUBJECT },
              },
            }),
          ),
        ),
      )!,
    };
  }
  const verified = { kind: "verified" as const, customerId: "cust-a", serviceIds: ["svc-1"] };
  const resolverFor = (
    verdict: { kind: "unresolved" } | typeof verified,
    ownership: InMemoryOwnershipGate | null,
  ) => ({
    resolve: async () => {
      if (ownership !== null) await humanTakesOver(ownership);
      return verdict;
    },
  });

  it("CONTROL: with no takeover an UNRESOLVED sender is escalated (note, status, assignment) and a VERIFIED one reaches the runtime", async () => {
    const unresolved = makeDeps({ customerScope: resolverFor({ kind: "unresolved" }, null) });
    await processDelivery(unresolved.deps, scopedJob());
    expect(writes(unresolved.chatwoot)).toContain("message:private");
    expect(writes(unresolved.chatwoot)).toContain("toggle_status");

    const ok = makeDeps({ customerScope: resolverFor(verified, null) });
    await processDelivery(ok.deps, scopedJob());
    expect(ok.runtime.requests).toHaveLength(1);
  });

  it("UNRESOLVED + a takeover while resolving: no note, no status change, no assignment, no labels, no attributes", async () => {
    const ownership = new InMemoryOwnershipGate();
    const { deps, chatwoot, runtime } = makeDeps({ ownership, customerScope: resolverFor({ kind: "unresolved" }, ownership) });
    const result = await processDelivery(deps, scopedJob());
    expect((await ownership.read(REF)).state).toBe("HUMAN_OWNED");
    expect(writes(chatwoot)).toEqual([]);
    expect(runtime.requests).toHaveLength(0);
    expect(result.outcome).toBe("suppressed_in_flight");
  });

  it("VERIFIED + a takeover while resolving: the model is NOT called and nothing is written", async () => {
    const ownership = new InMemoryOwnershipGate();
    const { deps, chatwoot, runtime } = makeDeps({ ownership, customerScope: resolverFor(verified, ownership) });
    const result = await processDelivery(deps, scopedJob());
    expect(runtime.requests).toHaveLength(0);
    expect(writes(chatwoot)).toEqual([]);
    expect(result.outcome).toBe("suppressed_in_flight");
  });
});

describe("R3.4: the NO-TEXT handoff path is fenced too", () => {
  it("CONTROL: a handoff with no takeover opens, assigns, notes and acknowledges", async () => {
    const { deps, chatwoot } = makeDeps();
    const result = await processDelivery(deps, makeJob("handoff"));
    expect(result.outcome).toBe("handed_off");
    for (const kind of ["toggle_status", "assignment", "message:private", "message"]) expect(writes(chatwoot)).toContain(kind);
  });

  it("a takeover after the status change: no assignment, no note, no acknowledgement to the customer, no labels or attributes", async () => {
    const { deps, chatwoot, ownership } = makeDeps();
    chatwoot.afterOpen = () => humanTakesOver(ownership);

    await processDelivery(deps, makeJob("handoff"));

    expect(writes(chatwoot)).toEqual(["toggle_status"]);
  });

  it("a takeover after the private note: the customer is NOT told 'a team member has this' by the bot", async () => {
    const { deps, chatwoot, ownership } = makeDeps();
    chatwoot.afterPrivateNote = () => humanTakesOver(ownership);

    await processDelivery(deps, makeJob("handoff"));

    expect(chatwoot.customerMessages).toHaveLength(0);
  });
});
