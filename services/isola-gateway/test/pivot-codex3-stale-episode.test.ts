/**
 * CODEX ROUND 3 (review of 1eb7ba3): F5 — escalation ADOPTS a newer ownership episode.
 *   ALL TESTS HERE ARE SOCKET-FREE (the pipeline runs against the gateway's own fakes).
 *
 * The scenario Codex demonstrated: the runtime returns `request_human`; while the reply
 * is being posted a person takes the conversation and HANDS IT BACK, leaving AI_RESUMED
 * in a NEWER episode. The old delivery then called `requestHuman()` with no expected
 * episode, which opened yet another hold, and adopted that hold's episode as its own
 * `heldEpisode`: so the write fence (which compares against `heldEpisode`) passed, and
 * the private note, status change, assignment, labels and attributes all followed. The
 * old delivery acted on authority it was never given.
 *
 * The contract pinned here: an escalation is recorded only against the episode this
 * delivery STARTED under (`expectedEpisode`, compared under the ownership row's lock). If
 * the conversation has moved on, the answer is `stale_episode`: no hold is created, none
 * is adopted, and none of the escalation writes are made. The same rule applies to the
 * handoff path, which also records a hold before it writes.
 *
 * Laws 11/19/23/28: every "did not happen" test has its positive twin in the same
 * harness (the same flow with no race DOES open the hold and perform every write).
 */
import { describe, expect, it } from "vitest";

import { bindingIdentity } from "../src/deliveryref.js";
import { DISARMED } from "../src/failpoint.js";
import type { ChatwootTarget } from "../src/chatwoot.js";
import type { ConversationRef, TransitionOutcome } from "../src/ownership.js";
import { processDelivery, type DeliveryJob, type PipelineDeps } from "../src/pipeline.js";
import type { AgentRuntimeResult } from "../src/runtime.js";
import { parseWebhookPayload } from "../src/webhook.js";
import {
  ACCOUNT_ID,
  attachmentOnlyPayload,
  CapturingLogger,
  CONVERSATION_DISPLAY_ID,
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

function makeJob(mode: "answer" | "handoff" = "answer"): DeliveryJob {
  const binding = makeBinding({ escalationTeamId: TEAM_ID });
  const body = mode === "handoff" ? attachmentOnlyPayload(["image"]) : messageCreatedPayload();
  return {
    correlationId: "corr-episode",
    deliveryId: "delivery-episode-1",
    identity: {
      tenantId: TENANT_ID,
      bindingId: bindingIdentity(binding),
      chatwootAccountId: ACCOUNT_ID,
      chatwootInboxId: INBOX_ID,
      eventId: "delivery:episode-1",
    },
    digest: "digest-episode-1",
    binding,
    payload: parseWebhookPayload(Buffer.from(JSON.stringify(body)))!,
    conversationId: CONVERSATION_DISPLAY_ID,
    startedAtMs: 0,
    mode,
    classification:
      mode === "handoff"
        ? { reason: "attachment_or_unsupported_content", attachmentCount: 1, attachmentTypes: ["image"], contentType: "text" }
        : null,
  };
}

const REQUEST_HUMAN: AgentRuntimeResult = {
  text: "I am bringing in a colleague.",
  action: "request_human",
  actionUnrecognised: false,
  actionReason: "explicit_human_request",
  outcome: "ok",
  correlationId: "runtime-correlation-id",
  completionState: "completed",
  contractVersion: 2,
};

/** Lets a test act as the person AT the moment of the customer-visible reply. */
class HookedChatwoot extends StubChatwootApi {
  afterCustomerMessage: (() => Promise<void>) | null = null;
  override async postMessage(
    target: ChatwootTarget,
    content: string,
    isPrivate: boolean,
    deliveryRef?: string,
  ): Promise<number | null> {
    const id = await super.postMessage(target, content, isPrivate, deliveryRef);
    if (!isPrivate) await this.afterCustomerMessage?.();
    return id;
  }
}

/** The person takes the conversation and hands it back in the instant before the hold is recorded. */
class RacingGate extends InMemoryOwnershipGate {
  raced = false;
  override async requestHuman(input: Parameters<InMemoryOwnershipGate["requestHuman"]>[0]): Promise<TransitionOutcome> {
    if (!this.raced) {
      this.raced = true;
      this.seed(REF, "AI_RESUMED", 5); // a newer episode than the one this delivery started under (0)
    }
    return super.requestHuman(input);
  }
}

function makeDeps(ownership: InMemoryOwnershipGate, chatwoot: HookedChatwoot, runtime: StubAgentRuntime) {
  const capture = new CapturingLogger();
  const ledger = new FakeLedger();
  const deps: PipelineDeps = {
    config: envConfig(),
    chatwoot,
    runtime,
    logger: capture.logger,
    ledger,
    ownership,
    failpoint: DISARMED,
    now: () => 0,
  };
  return { deps, capture, ledger };
}

const WRITE_KINDS = new Set(["message", "toggle_status", "assignment", "labels_write", "attributes_write"]);
const writes = (chatwoot: StubChatwootApi): string[] =>
  chatwoot.calls.filter((c) => WRITE_KINDS.has(c.kind)).map((c) => `${c.kind}${c.private === true ? ":private" : ""}`);

const ESCALATION_WRITES = ["message:private", "toggle_status", "assignment", "labels_write", "attributes_write"];

describe("F5 (escalate): a hold is recorded only against the episode the delivery STARTED under", () => {
  it("takeover AND handback while the reply is posting: NO new hold is opened or adopted, and NONE of the escalation writes are made", async () => {
    const ownership = new InMemoryOwnershipGate();
    const chatwoot = new HookedChatwoot();
    // The person takes the conversation and hands it back while the reply is in flight.
    chatwoot.afterCustomerMessage = async () => ownership.seed(REF, "AI_RESUMED", 5);
    const { deps } = makeDeps(ownership, chatwoot, new StubAgentRuntime(async () => REQUEST_HUMAN));

    await processDelivery(deps, makeJob());

    const after = await ownership.read(REF);
    // The takeover+handback provably happened and nothing of ours replaced it.
    expect(after.state, "the old delivery opened (and adopted) a new hold").toBe("AI_RESUMED");
    expect(after.episode).toBe(5);
    // Only the reply that was already on the wire landed.
    expect(writes(chatwoot)).toEqual(["message"]);
    for (const kind of ESCALATION_WRITES) expect(writes(chatwoot)).not.toContain(kind);
  });

  it("CONTROL: the very same request_human flow with NO takeover opens the hold in the NEXT episode and performs every escalation write", async () => {
    const ownership = new InMemoryOwnershipGate();
    const chatwoot = new HookedChatwoot();
    const { deps } = makeDeps(ownership, chatwoot, new StubAgentRuntime(async () => REQUEST_HUMAN));

    const result = await processDelivery(deps, makeJob());

    expect(result.escalated).toBe(true);
    const after = await ownership.read(REF);
    expect(after.state).toBe("HUMAN_REQUESTED");
    expect(after.episode).toBe(1);
    for (const kind of ESCALATION_WRITES) expect(writes(chatwoot)).toContain(kind);
  });

  it("the race happens inside requestHuman itself (the window between the last read and the hold): same result", async () => {
    const ownership = new RacingGate();
    const chatwoot = new HookedChatwoot();
    const { deps } = makeDeps(ownership, chatwoot, new StubAgentRuntime(async () => REQUEST_HUMAN));

    await processDelivery(deps, makeJob());

    expect(ownership.raced, "the race never ran, so this test proved nothing").toBe(true);
    const after = await ownership.read(REF);
    expect(after.state).toBe("AI_RESUMED");
    expect(after.episode).toBe(5);
    for (const kind of ESCALATION_WRITES) expect(writes(chatwoot)).not.toContain(kind);
  });

  it("DISTINCTNESS: the stale episode (5) differs from the episode the delivery started under (0), so the check can fail", async () => {
    const ownership = new InMemoryOwnershipGate();
    const startEpisode = (await ownership.read(REF)).episode;
    ownership.seed(REF, "AI_RESUMED", 5);
    expect((await ownership.read(REF)).episode).not.toBe(startEpisode);
  });
});

describe("F5 (handoff): the handoff path records its hold against the starting episode too", () => {
  it("the conversation moved on before the handoff hold was recorded: no hold, no note, no status, no assignment, no acknowledgement", async () => {
    const ownership = new RacingGate();
    const chatwoot = new HookedChatwoot();
    const { deps, capture } = makeDeps(ownership, chatwoot, StubAgentRuntime.answering("unused"));

    await processDelivery(deps, makeJob("handoff"));

    expect(ownership.raced).toBe(true);
    const after = await ownership.read(REF);
    expect(after.state).toBe("AI_RESUMED");
    expect(after.episode).toBe(5);
    expect(writes(chatwoot)).toEqual([]);
    expect(capture.withOutcome("suppressed_in_flight").length).toBeGreaterThanOrEqual(1);
  });

  it("CONTROL: the same handoff with NO race opens the hold (episode 1) and performs its writes", async () => {
    const ownership = new InMemoryOwnershipGate();
    const chatwoot = new HookedChatwoot();
    const { deps } = makeDeps(ownership, chatwoot, StubAgentRuntime.answering("unused"));

    await processDelivery(deps, makeJob("handoff"));

    const after = await ownership.read(REF);
    expect(after.state).toBe("HUMAN_REQUESTED");
    expect(after.episode).toBe(1);
    expect(writes(chatwoot)).toContain("toggle_status");
    expect(writes(chatwoot)).toContain("message:private");
  });
});
