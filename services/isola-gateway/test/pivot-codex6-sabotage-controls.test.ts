/**
 * CODEX ROUND 6: three sabotages of the recovery rule that NO repository test caught (0 failures),
 * now caught by independent controls (adapted from Codex's own scratch controls, not copied):
 *
 *   1. ignoring the OWN hold when judging whether a delivery is complete;
 *   2. disabling the recovery WRITE FENCE (a takeover while the note is being published);
 *   3. removing the recovery EPISODE PRECONDITION (the conversation moved on between the read of
 *      its state and the request for the hold).
 *
 * These tests PASS on the current code. They are controls, not regression tests for a defect found
 * in a run; their value is proved by SABOTAGE (each mutation turns the named test red), recorded in
 * the commit message and the branch notes.
 *
 * Every test runs the REAL sweeper (Law 20). ALL TESTS ARE SOCKET-FREE (injected fetch for the one
 * production-client control). Laws 11, 19, 23, 28.
 */
import { describe, expect, it } from "vitest";

import { HttpChatwootApi } from "../src/chatwoot.js";
import {
  build,
  EVENT_ID,
  makeJob,
  refOf,
  reserve,
  stateOf,
  sweeperFor,
} from "./codex6-recovery-support.js";
import { CONVERSATION_DISPLAY_ID, MESSAGE_ID } from "./harness.js";

describe("independent controls for the three uncaught sabotages", () => {
  it("OWN HOLD is not complete: a completed reply and no other action rows, but this delivery's own recorded hold, still escalates", async () => {
    const { deps, ledger, ownership, chatwoot, capture } = build();
    const job = makeJob();
    await reserve(ledger, job);
    await ledger.claimAction(job.identity, "reply", job.digest, job.correlationId, 300_000);
    await ledger.complete(job.identity, "reply", 9010);
    ownership.seed(refOf(job), "HUMAN_REQUESTED", 1, `escalate:${EVENT_ID}`);
    ledger.expireAllLeases();
    await sweeperFor(deps, capture).sweeper.sweep();
    expect(chatwoot.privateNotes).toHaveLength(1);
    expect(chatwoot.statusToggles).toHaveLength(1);
    expect(stateOf(ledger, "delivery")).toBe("completed");
  });

  it("CONTROL for the own-hold test: the same completed reply with NO hold is complete (nothing written)", async () => {
    const { deps, ledger, chatwoot, capture } = build();
    const job = makeJob();
    await reserve(ledger, job);
    await ledger.claimAction(job.identity, "reply", job.digest, job.correlationId, 300_000);
    await ledger.complete(job.identity, "reply", 9010);
    ledger.expireAllLeases();
    await sweeperFor(deps, capture).sweeper.sweep();
    expect(chatwoot.privateNotes).toHaveLength(0);
    expect(chatwoot.statusToggles).toHaveLength(0);
    expect(stateOf(ledger, "delivery")).toBe("completed");
  });

  it("WRITE FENCE: a person takes the conversation WHILE the note is being posted: the note exists, opening and assignment do not happen", async () => {
    const { deps, ledger, ownership, chatwoot, capture } = build();
    const job = makeJob();
    await reserve(ledger, job);
    const post = chatwoot.postMessage.bind(chatwoot);
    chatwoot.postMessage = async (...args) => {
      const id = await post(...args);
      ownership.seed(refOf(job), "HUMAN_OWNED", 2);
      return id;
    };
    ledger.expireAllLeases();
    await sweeperFor(deps, capture).sweeper.sweep();
    expect(chatwoot.privateNotes).toHaveLength(1);
    expect(chatwoot.statusToggles).toHaveLength(0);
    expect(chatwoot.assignments).toHaveLength(0);
  });

  it("CONTROL for the fence test: with nobody taking the conversation, the same sweep opens it", async () => {
    const { deps, ledger, chatwoot, capture } = build();
    const job = makeJob();
    await reserve(ledger, job);
    ledger.expireAllLeases();
    await sweeperFor(deps, capture).sweeper.sweep();
    expect(chatwoot.privateNotes).toHaveLength(1);
    expect(chatwoot.statusToggles).toHaveLength(1);
  });

  it("EPISODE PRECONDITION (another delivery's hold appears before this delivery requests its own): nothing is written", async () => {
    const { deps, ledger, ownership, chatwoot, capture } = build();
    const job = makeJob();
    await reserve(ledger, job);
    const request = ownership.requestHuman.bind(ownership);
    ownership.requestHuman = async (args) => {
      ownership.seed(refOf(job), "HUMAN_REQUESTED", 1, "escalate:other-delivery");
      return request(args);
    };
    ledger.expireAllLeases();
    await sweeperFor(deps, capture).sweeper.sweep();
    expect(chatwoot.privateNotes).toHaveLength(0);
    expect(chatwoot.statusToggles).toHaveLength(0);
    expect(stateOf(ledger, "delivery")).toBe("completed");
  });

  it("EPISODE PRECONDITION (a takeover AND a handback happen between the read and the request): the old delivery does not adopt the newer episode", async () => {
    const { deps, ledger, ownership, chatwoot, capture } = build();
    const job = makeJob();
    await reserve(ledger, job);
    const request = ownership.requestHuman.bind(ownership);
    ownership.requestHuman = async (args) => {
      // The conversation went to a person and back to the AI: the AI may answer again, on a NEWER episode.
      ownership.seed(refOf(job), "AI_RESUMED", 2);
      return request(args);
    };
    ledger.expireAllLeases();
    await sweeperFor(deps, capture).sweeper.sweep();
    expect(chatwoot.privateNotes).toHaveLength(0);
    expect(chatwoot.statusToggles).toHaveLength(0);
    expect(stateOf(ledger, "delivery")).toBe("completed");
  });

  it("CONTROL for the episode tests: with the conversation unchanged the hold is recorded on the episode that was read and the escalation is published", async () => {
    const { deps, ledger, ownership, chatwoot, capture } = build();
    const job = makeJob();
    await reserve(ledger, job);
    ledger.expireAllLeases();
    await sweeperFor(deps, capture).sweeper.sweep();
    const view = await ownership.read(refOf(job));
    expect(view.state).toBe("HUMAN_REQUESTED");
    expect(view.escalationOperationId).toBe(`escalate:${EVENT_ID}`);
    expect(chatwoot.privateNotes).toHaveLength(1);
  });

  it("PRODUCTION CLIENT CONTROL (injected fetch, no socket): an empty delivery gets its note and its opening through the real HTTP client", async () => {
    const { deps, ledger, capture } = build();
    const job = makeJob();
    await reserve(ledger, job);
    const posts: string[] = [];
    deps.chatwoot = new HttpChatwootApi({
      baseUrl: "https://offline.invalid",
      safeFetch: async (url, init) => {
        if (init?.method === "POST") {
          posts.push(String(url));
          return Response.json({ id: 10_000 });
        }
        return Response.json({
          status: "pending",
          meta: { assignee: null },
          messages: [{ id: MESSAGE_ID, message_type: 0 }],
          last_non_activity_message: { id: MESSAGE_ID, message_type: 0 },
        });
      },
    });
    ledger.expireAllLeases();
    await sweeperFor(deps, capture).sweeper.sweep();
    expect(posts).toHaveLength(2);
    expect(posts.some((p) => p.includes(`/conversations/${CONVERSATION_DISPLAY_ID}/messages`))).toBe(true);
    expect(stateOf(ledger, "delivery")).toBe("completed");
  });
});
