/**
 * CODEX ROUND 6, G6-1 (review of 91a7ce4): the SAME message id seen as an ACTIVITY line in
 * `messages[]` and as a REAL message in `last_non_activity_message`.
 *
 * An id names ONE message. Two representations of it that disagree about whether it is an
 * activity line are not a record anybody can reason about. Before the fix, `readVisibleMessages`
 * de-duplicated by id and kept the FIRST representation (the activity), the activity filter then
 * left no real message, reconciliation said ABSENT, and the guarded sender wrote a SECOND copy of
 * a message that may be committed (Codex demonstrated modeled committed customer replies going
 * from one to two).
 *
 * The rule under test: a record in which one id carries conflicting representations is
 * UNREADABLE, so absence cannot be proven, so nothing is re-sent. The validation runs BEFORE any
 * de-duplication.
 *
 * ALL TESTS HERE ARE SOCKET-FREE (injected fetch). Every refusal has its positive twin in the same
 * harness (Laws 11, 19, 23, 28).
 */
import { describe, expect, it } from "vitest";

import { HttpChatwootApi, reconcileFromRecord } from "../src/chatwoot.js";
import { bindingIdentity } from "../src/deliveryref.js";
import { DISARMED } from "../src/failpoint.js";
import { sendGuardedMessage, type WriteContext } from "../src/writes.js";
import {
  ACCOUNT_ID,
  CapturingLogger,
  CONVERSATION_DISPLAY_ID,
  FakeLedger,
  INBOX_ID,
  makeBinding,
  MESSAGE_ID,
  TENANT_ID,
} from "./harness.js";

const PIVOT = 9001;

describe("G6-1: one id, two conflicting representations, is never proof of absence", () => {
  it("an id that is an ACTIVITY in messages[] and a REAL message in last_non_activity_message is INCONCLUSIVE", () => {
    const result = reconcileFromRecord(
      { messages: [{ id: 9002, message_type: 2 }], last_non_activity_message: { id: 9002, message_type: 1 } },
      "not-ours",
      PIVOT,
    );
    expect(result.kind).toBe("inconclusive");
  });

  it("the same conflict with the representations in the OTHER positions is also INCONCLUSIVE", () => {
    const result = reconcileFromRecord(
      { messages: [{ id: 9002, message_type: 1 }], last_non_activity_message: { id: 9002, message_type: 2 } },
      "not-ours",
      PIVOT,
    );
    expect(result.kind).toBe("inconclusive");
  });

  it("the same id twice inside messages[] with conflicting types is INCONCLUSIVE", () => {
    const result = reconcileFromRecord(
      {
        messages: [
          { id: 9002, message_type: 2 },
          { id: 9002, message_type: 1 },
        ],
        last_non_activity_message: null,
      },
      "not-ours",
      PIVOT,
    );
    expect(result.kind).toBe("inconclusive");
  });

  it("CONTROL: the SAME id with the SAME representation in both places is a consistent record (absent at the pivot)", () => {
    const result = reconcileFromRecord(
      { messages: [{ id: PIVOT, message_type: 0 }], last_non_activity_message: { id: PIVOT, message_type: 0 } },
      "not-ours",
      PIVOT,
    );
    expect(result.kind).toBe("absent");
  });

  it("CONTROL: DIFFERENT ids, an activity newest and a real message before it, is a consistent record (absent)", () => {
    const result = reconcileFromRecord(
      { messages: [{ id: 9003, message_type: 2 }], last_non_activity_message: { id: PIVOT, message_type: 0 } },
      "not-ours",
      PIVOT,
    );
    expect(result.kind).toBe("absent");
  });

  it("CONTROL: our reference on a consistent record is still FOUND", () => {
    const result = reconcileFromRecord(
      {
        messages: [{ id: 9002, message_type: 1, content_attributes: { isola_delivery_ref: "ours" } }],
        last_non_activity_message: { id: 9002, message_type: 1, content_attributes: { isola_delivery_ref: "ours" } },
      },
      "ours",
      PIVOT,
    );
    expect(result).toEqual({ kind: "found", messageId: 9002 });
  });
});

describe("G6-1 through the REAL guarded-send path: the duplicate is not written", () => {
  /** `alreadyCommitted`: the earlier (interrupted) send DID commit this many messages in Chatwoot. */
  async function run(record: unknown, alreadyCommitted: number) {
    const ledger = new FakeLedger();
    const capture = new CapturingLogger();
    const binding = makeBinding();
    const identity = {
      tenantId: TENANT_ID,
      bindingId: bindingIdentity(binding),
      chatwootAccountId: ACCOUNT_ID,
      chatwootInboxId: INBOX_ID,
      eventId: "delivery:g61",
    };
    let committed = alreadyCommitted;
    const api = new HttpChatwootApi({
      baseUrl: "https://offline.invalid",
      safeFetch: async (_url, init) => {
        if (init?.method === "POST") {
          committed += 1;
          return Response.json({ id: MESSAGE_ID + 2 });
        }
        return Response.json(record);
      },
    });
    await ledger.claimAction(identity, "reply", "digest-g61", "corr-g61", 300_000);
    const context: WriteContext = {
      identity,
      digest: "digest-g61",
      correlationId: "corr-g61",
      pivotMessageId: MESSAGE_ID,
      base: {},
    };
    // The action is already claimed above (by "the interrupted earlier attempt"), so this
    // claim is ambiguous and not owned: the sender must RECONCILE before it may write.
    const outcome = await sendGuardedMessage(
      { chatwoot: api, ledger, logger: capture.logger, leaseMs: 300_000, failpoint: DISARMED },
      context,
      "reply",
      { accountId: ACCOUNT_ID, conversationId: CONVERSATION_DISPLAY_ID, accessToken: "offline" },
      "answer",
      false,
    );
    return { outcome, committed };
  }

  const conflicting = {
    messages: [{ id: MESSAGE_ID + 1, message_type: 2 }],
    last_non_activity_message: { id: MESSAGE_ID + 1, message_type: 1 },
  };
  const consistent = {
    messages: [{ id: MESSAGE_ID, message_type: 0 }],
    last_non_activity_message: { id: MESSAGE_ID, message_type: 0 },
  };

  it("CONTROL: a consistent record that proves nothing was committed lets the send go out exactly once", async () => {
    const { outcome, committed } = await run(consistent, 0);
    expect({ kind: outcome.kind, committed }).toEqual({ kind: "sent", committed: 1 });
  });

  it("a conflicting record never turns an earlier COMMITTED send into a second committed copy", async () => {
    const { outcome, committed } = await run(conflicting, 1);
    expect({ kind: outcome.kind, committed }).toEqual({ kind: "ambiguous", committed: 1 });
  });
});
