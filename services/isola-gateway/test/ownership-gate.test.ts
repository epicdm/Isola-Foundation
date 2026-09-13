/**
 * The ownership gate on the live reply path.
 *
 * These are the BEHAVIOURAL half of the change: `test/ownership.test.ts` pins
 * the rules, `test/ownership-store.pg.test.ts` proves the database enforces
 * them, and this file proves the gateway actually consults them before it
 * speaks.
 *
 * The property that matters most is the last one: an ownership store that
 * cannot be reached must SILENCE the bot, not license it. A gate that returns
 * "AI_OWNED" when it does not know is indistinguishable in the logs from a
 * healthy read, and it puts an automated reply into a conversation a human is
 * holding — the exact defect the whole ownership model exists to prevent.
 */
import { describe, expect, it } from "vitest";

import { processDelivery, type PipelineDeps } from "../src/pipeline.js";
import { DISARMED } from "../src/failpoint.js";
import type { ConversationRef, OwnershipState } from "../src/ownership.js";
import {
  ACCOUNT_ID,
  CONVERSATION_DISPLAY_ID,
  CapturingLogger,
  envConfig,
  FakeLedger,
  INBOX_ID,
  InMemoryOwnershipGate,
  makeBinding,
  StubAgentRuntime,
  StubChatwootApi,
  TENANT_ID,
  UnavailableOwnershipGate,
  messageCreatedPayload,
} from "./harness.js";
import { bindingIdentity } from "../src/deliveryref.js";
import { parseWebhookPayload } from "../src/webhook.js";
import type { DeliveryJob } from "../src/pipeline.js";

const REF: ConversationRef = {
  tenantId: TENANT_ID,
  chatwootAccountId: ACCOUNT_ID,
  chatwootConversationId: CONVERSATION_DISPLAY_ID,
};

function makeJob(mode: "answer" | "handoff" = "answer"): DeliveryJob {
  const binding = makeBinding();
  return {
    correlationId: "corr-ownership",
    deliveryId: "delivery-ownership-1",
    identity: {
      tenantId: TENANT_ID,
      bindingId: bindingIdentity(binding),
      chatwootAccountId: ACCOUNT_ID,
      chatwootInboxId: INBOX_ID,
      eventId: "delivery:ownership-1",
    },
    digest: "digest-ownership-1",
    binding,
    // The fixture is a raw webhook BODY; the pipeline takes the parsed form,
    // so parse it the same way the HTTP path does rather than hand-rolling one.
    payload: parseWebhookPayload(Buffer.from(JSON.stringify(messageCreatedPayload())))!,
    conversationId: CONVERSATION_DISPLAY_ID,
    startedAtMs: 0,
    mode,
    classification:
      mode === "handoff"
        ? {
            reason: "attachment_or_unsupported_content",
            attachmentCount: 1,
            attachmentTypes: ["image"],
            contentType: null,
          }
        : null,
  };
}

function makeDeps(overrides: Partial<PipelineDeps> = {}): {
  deps: PipelineDeps;
  chatwoot: StubChatwootApi;
  runtime: StubAgentRuntime;
  logger: CapturingLogger;
} {
  const chatwoot = new StubChatwootApi();
  const runtime = StubAgentRuntime.answering("Here is your answer.");
  const capture = new CapturingLogger();
  const deps: PipelineDeps = {
    config: envConfig(),
    chatwoot,
    runtime,
    logger: capture.logger,
    ledger: new FakeLedger(),
    ownership: new InMemoryOwnershipGate(),
    failpoint: DISARMED,
    now: () => 0,
    ...overrides,
  };
  return { deps, chatwoot, runtime, logger: capture };
}

describe("an empty store changes nothing", () => {
  it("a conversation with no ownership history is answered exactly as before", async () => {
    const { deps, chatwoot, runtime } = makeDeps();
    const result = await processDelivery(deps, makeJob());

    expect(result.outcome).toBe("replied");
    expect(runtime.requests).toHaveLength(1);
    expect(chatwoot.customerMessages).toHaveLength(1);
  });
});

describe("a human hold silences the bot", () => {
  it.each<[OwnershipState]>([["HUMAN_REQUESTED"], ["HUMAN_OWNED"], ["HANDING_BACK"]])(
    "%s: the model is NOT called and nothing is sent",
    async (state) => {
      const ownership = new InMemoryOwnershipGate();
      ownership.seed(REF, state);
      const { deps, chatwoot, runtime } = makeDeps({ ownership });

      const result = await processDelivery(deps, makeJob());

      expect(result.outcome).toBe("human_owned");
      expect(result.customerMessageSent).toBe(false);
      expect(result.needsRetry).toBe(false);
      // The two assertions that matter: no model run, no customer message.
      expect(runtime.requests).toHaveLength(0);
      expect(chatwoot.customerMessages).toHaveLength(0);
    },
  );

  it("HANDING_BACK silences the bot even though reconciliation is in progress", async () => {
    const ownership = new InMemoryOwnershipGate();
    ownership.seed(REF, "HANDING_BACK");
    const { deps, runtime } = makeDeps({ ownership });
    await processDelivery(deps, makeJob());
    expect(runtime.requests).toHaveLength(0);
  });

  it.each<[OwnershipState]>([["AI_OWNED"], ["AI_RESUMED"]])(
    "%s: the bot still answers",
    async (state) => {
      const ownership = new InMemoryOwnershipGate();
      ownership.seed(REF, state);
      const { deps, runtime } = makeDeps({ ownership });

      const result = await processDelivery(deps, makeJob());
      expect(result.outcome).toBe("replied");
      expect(runtime.requests).toHaveLength(1);
    },
  );

  it("a human hold also blocks the HANDOFF path, which never calls the model anyway", async () => {
    const ownership = new InMemoryOwnershipGate();
    ownership.seed(REF, "HUMAN_OWNED");
    const { deps, chatwoot } = makeDeps({ ownership });

    const result = await processDelivery(deps, makeJob("handoff"));

    expect(result.outcome).toBe("human_owned");
    // No acknowledgement, no note, no second assignment: a person already has
    // it, and telling the customer again that it has been passed to a team
    // member would be a duplicate for one event.
    expect(chatwoot.customerMessages).toHaveLength(0);
  });
});

describe("an unreachable store fails CLOSED", () => {
  it("does not answer when it cannot find out who owns the conversation", async () => {
    const { deps, chatwoot, runtime } = makeDeps({
      ownership: new UnavailableOwnershipGate(),
    });

    await expect(processDelivery(deps, makeJob())).rejects.toThrow(/unavailable/);

    // The point of the test. Silence, not a reply composed in ignorance.
    expect(runtime.requests).toHaveLength(0);
    expect(chatwoot.customerMessages).toHaveLength(0);
  });

  it("CONTROL: the same delivery with a reachable store DOES answer", async () => {
    const { deps, chatwoot, runtime } = makeDeps();
    const result = await processDelivery(deps, makeJob());
    expect(result.outcome).toBe("replied");
    expect(runtime.requests).toHaveLength(1);
    expect(chatwoot.customerMessages).toHaveLength(1);
  });
});

describe("handing over records the transfer before it publishes it", () => {
  it("a handoff moves the conversation to HUMAN_REQUESTED", async () => {
    const ownership = new InMemoryOwnershipGate();
    const { deps } = makeDeps({ ownership });

    const result = await processDelivery(deps, makeJob("handoff"));
    expect(result.outcome).toBe("handed_off");

    const after = await ownership.read(REF);
    expect(after.state).toBe("HUMAN_REQUESTED");
    expect(after.episode).toBe(1);
  });

  it("a failed run escalates AND records the transfer", async () => {
    const ownership = new InMemoryOwnershipGate();
    const { deps } = makeDeps({
      ownership,
      runtime: StubAgentRuntime.failing("provider_error"),
    });

    const result = await processDelivery(deps, makeJob());
    expect(result.escalated).toBe(true);

    const after = await ownership.read(REF);
    expect(after.state).toBe("HUMAN_REQUESTED");
    expect(after.episode).toBe(1);
  });

  /**
   * Chatwoot redelivers the same webhook. The transition is keyed on the
   * delivery's ledger identity, so the second attempt claims nothing new and
   * the conversation stays on ONE episode. Without this, every retry would open
   * a fresh span of human involvement and a later handback naming episode 1
   * would be judged against episode 3.
   */
  it("a redelivered escalation does not open a second episode", async () => {
    const ownership = new InMemoryOwnershipGate();
    const { deps } = makeDeps({
      ownership,
      runtime: StubAgentRuntime.failing("provider_error"),
    });

    await processDelivery(deps, makeJob());
    const first = await ownership.read(REF);

    // Same job, same event id — exactly what a Chatwoot retry presents. The
    // conversation is HUMAN_REQUESTED now, so the gate stops it before the
    // escalation path is reached at all; assert the episode regardless.
    await processDelivery(deps, makeJob());
    const second = await ownership.read(REF);

    expect(second.episode).toBe(first.episode);
    expect(second.episode).toBe(1);
  });
});

/**
 * Found by an independent adversarial review, and it was right: recording the
 * hold and then continuing regardless of the result meant Chatwoot could show a
 * conversation handed to a human while the store still said AI_OWNED. Every
 * human reading Chatwoot would see a handover; the next inbound message would
 * get an automated reply. Silently wrong, and it stays wrong.
 */
describe("nothing is published to Chatwoot unless the hold is durable", () => {
  it("a handoff whose transition fails tells the customer NOTHING", async () => {
    const { deps, chatwoot } = makeDeps({ ownership: new UnavailableOwnershipGate() });

    await expect(processDelivery(deps, makeJob("handoff"))).rejects.toThrow();

    // Not opened, not assigned, no note, no acknowledgement.
    expect(chatwoot.customerMessages).toHaveLength(0);
    expect(chatwoot.calls).toHaveLength(0);
  });

  it("an escalation whose transition fails posts no note and no assignment", async () => {
    // The runtime fails, so the pipeline escalates — and the escalation cannot
    // record its hold.
    const { deps, chatwoot } = makeDeps({
      ownership: new UnavailableOwnershipGate(),
      runtime: StubAgentRuntime.failing("provider_error"),
    });

    await expect(processDelivery(deps, makeJob())).rejects.toThrow();
    expect(chatwoot.customerMessages).toHaveLength(0);
  });

  it("CONTROL: the same handoff with a working store DOES publish", async () => {
    const { deps, chatwoot } = makeDeps();
    const result = await processDelivery(deps, makeJob("handoff"));
    expect(result.outcome).toBe("handed_off");
    expect(chatwoot.customerMessages.length).toBeGreaterThan(0);
  });
});

/**
 * The resume exemption exists so a delivery that recorded a hold and died can
 * come back and finish publishing it. An adversarial review caught the first
 * version exempting EVERY resumed delivery, which would let one that stalled
 * while a real person took over come back and talk straight over them.
 */
describe("a resumed delivery finishes its OWN handover and nobody else's", () => {
  const OWN_HANDOFF_OP = "handoff:delivery:ownership-1";

  it("resumes when it recorded the hold and nobody has replied yet", async () => {
    const ownership = new InMemoryOwnershipGate();
    ownership.seed(REF, "HUMAN_REQUESTED", 1, OWN_HANDOFF_OP);
    const { deps, chatwoot } = makeDeps({ ownership });

    const job = { ...makeJob("handoff"), resumed: true };
    const result = await processDelivery(deps, job);

    // It carries on and publishes, rather than closing out.
    expect(result.outcome).toBe("handed_off");
    expect(chatwoot.customerMessages.length).toBeGreaterThan(0);
  });

  it("does NOT resume when a different operation opened the episode", async () => {
    const ownership = new InMemoryOwnershipGate();
    ownership.seed(REF, "HUMAN_REQUESTED", 1, "escalate:some-other-delivery");
    const { deps, chatwoot, runtime } = makeDeps({ ownership });

    const result = await processDelivery(deps, { ...makeJob("handoff"), resumed: true });

    expect(result.outcome).toBe("human_owned");
    expect(chatwoot.customerMessages).toHaveLength(0);
    expect(runtime.requests).toHaveLength(0);
  });

  it("does NOT resume once a human has actually replied", async () => {
    const ownership = new InMemoryOwnershipGate();
    // Same delivery opened the episode, but the state has moved on: a person is
    // really there now, and a late "I passed this to a team member" would be
    // both wrong and confusing.
    ownership.seed(REF, "HUMAN_OWNED", 1, OWN_HANDOFF_OP);
    const { deps, chatwoot } = makeDeps({ ownership });

    const result = await processDelivery(deps, { ...makeJob("handoff"), resumed: true });

    expect(result.outcome).toBe("human_owned");
    expect(chatwoot.customerMessages).toHaveLength(0);
  });

  it("a resumed ANSWER delivery still cannot speak through someone else's hold", async () => {
    const ownership = new InMemoryOwnershipGate();
    ownership.seed(REF, "HUMAN_OWNED", 1, "escalate:some-other-delivery");
    const { deps, chatwoot, runtime } = makeDeps({ ownership });

    const result = await processDelivery(deps, { ...makeJob("answer"), resumed: true });

    expect(result.outcome).toBe("human_owned");
    expect(runtime.requests).toHaveLength(0);
    expect(chatwoot.customerMessages).toHaveLength(0);
  });
});

describe("an unreadable stored state is loud as well as safe", () => {
  it("logs an alert when the state had to be failed closed", async () => {
    const ownership = new InMemoryOwnershipGate();
    const { deps, logger, runtime } = makeDeps({
      ownership: {
        read: async () => ({
          state: "HUMAN_OWNED" as const,
          episode: 4,
          handoverAckEpisode: null,
          escalationOperationId: null,
          diverged: true,
        }),
        requestHuman: ownership.requestHuman.bind(ownership),
        claimAck: ownership.claimAck.bind(ownership),
        reconcileObservedAssignment: ownership.reconcileObservedAssignment.bind(ownership),
      },
    });

    await processDelivery(deps, makeJob());

    const alert = logger.lines.find(
      (e) => e["alertCode"] === "ownership_state_unreadable",
    );
    expect(alert).toBeDefined();
    expect(alert?.["alert"]).toBe(true);
    expect(runtime.requests).toHaveLength(0);
  });
});
