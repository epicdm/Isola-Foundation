/**
 * The no-usable-text handoff: the pure half.
 *
 * A verified incoming customer message that passes every suppression check but
 * carries no text the model can read must NOT disappear. It used to: the
 * gateway acknowledged 200, sent nothing, and — because it answered 200 —
 * Chatwoot's native auto-open did not fire either, so the customer waited for a
 * human nobody had summoned.
 *
 * The behaviour now, in this exact order (orchestrated in `src/pipeline.ts`):
 *
 *   1. `toggle_status` -> open
 *   2. `assignments`   -> the binding's escalation team, when one is configured
 *   3. the AI is now suppressed for that conversation BY THE EXISTING
 *      PREDICATE — an `open` conversation with an assignee is refused by
 *      `evaluateSuppression`. There is deliberately no second mechanism.
 *   4. exactly ONE private note, carrying the reason plus the attachment TYPE
 *      and COUNT only
 *   5. and only then, exactly ONE customer-visible message
 *
 * THE MODEL IS NEVER INVOKED ON THIS PATH, and the attachment is never opened,
 * downloaded, inspected, inferred from or described. The gateway does not read
 * `data_url` at all — see `readAttachmentTypes` in `src/webhook.ts`.
 *
 * If step 1 or step 2 fails the customer message is NOT sent, because telling a
 * customer their conversation was handed to a team member when it was not is a
 * lie the customer cannot check. That is `handoff_blocked`.
 */
import type { HandoffReason, NoTextClassification } from "./webhook.js";

/**
 * The two customer-visible strings, verbatim as specified by the owner.
 *
 * Do not reword these, and do not template anything into them: they are the
 * only sentences this gateway ever says on its own behalf rather than the
 * model's. `test/handoff.test.ts` pins both byte for byte, including the em
 * dash below and the ASCII apostrophe in "couldn't".
 */
export const ATTACHMENT_ACKNOWLEDGEMENT =
  "Thanks — I received your attachment and passed this conversation to a team member for review.";

export const EMPTY_MESSAGE_ACKNOWLEDGEMENT =
  "I couldn't read that message, so I passed the conversation to a team member.";

export function customerAcknowledgement(reason: HandoffReason): string {
  return reason === "attachment_or_unsupported_content"
    ? ATTACHMENT_ACKNOWLEDGEMENT
    : EMPTY_MESSAGE_ACKNOWLEDGEMENT;
}

/** Which step of the handoff failed. Blocks the customer message. */
export type HandoffFailedStep = "toggle_status" | "assignment";

export const HANDOFF_EXPLANATIONS: Readonly<Record<HandoffReason, string>> = Object.freeze({
  attachment_or_unsupported_content:
    "the customer sent attachments or content this gateway cannot read, and no text alongside it. The attachment was NOT opened, downloaded, inspected or described, and the AI was not called.",
  empty_message:
    "the customer's message arrived with no readable content at all. The AI was not called.",
});

export function explainHandoff(reason: HandoffReason): string {
  return HANDOFF_EXPLANATIONS[reason];
}

/**
 * "image x2, file x1" — types and counts only.
 *
 * Every type here comes from the closed vocabulary in `readAttachmentType`, so
 * this string can never contain a filename, a URL or any other caller-supplied
 * text.
 */
export function summariseAttachments(types: readonly string[]): string {
  if (types.length === 0) return "none";
  const counts = new Map<string, number>();
  for (const type of types) counts.set(type, (counts.get(type) ?? 0) + 1);
  return [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([type, count]) => `${type} x${count}`)
    .join(", ");
}

export interface HandoffNoteArgs {
  classification: NoTextClassification;
  correlationId: string;
  tenantId: string;
  /** The team the conversation was assigned to, or null when none is configured. */
  assignedTeamId: number | null;
}

/**
 * The single private note left for the human who picks the conversation up.
 *
 * Carries the reason, the attachment type and count, and the correlation id.
 * It carries NO customer content, NO filename and NO URL.
 *
 * The last paragraph is worded so the note cannot become a lie: it does not
 * claim the acknowledgement was delivered, it tells the reader how to check.
 */
export function renderHandoffNote(args: HandoffNoteArgs): string {
  const { classification: c } = args;
  return [
    "**Isola AI did not answer this conversation: there was no text it could read.**",
    "",
    `- reason: \`${c.reason}\``,
    `- what that means: ${explainHandoff(c.reason)}`,
    `- attachments: ${c.attachmentCount} (${summariseAttachments(c.attachmentTypes)})`,
    `- content type: \`${c.contentType ?? "none"}\``,
    `- correlation id: \`${args.correlationId}\``,
    `- tenant: \`${args.tenantId}\``,
    "",
    args.assignedTeamId === null
      ? "The conversation has been moved to **open** for a human to take over. No escalation team is configured for this inbox, so it is unassigned."
      : `The conversation has been moved to **open** and assigned to team \`${args.assignedTeamId}\`.`,
    "",
    "A short acknowledgement to the customer is posted immediately after this note. If no such message appears below, it failed to send and the customer has NOT been told.",
  ].join("\n");
}

export interface BlockedNoteArgs extends HandoffNoteArgs {
  failedStep: HandoffFailedStep;
}

/**
 * The note posted when the handoff itself could not be recorded.
 *
 * This is the honest counterpart of the note above: no customer message was
 * sent, and it says so, because the customer has not been told anything.
 */
export function renderHandoffBlockedNote(args: BlockedNoteArgs): string {
  const { classification: c } = args;
  return [
    "**Isola AI could not hand this conversation to a human.**",
    "",
    `- reason: \`${c.reason}\``,
    `- what that means: ${explainHandoff(c.reason)}`,
    `- attachments: ${c.attachmentCount} (${summariseAttachments(c.attachmentTypes)})`,
    `- failed step: \`${args.failedStep}\``,
    `- correlation id: \`${args.correlationId}\``,
    `- tenant: \`${args.tenantId}\``,
    "",
    "**No message was sent to the customer**, because the handoff did not complete and telling them otherwise would be untrue. This conversation needs a human to pick it up manually.",
  ].join("\n");
}
