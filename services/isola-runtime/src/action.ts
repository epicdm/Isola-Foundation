/**
 * THE STRUCTURED AGENT ACTION CONTRACT.
 *
 * WHY THIS EXISTS
 * ---------------
 * Escalation to a human used to be inferred by reading the agent's own prose.
 * The gateway held a list of phrases — "a colleague will", "pass this to" — and
 * escalated when one matched. Measured 2026-08-25 on the real staging journey:
 *
 *   "a colleague will…"        -> matched   -> escalated
 *   "I'll bring in a colleague" -> no match -> NOBODY WAS TOLD
 *
 * Both sentences express the same intent. One reached a human and one did not,
 * and which one you got depended on wording the model was never told to control.
 * A customer promised a person, whose promise nobody hears, is the exact defect
 * the phrase list was built to prevent — the list simply moved the boundary
 * rather than closing it, because there is no finite list of ways to say this.
 *
 * So the intent travels as DATA, in a field, validated. Not as prose to be
 * pattern-matched.
 *
 * WHAT THE MODEL MAY AND MAY NOT DECIDE
 * -------------------------------------
 * It may say WHETHER a human is needed, and optionally WHY from a closed list.
 * It may not say WHO: no account id, no inbox id, no team, no assignee. Those
 * are the gateway's, resolved from the binding. A model that could name a team
 * could name the wrong one, and a customer's conversation would land in a queue
 * nobody watches. The contract below has no field through which an identifier
 * could arrive, which is a stronger guarantee than validating one away.
 *
 * The agent also keeps NO_TOOLS. A response format is not a tool: the provider
 * constrains the shape of the text it returns and nothing is executed, nothing
 * is called, and no capability is granted. `toolPolicy` is untouched.
 *
 * PROMPTS ARE NOT PERMISSIONS (CLAUDE.md §2.24)
 * ---------------------------------------------
 * The instruction below tells the model what to emit. That is documentation,
 * not enforcement — the model may ignore it. Two independent mechanisms make
 * the contract real:
 *
 *   1. the provider's own `response_format: {"type":"json_object"}`, which
 *      constrains the output to syntactically valid JSON;
 *   2. `parseAgentAction`, which enforces the SCHEMA and refuses anything else.
 *
 * Neither trusts the prose. A reply that parses but carries an unknown action
 * is refused outright rather than coerced into the nearest known one — see the
 * fail-closed note on `parseAgentAction`.
 *
 * This module is pure: no I/O, no clock, no logging, no network.
 */

/**
 * The two things an agent turn can be.
 *
 * Deliberately two. Every additional action is a new way for the gateway to be
 * asked to do something, and each one needs its own authorisation story; the
 * defect being fixed needs exactly one new verb.
 */
export const AGENT_ACTIONS = ["reply", "request_human"] as const;
export type AgentAction = (typeof AGENT_ACTIONS)[number];

export function isAgentAction(value: unknown): value is AgentAction {
  return typeof value === "string" && (AGENT_ACTIONS as readonly string[]).includes(value);
}

/**
 * The seven ratified escalation reason codes. Identical to the set the
 * gateway's ownership ledger already accepts (`ESCALATION_REASON_CODES` in
 * `services/isola-gateway/src/ownership.ts`) — this is that contract, not a
 * second vocabulary. The ledger persists the reason to an audit table, so it
 * must be a CODE and never prose.
 */
export const ESCALATION_REASON_CODES = [
  "explicit_human_request",
  "low_confidence",
  "policy_boundary",
  "approval_required",
  "tool_failure",
  "complaint_sensitive",
  "unsupported_request",
] as const;
export type EscalationReasonCode = (typeof ESCALATION_REASON_CODES)[number];

export function isEscalationReasonCode(value: unknown): value is EscalationReasonCode {
  return (
    typeof value === "string" &&
    (ESCALATION_REASON_CODES as readonly string[]).includes(value)
  );
}

/** The reason recorded when the agent escalated without naming one. */
export const DEFAULT_ESCALATION_REASON: EscalationReasonCode = "explicit_human_request";

export type AgentActionParse =
  | {
      kind: "ok";
      /**
       * What the agent asked for, or NULL when it emitted no `action` at all.
       *
       * `null` is not "reply". It means the model said NOTHING about
       * escalation, and the caller must be able to tell that apart so it can
       * fall back to whatever it did before this contract existed.
       *
       * An earlier draft defaulted a missing action to `"reply"` on the
       * reasoning that it "cannot manufacture an escalation". Adversarial
       * review killed it, correctly: a model that omits the field while
       * replying *"I'll bring in a colleague"* would have had its answer
       * delivered AND the legacy safety net suppressed, because a non-null
       * action tells the gateway to stop reading the text. That is a customer
       * promised a person nobody was told about — the exact defect this whole
       * module exists to remove, reintroduced by the fix for it.
       */
      action: AgentAction | null;
      /** The customer-facing text, kept SEPARATE from the action. */
      reply: string;
      /** Null for an ordinary reply, and for an escalation that named no reason. */
      reason: EscalationReasonCode | null;
      /**
       * True when the model emitted no `action` at all. Surfaced so a template
       * that is silently not honouring the contract is visible in the logs
       * rather than looking like a stream of ordinary replies.
       */
      actionDefaulted: boolean;
      /**
       * Set when a `reason` was present but not a known code. The reply is still
       * delivered — a bad reason code is not worth denying a customer their
       * answer — but the value is dropped rather than written to the audit trail.
       */
      reasonRejected: boolean;
    }
  | { kind: "invalid"; detail: string };

/**
 * A fenced block, which `response_format: json_object` should already prevent.
 *
 * Stripped anyway, and ONLY in this exact shape: a leading fence with an
 * optional language tag and a trailing fence. This cannot admit a payload that
 * would otherwise be rejected — everything inside is still parsed and still
 * schema-checked — so it converts a known formatting quirk into a working reply
 * without weakening a single validation rule.
 */
const FENCED = /^```(?:json)?\s*\r?\n([\s\S]*?)\r?\n?```$/i;

function unfence(raw: string): string {
  const trimmed = raw.trim();
  const m = FENCED.exec(trimmed);
  return m === null ? trimmed : (m[1] ?? "").trim();
}

/**
 * Parse and validate one structured agent turn.
 *
 * FAIL CLOSED, AND WHERE THE LINE IS.
 *
 * Two failure shapes are treated very differently, on purpose:
 *
 *  - **No `action` field at all** -> `action: null`, flagged. The model said
 *    nothing, so this reports nothing rather than inventing a decision. The
 *    caller then behaves exactly as it did before the contract existed — for
 *    the gateway that means the legacy phrase heuristic still runs, so the
 *    pre-existing safety net is preserved rather than silently switched off by
 *    a model that skipped a field.
 *
 *  - **An `action` that is present but unknown** -> `invalid`. The model tried
 *    to say something and this service does not know what. Coercing it to
 *    `"reply"` would silently discard an escalation the agent DID request —
 *    reintroducing the defect this contract exists to remove — and coercing it
 *    to `request_human` would let an unrecognised token silence the AI. So it is
 *    refused, the caller reports `invalid_output`, no answer is delivered and
 *    the conversation escalates as a FAILURE, which is visible.
 *
 * A missing or empty `reply` is likewise `invalid`: an action with no message
 * has nothing to send a customer, and inventing one is the one thing this
 * estate must never do.
 */
export function parseAgentAction(rawContent: string | null): AgentActionParse {
  if (rawContent === null) return { kind: "invalid", detail: "no content" };

  const text = unfence(rawContent);
  if (text.length === 0) return { kind: "invalid", detail: "empty content" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // The provider was asked for json_object. Anything else is a contract
    // breach, not something to salvage by reading the prose — reading the prose
    // is the mechanism being replaced.
    return { kind: "invalid", detail: "content is not valid json" };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { kind: "invalid", detail: "json is not an object" };
  }

  // Own enumerable properties only. A payload built by `JSON.parse` cannot carry
  // an inherited property, but reading through `Object.prototype` would be a
  // latent hazard if this were ever handed an object from elsewhere.
  const obj = parsed as Record<string, unknown>;
  const readOwn = (key: string): unknown => {
    const d = Object.getOwnPropertyDescriptor(obj, key);
    return d === undefined || !("value" in d) ? undefined : d.value;
  };

  const replyRaw = readOwn("reply");
  if (typeof replyRaw !== "string" || replyRaw.trim().length === 0) {
    return { kind: "invalid", detail: "reply is missing or not a non-empty string" };
  }

  const actionRaw = readOwn("action");
  let action: AgentAction | null;
  let actionDefaulted = false;
  if (actionRaw === undefined || actionRaw === null) {
    // NOT "reply". See the note on the `action` field above — reporting a
    // decision the model never made would suppress the caller's fallback.
    action = null;
    actionDefaulted = true;
  } else if (isAgentAction(actionRaw)) {
    action = actionRaw;
  } else {
    return {
      kind: "invalid",
      // The VALUE is not echoed: it originates from a model and could carry
      // customer content. Only its type is named.
      detail: `action is present but not one of ${AGENT_ACTIONS.join("|")}`,
    };
  }

  const reasonRaw = readOwn("reason");
  let reason: EscalationReasonCode | null = null;
  let reasonRejected = false;
  if (reasonRaw !== undefined && reasonRaw !== null && reasonRaw !== "") {
    if (isEscalationReasonCode(reasonRaw)) {
      reason = reasonRaw;
    } else {
      reasonRejected = true;
    }
  }

  // A reason on an ordinary reply is meaningless and is not carried: it would
  // put an escalation code on a turn that escalates nothing.
  if (action !== "request_human") reason = null;

  return { kind: "ok", action, reply: replyRaw, reason, actionDefaulted, reasonRejected };
}

/**
 * The instruction appended to the resolved system prompt for a structured
 * template.
 *
 * IT IS APPENDED BY THIS SERVICE, NOT WRITTEN INTO THE CHARTER. The charter is
 * fetched from Paperclip at reply time and can be edited by an operator; a
 * contract that lived there could be edited away, and the first sign would be
 * customers no longer reaching a human. Owning it here means the wire contract
 * and the code that validates it ship together.
 *
 * DeepSeek's JSON mode requires the word "json" and a worked example in the
 * prompt or generation can fail (api-docs.deepseek.com/guides/json_mode) — both
 * are present below, deliberately.
 *
 * The escalation example uses "I'm bringing in a colleague", which is the exact
 * sentence the phrase list did not match. Under this contract the wording is
 * free and the field is what counts.
 */
export const STRUCTURED_OUTPUT_INSTRUCTION = [
  "STRUCTURED OUTPUT — MANDATORY",
  "",
  "Reply with a single json object and nothing else: no markdown, no code fence, no text outside the json.",
  "",
  "Fields:",
  '  "reply"  REQUIRED. The exact message the customer will see. Write it exactly as you normally would.',
  '  "action" REQUIRED. Either "reply" or "request_human".',
  '  "reason" OPTIONAL, and only with "request_human". One of: ' +
    ESCALATION_REASON_CODES.join(", ") +
    ".",
  "",
  'Use "request_human" when you are handing this conversation to a person: they asked for a human, you are bringing in a colleague, you cannot answer from the supplied information, they are making a complaint, or the request needs a human decision.',
  'Use "reply" for every other turn — including turns where you are still asking the customer questions, and turns where you only OFFER to bring someone in. Only choose "request_human" on the turn you actually hand over.',
  "",
  "Never put an account id, inbox id, conversation id, team name, assignee or any other identifier in the json. You do not choose who this goes to.",
  "",
  "EXAMPLE JSON OUTPUT — an ordinary answer:",
  '{"action": "reply", "reply": "We offer fibre and fixed wireless in that area. Which one were you asking about?"}',
  "",
  "EXAMPLE JSON OUTPUT — handing over to a person:",
  '{"action": "request_human", "reason": "explicit_human_request", "reply": "Of course — I\'m bringing in a colleague who can help with that. They will pick this up shortly."}',
].join("\n");
