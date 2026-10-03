/**
 * CODEX ROUND 6, P3: the private note is a CLAIM about what happened, and two of its sentences
 * claimed more than the gateway knew when it wrote them.
 *
 *   1. "The conversation has been moved to **open**": the note is posted BEFORE the opening is
 *      attempted (and the opening can fail), so the past tense is false at the moment it is read
 *      by anyone who reads it while the conversation is still pending.
 *   2. "No message was sent to the customer": said on `reply_unresolved`, where the send is
 *      UNCERTAIN (it may or may not have reached the customer; nothing was re-sent). That is a
 *      claim of silence the gateway cannot make.
 *
 * Each refusal has its positive twin: a genuine failure where nothing was sent still says so.
 * SOCKET-FREE.
 */
import { describe, expect, it } from "vitest";

import { renderFailureNote } from "../src/pipeline.js";

const base = { correlationId: "c", tenantId: "t" } as const;

describe("the note does not say the conversation WAS opened before opening is attempted", () => {
  it("recovery_escalated", () => {
    const note = renderFailureNote({ ...base, outcome: "recovery_escalated" });
    expect(note).not.toMatch(/has been moved to \*\*open\*\*/);
    expect(note).toMatch(/\*\*open\*\*/);
    expect(note).toMatch(/still \*\*pending\*\*/);
  });

  it("reply-then-escalate (customerAnswered)", () => {
    const note = renderFailureNote({ ...base, outcome: "explicit_human_request", customerAnswered: true });
    expect(note).not.toMatch(/has been moved to \*\*open\*\*/);
    expect(note).toMatch(/still \*\*pending\*\*/);
  });

  it("a plain failure", () => {
    const note = renderFailureNote({ ...base, outcome: "provider_error" });
    expect(note).not.toMatch(/has been moved to \*\*open\*\*/);
    expect(note).toMatch(/still \*\*pending\*\*/);
  });
});

describe("the note does not claim silence when the send is uncertain", () => {
  it("reply_unresolved says the customer may or may not have been answered, and that nothing was re-sent", () => {
    const note = renderFailureNote({ ...base, outcome: "reply_unresolved" });
    expect(note).not.toContain("No message was sent to the customer");
    expect(note).toMatch(/may or may not have received/);
    expect(note).toMatch(/NOT re-sent/);
  });

  it("CONTROL: a failure where nothing was sent (the model failed) still says so", () => {
    const note = renderFailureNote({ ...base, outcome: "provider_error" });
    expect(note).toContain("No message was sent to the customer");
  });

  it("CONTROL: reply_failed (the send was PROVED absent) still says nothing reached the customer", () => {
    const note = renderFailureNote({ ...base, outcome: "reply_failed" });
    expect(note).toContain("No message was sent to the customer");
  });
});
