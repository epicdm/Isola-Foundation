/**
 * The HTTP surface. Plain node:http — no framework, no runtime dependencies.
 *
 * This is the ONLY publicly-exposed Isola component, so it fails closed
 * everywhere:
 *
 *  - no shell, no child processes  (nothing imports node:child_process)
 *  - no filesystem access at all   (nothing imports node:fs)
 *  - no MCP, no plugins, no custom tools — there is no extension point
 *  - outbound network only via src/egress.ts, against an explicit host allowlist
 *  - every inbound delivery must carry a valid Chatwoot HMAC over the RAW body
 *  - an inbox with no binding, a duplicate binding, a retired binding or an
 *    INTERNAL binding is refused; nothing is ever sent
 *  - `test/no-direct-network.test.ts` asserts all of the structural half by
 *    source scan
 *
 * THE 5-SECOND RULE. Chatwoot's webhook open/read timeout is 5s. This handler
 * does signature verification, de-duplication, binding resolution and the
 * suppression predicate synchronously — all pure, all in-memory — then ACKs
 * 200 and does every network call asynchronously. Nothing on the request path
 * may ever call the runtime or the Chatwoot API.
 */
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import {
  candidateSecrets,
  redactBinding,
  resolveBinding,
  StaticBindingStore,
  type Binding,
  type BindingStore,
} from "./bindings.js";
import { createChatwootApi, type ChatwootApi } from "./chatwoot.js";
import { configuredBindings, type GatewayConfig } from "./config.js";
import {
  bindingIdentity,
  payloadDigest,
  type LedgerIdentity,
} from "./deliveryref.js";
import { createSafeFetch, type SafeFetch } from "./egress.js";
import { createFailpoint, DISARMED, type Failpoint } from "./failpoint.js";
import { idempotencyKey } from "./idempotency.js";
import type { Ledger, ReserveResult, SqlClient } from "./ledger.js";
import type { OwnershipGate } from "./ownership.js";
import { constantTimeEquals } from "./signature.js";
import { checkSender } from "./allowlist.js";
import { classifyTurn, recordTurn } from "./turns.js";
import { createLogger, type Logger } from "./log.js";
import { processDelivery, type DeliveryJob, type DeliveryMode } from "./pipeline.js";
import { createAgentRuntime, type AgentRuntime } from "./runtime.js";
import {
  createMagnusPersonalLineSource,
  createRateLimiter,
  projectPersonalLine,
  resolveSeat,
  safeDecodeIdentifier,
  type PersonalLineSource,
  type RateLimiter,
} from "./voice.js";
import {
  DELIVERY_HEADER,
  parseDeliveryHeader,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  verifyChatwootSignature,
  type SignatureFailureReason,
} from "./signature.js";
import { SERVICE_VERSION } from "./version.js";
import {
  evaluateSuppression,
  hasAssignee,
  parseRouting,
  parseWebhookPayload,
  type NoTextClassification,
  type SuppressionReason,
  type WebhookPayload,
} from "./webhook.js";

export type Outcome =
  | "accepted"
  | "unauthorized"
  | "bad_request"
  | "payload_too_large"
  | "duplicate_suppressed"
  | "not_deduplicable"
  | "binding_not_found"
  | "binding_duplicate"
  | "binding_retired"
  | "binding_not_public"
  /**
   * The bound agent has not passed its versioned acceptance job. Refused before
   * any runtime invocation, whatever the exposure or binding status says.
   */
  | "binding_not_accepted"
  | "suppressed"
  /**
   * The event carried no routable account/inbox. Chatwoot sends these
   * routinely and they need no action. 422, not 401: answering 401 made a
   * normal event indistinguishable from a real signature failure.
   */
  | "unroutable_event"
  /**
   * The same event id re-presented with a different signed body. Refused with
   * 409 — not retryable, and alerted on. Chatwoot's own failure handling then
   * opens the conversation to a human, which is the right place for an anomaly.
   */
  | "ledger_conflict"
  /**
   * The durable ledger could not record the acceptance. Answered with 500,
   * which is one of the two statuses Chatwoot actually retries
   * (`RETRYABLE_AGENT_BOT_STATUSES = [429, 500]`, v4.16.1), so the delivery is
   * re-offered instead of being silently lost. After the third failed attempt
   * Chatwoot opens the conversation and posts `agent_bot.error_moved_to_open`,
   * so the customer reaches a human rather than nothing.
   */
  | "ledger_unavailable"
  | "not_found"
  | "method_not_allowed"
  | "no_admin_token_configured"
  /** The personal-line read is enabled but has no bearer configured. */
  | "no_voice_token_configured"
  /** Magnus is unreachable or not configured; no seat state can be reported. */
  | "voice_upstream_unavailable"
  | "rate_limited"
  /**
   * An INTERNAL line refused a sender who is not on its allowlist. A terminal
   * outcome: no brain, no ledger content, one static line back.
   */
  | "rejected_sender"
  | "ok";

/** Server-side only. The HTTP response never says which half failed. */
export type RejectionReason = SignatureFailureReason | "no_binding_secret" | "unparseable_body";

export type Handler = (req: IncomingMessage, res: ServerResponse) => void;

const CORRELATION_HEADER = "X-Isola-Correlation-Id";

function sendJson(
  res: ServerResponse,
  status: number,
  correlationId: string,
  body: Record<string, unknown>,
): void {
  const payload = JSON.stringify({ correlationId, ...body });
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload).toString(),
    [CORRELATION_HEADER]: correlationId,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(payload);
}

class PayloadTooLargeError extends Error {}

const DRAIN_MULTIPLIER = 8;
const DRAIN_FLOOR_BYTES = 1024 * 1024;
const DRAIN_CEILING_BYTES = 16 * 1024 * 1024;

/**
 * Read the body as BYTES. The signature covers the raw octets, so this buffer
 * is what gets verified — nothing re-serialises a parsed object.
 */
function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let overflowed = false;
    const drainCeiling = Math.min(
      Math.max(maxBytes * DRAIN_MULTIPLIER, DRAIN_FLOOR_BYTES),
      DRAIN_CEILING_BYTES,
    );

    const fail = (): void => {
      reject(new PayloadTooLargeError(`request body exceeded ${maxBytes} bytes`));
    };

    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        overflowed = true;
        chunks.length = 0;
        if (total > drainCeiling) {
          req.destroy();
          fail();
        }
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (overflowed) fail();
      else resolve(Buffer.concat(chunks));
    });
    req.on("close", () => {
      if (overflowed) fail();
    });
    req.on("error", (err) => reject(err));
  });
}

// ---------------------------------------------------------------------------
// The synchronous decision — pure except for the idempotency claim
// ---------------------------------------------------------------------------

export type DeliveryDecision =
  | {
      kind: "accept";
      binding: Binding;
      payload: WebhookPayload;
      conversationId: number;
      /**
       * `answer` invokes the model. `handoff` never does: the message carried
       * no usable text, so the conversation is opened, assigned, noted and
       * acknowledged instead. See `src/handoff.ts`.
       */
      mode: DeliveryMode;
      classification: NoTextClassification | null;
      /**
       * The webhook event id. Combined with the tenant, binding and routing
       * identifiers it forms the ledger's atomic key; every write is claimed
       * beneath it.
       */
      eventId: string;
    }
  | { kind: "reject"; reason: RejectionReason }
  | { kind: "not_deduplicable" }
  | { kind: "bad_request" }
  | { kind: "binding_refused"; outcome: Outcome; detail: Record<string, unknown> }
  | { kind: "suppressed"; reason: SuppressionReason; payload: WebhookPayload };

export interface DecideArgs {
  raw: Buffer;
  headers: IncomingMessage["headers"];
  bindings: readonly Binding[];
  nowMs: number;
  replayWindowSec: number;
}

export interface Routing {
  accountId: number | null;
  inboxId: number | null;
}

/**
 * The decision, plus the routing identifiers it was made against — so every log
 * line carries `accountId` and `inboxId` even on the branches that never reach
 * a binding.
 */
export interface DecideResult {
  decision: DeliveryDecision;
  routing: Routing;
}

/**
 * Decision order, and why:
 *
 *  1. Routing identifiers are read from the UNVERIFIED body — only to choose
 *     which AgentBot secret to check against. Nothing else trusts them.
 *  2. Signature. Every delivery addressed to this (account, inbox) pair is
 *     checked against every secret registered for it, including retired and
 *     (impossible-by-boot-validation) non-PUBLIC ones — so an authentic
 *     delivery to a retired bot is reported as "retired", not as "unauthorized".
 *  3. Binding resolution to exactly one active PUBLIC binding.
 *  4. The suppression predicate.
 *  5. The event id, on `X-Chatwoot-Delivery`, falling back to
 *     (account, conversation, message, event).
 *
 * Binding resolution now comes BEFORE de-duplication, where it used to come
 * after. That is forced by the ledger's atomic key, which is scoped by tenant
 * and binding: you cannot claim a key until you know whose key it is. The
 * observable consequence is small and strictly more informative — a duplicate
 * delivery to a retired binding is now reported as `binding_retired` rather
 * than `duplicate_suppressed`. Both are 200 with nothing done.
 *
 * This function stays PURE. The durable reservation is the caller's job,
 * because it is I/O and it must happen after this decision and before the ACK.
 *
 * A body that cannot be parsed enough to select a secret is `unparseable_body`
 * and is rejected with 401: an unverifiable request is not an authenticated one.
 */
export function decideDelivery(args: DecideArgs): DecideResult {
  const routing = parseRouting(args.raw);
  const at = (decision: DeliveryDecision): DecideResult => ({ decision, routing });

  if (routing.accountId === null || routing.inboxId === null) {
    return at({ kind: "reject", reason: "unparseable_body" });
  }

  const secrets = candidateSecrets(args.bindings, routing.accountId, routing.inboxId);
  if (secrets.length === 0) {
    return at({ kind: "reject", reason: "no_binding_secret" });
  }

  let firstFailure: SignatureFailureReason = "signature_mismatch";
  let verified = false;
  for (const [index, secret] of secrets.entries()) {
    const verdict = verifyChatwootSignature({
      raw: args.raw,
      signatureHeader: args.headers[SIGNATURE_HEADER],
      timestampHeader: args.headers[TIMESTAMP_HEADER],
      secret,
      nowMs: args.nowMs,
      windowSec: args.replayWindowSec,
    });
    if (verdict.ok) {
      verified = true;
      break;
    }
    if (index === 0) firstFailure = verdict.reason;
  }
  if (!verified) return at({ kind: "reject", reason: firstFailure });

  const payload = parseWebhookPayload(args.raw);
  if (payload === null) return at({ kind: "bad_request" });

  const resolution = resolveBinding(args.bindings, payload.accountId, payload.inboxId);
  switch (resolution.kind) {
    case "not_found":
      return at({ kind: "binding_refused", outcome: "binding_not_found", detail: {} });
    case "duplicate":
      return at({
        kind: "binding_refused",
        outcome: "binding_duplicate",
        detail: { matches: resolution.count },
      });
    case "retired":
      return at({
        kind: "binding_refused",
        outcome: "binding_retired",
        detail: { tenantId: resolution.tenantId },
      });
    case "not_public":
      return at({
        kind: "binding_refused",
        outcome: "binding_not_public",
        detail: { tenantId: resolution.tenantId, exposure: resolution.exposure },
      });
    case "not_accepted":
      // An agent that has not passed its versioned acceptance job never receives
      // customer traffic, whatever its exposure or binding status says.
      return at({
        kind: "binding_refused",
        outcome: "binding_not_accepted",
        detail: { tenantId: resolution.tenantId, lifecycle: resolution.lifecycle },
      });
    case "ok":
      break;
    default:
      return at({ kind: "binding_refused", outcome: "binding_not_found", detail: {} });
  }

  const verdict = evaluateSuppression(payload);
  if (verdict.action === "suppress") {
    return at({ kind: "suppressed", reason: verdict.reason, payload });
  }

  const eventId = idempotencyKey({
    deliveryId: parseDeliveryHeader(args.headers[DELIVERY_HEADER]),
    accountId: payload.accountId,
    conversationId: payload.conversationDisplayId,
    messageId: payload.messageId,
    event: payload.event,
  });
  if (eventId === null) return at({ kind: "not_deduplicable" });

  return at({
    kind: "accept",
    binding: resolution.binding,
    payload,
    // The suppression predicate has already refused a null display id.
    conversationId: payload.conversationDisplayId as number,
    mode: verdict.action === "handoff" ? "handoff" : "answer",
    classification: verdict.action === "handoff" ? verdict.classification : null,
    eventId,
  });
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

export interface GatewayDeps {
  config: GatewayConfig;
  logger?: Logger;
  /** Injected in tests; defaults to the env-configured static store. */
  bindingStore?: BindingStore;
  /** Injected in tests; defaults to the real allowlisted Chatwoot client. */
  chatwoot?: ChatwootApi;
  /** Injected in tests; defaults to the real allowlisted isola-runtime client. */
  runtime?: AgentRuntime;
  /**
   * The durable delivery ledger. Required: there is no in-memory default any
   * more, because "the store is missing" must never silently degrade into
   * "every delivery looks new". `server.ts` builds the real one and refuses to
   * boot without it; tests inject a fake.
   */
  ledger: Ledger;
  /**
   * The durable answer to "may the AI speak in this conversation". Required for
   * the same reason the ledger is: a missing ownership store must never
   * silently degrade into "every conversation looks AI-owned", which is the one
   * failure that puts an automated reply into a conversation a human is
   * holding. `server.ts` builds the Postgres-backed one; tests inject a fake.
   */
  ownership: OwnershipGate;
  /**
   * The SQL surface for conversation memory. Separate from `ledger` on purpose:
   * `Ledger` is a narrow delivery contract, and widening it to carry raw SQL
   * would let any future caller run statements through the delivery port.
   * Absent (as in most tests) means memory is simply not recorded — a gateway
   * without it answers exactly as it did before.
   */
  turnStore?: SqlClient;
  safeFetch?: SafeFetch;
  /** Injected in tests; defaults to the allowlisted signed Magnus client. */
  personalLineSource?: PersonalLineSource;
  /** Injected in tests; defaults to the env-configured fixed-window limiter. */
  voiceRateLimiter?: RateLimiter;
  /**
   * Test-only. Defaults to the env-configured failpoint, which is DISARMED in
   * every production deployment.
   */
  failpoint?: Failpoint;
  now?: () => number;
  newCorrelationId?: () => string;
}

export interface Gateway {
  handler: Handler;
  /** Await every delivery still being processed. Tests use this; so does shutdown. */
  drain(): Promise<void>;
  inflight(): number;
  bindingStore: BindingStore;
  /** Exposed so the recovery sweeper reuses the same allowlisted clients. */
  chatwoot: ChatwootApi;
  runtime: AgentRuntime;
  failpoint: Failpoint;
}

export function createApp(deps: GatewayDeps): Handler {
  return createGateway(deps).handler;
}

export function createGateway(deps: GatewayDeps): Gateway {
  const { config } = deps;
  const logger = deps.logger ?? createLogger();
  const now = deps.now ?? (() => Date.now());
  const newCorrelationId = deps.newCorrelationId ?? (() => randomUUID());

  const safeFetch =
    deps.safeFetch ?? createSafeFetch({ allowlist: config.egressAllowlist });

  const bindingStore =
    deps.bindingStore ?? new StaticBindingStore(configuredBindings(config));

  const chatwoot =
    deps.chatwoot ??
    createChatwootApi({
      baseUrl: config.chatwootBaseUrl,
      safeFetch,
      timeoutMs: config.chatwootTimeoutMs,
    });

  const runtime =
    deps.runtime ??
    createAgentRuntime({
      baseUrl: config.runtimeBaseUrl,
      invokePath: config.runtimeInvokePath,
      bearer: config.runtimeSecret,
      safeFetch,
      timeoutMs: config.runtimeTimeoutMs,
    });

  const ledger = deps.ledger;

  // `config.failpoint` is `"unrecognised"` only when the variable was set to
  // something unknown, and `server.ts` refuses to boot on that — so by the time
  // a gateway is constructed it is a real name or null.
  const failpoint =
    deps.failpoint ??
    (config.failpoint === null || config.failpoint === "unrecognised"
      ? DISARMED
      : createFailpoint({ armed: config.failpoint, logger }));

  const inflight = new Set<Promise<unknown>>();

  function track(work: Promise<unknown>): void {
    inflight.add(work);
    void work.finally(() => inflight.delete(work));
  }

  async function handleWebhook(
    req: IncomingMessage,
    res: ServerResponse,
    correlationId: string,
  ): Promise<void> {
    const startedAt = now();
    const deliveryId = parseDeliveryHeader(req.headers[DELIVERY_HEADER]);
    // Filled in as soon as the body has been read, so every log line below
    // carries the routing identifiers even on the branches that never reach a
    // binding.
    let routing: Routing = { accountId: null, inboxId: null };

    const finish = (
      status: number,
      outcome: Outcome,
      logFields: Record<string, unknown> = {},
      body: Record<string, unknown> = {},
    ): void => {
      logger.log(status === 200 ? "info" : "warn", {
        event: "webhook",
        correlationId,
        deliveryId,
        accountId: routing.accountId,
        inboxId: routing.inboxId,
        outcome,
        httpStatus: status,
        durationMs: now() - startedAt,
        ...logFields,
      });
      sendJson(res, status, correlationId, { ok: status === 200, outcome, ...body });
    };

    let raw: Buffer;
    try {
      raw = await readBody(req, config.maxRequestBytes);
    } catch (err) {
      if (err instanceof PayloadTooLargeError) {
        finish(413, "payload_too_large", {}, { error: "request body too large" });
        return;
      }
      finish(400, "bad_request", {}, { error: "could not read request body" });
      return;
    }

    const evaluated = decideDelivery({
      raw,
      headers: req.headers,
      bindings: bindingStore.list(),
      nowMs: now(),
      replayWindowSec: config.replayWindowSec,
    });
    routing = evaluated.routing;
    const decision = evaluated.decision;

    // ── THE INTERNAL ALLOWLIST ─────────────────────────────────────────────
    //
    // FIRST, and deliberately ahead of the turn ledger. A refused sender must
    // leave NO content behind: not in the model's context, not in the memory
    // table, not in an audit row that quotes them. The only trace is that
    // somebody who was not staff messaged the staff line.
    //
    // This runs before the reply switch, so a refused sender never reaches the
    // brain, never costs a token, and never wakes an agent that holds internal
    // context. PUBLIC bindings are untouched — checkSender returns allowed for
    // anything not INTERNAL.
    if (decision.kind === "accept" && decision.binding.exposure === "INTERNAL") {
      const b = decision.binding;
      const verdict = checkSender(b, decision.payload.senderPhone);
      if (!verdict.allowed) {
        // SILENCE. Ruled by the owner 2026-08-17.
        //
        // An INTERNAL line is never advertised to a customer, so there is nobody
        // to help by replying — and a reply CONFIRMS to a stranger that the
        // number is live and monitored. Saying nothing is the smaller surface.
        //
        // Silent to the sender, NOT silent to us: the refusal is logged with its
        // reason, and the brain is never invoked. "No message was sent" must
        // never mean "nothing was recorded".
        //
        // KNOWN COST, accepted deliberately: a NEW staff member who is not yet
        // onboarded gets nothing back and cannot tell whether the line is broken
        // or they are simply not on it. That is a real support burden and the
        // reason onboarding has to keep pace with hiring.
        finish(
          200,
          "rejected_sender",
          {
            tenantId: b.tenantId,
            conversationId: decision.conversationId,
            // The REASON, never the number. "not_allowlisted" and
            // "empty_allowlist" need different operator responses.
            reason: verdict.reason,
            allowlistSize: b.allowedSenders.length,
          },
          { status: "rejected_sender" },
        );
        return;
      }
    }

    // MEMORY. Record every real turn — the customer's, ours, and a HUMAN
    // AGENT'S — before the switch below decides whether to reply. Suppressed
    // deliveries carry turns too: an outgoing human reply is suppressed from
    // triggering the bot, but the bot must still know what the human said.
    // Never lets a memory failure cost a customer their reply.
    if (decision.kind === "accept" || decision.kind === "suppressed") {
      const turn = classifyTurn({
        event: decision.payload.event,
        messageType: decision.payload.messageType,
        private: decision.payload.private,
        content: decision.payload.content,
        messageId: decision.payload.messageId,
        senderType: decision.payload.senderType,
      });
      if (
        turn !== null &&
        deps.turnStore !== undefined &&
        decision.payload.conversationDisplayId !== null
      ) {
        const b = resolveBinding(
          bindingStore.list(),
          decision.payload.accountId,
          decision.payload.inboxId,
        );
        if (b.kind === "ok") {
          try {
            await recordTurn(deps.turnStore, {
              tenantId: b.binding.tenantId,
              accountId: b.binding.chatwootAccountId,
              conversationId: decision.payload.conversationDisplayId,
              messageId: decision.payload.messageId as number,
              role: turn.role,
              author: turn.author,
              content: turn.content,
            });
          } catch (err) {
            logger.warn({
              event: "turn",
              correlationId,
              outcome: "turn_record_failed",
              detail: err instanceof Error ? err.message : "unknown",
            });
          }
        }
      }
    }

    // OWNERSHIP RECONCILIATION.
    // def-handback-sweeper-is-blind-to-manually-assigned-conversations-2026-09-13.
    //
    // Runs ALONGSIDE the reply decision above, never inside it: `decision` was
    // already fully computed by the pure `decideDelivery`, so nothing below
    // this point can change what this turn replies. Best-effort, exactly like
    // the turn-recording block above it — any failure is logged and swallowed.
    //
    // Fires for BOTH "accept" and "suppressed". In practice this almost always
    // matches on a "suppressed" delivery: a conversation_updated event
    // carrying a newly-set assignee is not `message_created`, so
    // evaluateSuppression already discards it with `reason: "not_message_created"`
    // — discards it for the REPLY decision, which is correct and unchanged,
    // but that payload is exactly the signal this reconciliation exists to
    // read. Chatwoot's own AgentBotListener already delivers it to this same
    // Agent Bot endpoint for every inbox this gateway serves; nothing new is
    // subscribed to produce it.
    if (decision.kind === "accept" || decision.kind === "suppressed") {
      const payload = decision.payload;
      if (payload.conversationDisplayId !== null && deliveryId !== null) {
        const b =
          decision.kind === "accept"
            ? ({ kind: "ok" as const, binding: decision.binding })
            : resolveBinding(bindingStore.list(), payload.accountId, payload.inboxId);
        if (b.kind === "ok") {
          try {
            await deps.ownership.reconcileObservedAssignment({
              conversation: {
                tenantId: b.binding.tenantId,
                chatwootAccountId: b.binding.chatwootAccountId,
                chatwootConversationId: payload.conversationDisplayId,
                chatwootInboxId: b.binding.chatwootInboxId,
                bindingId: bindingIdentity(b.binding),
              },
              // Stable per delivery, so a Chatwoot redelivery of the identical
              // event is a no-op rather than a second write (the store's own
              // exactly-once claim key is (tenant, conversation, operationId)).
              operationId: `assignee_observed:${deliveryId}`,
              hasAssignee: hasAssignee(payload.assignee),
              status: payload.conversationStatus,
            });
          } catch (err) {
            // Never let a reconciliation failure look like a reply failure,
            // and never let it retry by re-throwing into the request path —
            // the next conversation_updated/status_changed delivery for this
            // conversation gets another chance, and the automatic idle-based
            // handback sweep is unaffected either way.
            logger.warn({
              event: "ownership",
              correlationId,
              outcome: "reconcile_observed_assignment_failed",
              detail: err instanceof Error ? err.message : "unknown",
            });
          }
        }
      }
    }

    switch (decision.kind) {
      case "reject": {
        // The reason is logged, never returned. Telling the caller which half
        // failed turns this endpoint into an oracle for the replay window and
        // for which inboxes exist.
        //
        // ONE EXCEPTION, and it is not a weakening of that rule.
        //
        // `unparseable_body` is decided BEFORE any secret is consulted: it just
        // means the body carried no account/inbox to route by. Chatwoot itself
        // sends such events routinely — entity events that are not about an
        // inbox at all — and answering 401 to them made a normal, expected,
        // harmless event indistinguishable in the logs from a genuine signature
        // failure. That poisons the one alarm you actually want to trust.
        //
        // It leaks nothing: the caller already knows the shape of the body it
        // sent, and no secret, no binding and no inbox existence is involved in
        // reaching this branch. `no_binding_secret` and every signature failure
        // DO leak inbox existence or replay-window state, so they stay 401 and
        // stay opaque.
        //
        // 422 rather than 204: 204 would claim we processed it. We did not.
        if (decision.reason === "unparseable_body") {
          finish(422, "unroutable_event", { rejectionReason: decision.reason }, {
            error: "event carries no routable account/inbox and was not processed",
          });
          return;
        }
        finish(401, "unauthorized", { rejectionReason: decision.reason }, {
          error: "unauthorized",
        });
        return;
      }

      case "bad_request":
        finish(400, "bad_request", {}, { error: "body must be a JSON object" });
        return;

      case "not_deduplicable":
        finish(200, "not_deduplicable", {
          detail:
            "no X-Chatwoot-Delivery header and no (account, conversation, message, event) key: this delivery cannot be de-duplicated, so nothing was done",
        });
        return;

      case "binding_refused":
        // 200 so Chatwoot stops retrying; nothing is sent.
        finish(200, decision.outcome, decision.detail);
        return;

      case "suppressed":
        finish(
          200,
          "suppressed",
          {
            suppressionReason: decision.reason,
            conversationId: decision.payload.conversationDisplayId,
          },
          { suppressionReason: decision.reason },
        );
        return;

      case "accept":
        break;

      default:
        finish(400, "bad_request", {}, { error: "unhandled decision" });
        return;
    }

    // ---- DURABLY RESERVE, THEN ACK. ---------------------------------------
    //
    // This is the whole point of the ledger. The acceptance is written to a
    // store that survives this container BEFORE the 200 goes out, so an
    // acknowledged delivery can never be forgotten by a restart, and a
    // duplicate arriving after a restart still finds the claim.
    //
    // It is one INSERT against a private Postgres on the container network —
    // single-digit milliseconds, comfortably inside Chatwoot's 5s deadline. No
    // model call, no Chatwoot call, nothing else happens before the ACK; the
    // `no Chatwoot or runtime call on the request path` property is unchanged
    // and still asserted by test/webhook-http.test.ts.
    const identity: LedgerIdentity = {
      tenantId: decision.binding.tenantId,
      bindingId: bindingIdentity(decision.binding),
      chatwootAccountId: decision.binding.chatwootAccountId,
      chatwootInboxId: decision.binding.chatwootInboxId,
      eventId: decision.eventId,
    };
    const digest = payloadDigest(raw);

    let reservation: ReserveResult;
    try {
      reservation = await ledger.reserve({
        identity,
        digest,
        correlationId,
        conversationId: decision.conversationId,
        messageId: decision.payload.messageId,
        mode: decision.mode,
        leaseMs: config.ledgerLeaseMs,
      });
    } catch (err) {
      // Do NOT acknowledge. A 200 here would tell Chatwoot the delivery is
      // handled while nothing durable records it — precisely the silent loss
      // this work exists to prevent. 500 is retryable for an AgentBot webhook,
      // and after the retries are spent Chatwoot escalates to a human itself.
      logger.error({
        event: "webhook",
        alert: true,
        alertCode: "ledger_unavailable_on_ack",
        correlationId,
        deliveryId,
        accountId: routing.accountId,
        inboxId: routing.inboxId,
        tenantId: decision.binding.tenantId,
        outcome: "ledger_unavailable",
        httpStatus: 500,
        durationMs: now() - startedAt,
        detail: err instanceof Error ? err.name : "unknown ledger failure",
      });
      sendJson(res, 500, correlationId, {
        ok: false,
        outcome: "ledger_unavailable",
        error: "delivery could not be durably recorded; retry",
      });
      return;
    }

    if (reservation.kind === "conflict") {
      // Same event id, different signed body. Not a retry — a collision or a
      // tampering attempt. Refuse it and alert; never process it.
      logger.error({
        event: "webhook",
        alert: true,
        alertCode: "delivery_digest_conflict",
        correlationId,
        deliveryId,
        accountId: routing.accountId,
        inboxId: routing.inboxId,
        tenantId: decision.binding.tenantId,
        outcome: "ledger_conflict",
        httpStatus: 409,
        durationMs: now() - startedAt,
        // Digests only. Neither body is logged.
        presentedDigest: digest,
        storedDigest: reservation.storedDigest,
      });
      sendJson(res, 409, correlationId, {
        ok: false,
        outcome: "ledger_conflict",
        error: "this delivery id was already recorded with a different payload",
      });
      return;
    }

    if (reservation.kind === "duplicate") {
      // 200 and absolutely nothing else — now durable across a restart.
      finish(200, "duplicate_suppressed", { priorState: reservation.state });
      return;
    }

    const job: DeliveryJob = {
      correlationId,
      deliveryId,
      identity,
      digest,
      binding: decision.binding,
      payload: decision.payload,
      conversationId: decision.conversationId,
      startedAtMs: startedAt,
      mode: decision.mode,
      classification: decision.classification,
    };

    // ---- ACK NOW. Everything below this line is asynchronous. --------------
    // The handoff is on the asynchronous side too: opening, assigning, noting
    // and acknowledging are four Chatwoot round trips, and none of them may be
    // inside Chatwoot's 5s webhook deadline.
    finish(200, "accepted", {
      reservation: reservation.kind,
      attempts: reservation.attempts,
      accountId: decision.binding.chatwootAccountId,
      inboxId: decision.binding.chatwootInboxId,
      conversationId: decision.conversationId,
      tenantId: decision.binding.tenantId,
      mode: decision.mode,
      ...(decision.classification === null
        ? {}
        : {
            handoffReason: decision.classification.reason,
            attachmentCount: decision.classification.attachmentCount,
          }),
    });

    track(
      processDelivery(
        { config, chatwoot, runtime, logger, ledger, ownership: deps.ownership, failpoint, now, turnStore: deps.turnStore },
        job,
      ).catch(
        (err: unknown) => {
          logger.error({
            event: "delivery",
            correlationId,
            deliveryId,
            accountId: decision.binding.chatwootAccountId,
            inboxId: decision.binding.chatwootInboxId,
            conversationId: decision.conversationId,
            tenantId: decision.binding.tenantId,
            outcome: "pipeline_crashed",
            durationMs: now() - startedAt,
            detail: err instanceof Error ? err.name : "unknown",
          });
        },
      ),
    );
  }

  /**
   * Reports ledger reachability, but stays 200 while the ledger is down. The
   * orchestrator must not kill and reschedule this container because its
   * database blinked — the webhook path already fails closed with a retryable
   * 500 on its own. `ledger: "unreachable"` is the field to alert on.
   */
  async function handleHealth(res: ServerResponse, correlationId: string): Promise<void> {
    const bindings = bindingStore.list();
    const ledgerHealthy = await ledger.healthy().catch(() => false);
    sendJson(res, 200, correlationId, {
      status: "ok",
      version: SERVICE_VERSION,
      bindings: {
        total: bindings.length,
        active: bindings.filter((b) => b.status === "active").length,
        retired: bindings.filter((b) => b.status !== "active").length,
      },
      ledger: ledgerHealthy ? "ok" : "unreachable",
      // Impossible to run an armed failpoint unnoticed.
      failpoint: failpoint.armed,
      egressAllowlist: config.egressAllowlist,
      inflightDeliveries: inflight.size,
    });
  }

  function handleBindings(
    req: IncomingMessage,
    res: ServerResponse,
    correlationId: string,
  ): void {
    if (config.adminToken === null) {
      logger.warn({
        event: "bindings",
        correlationId,
        outcome: "no_admin_token_configured",
        httpStatus: 503,
      });
      sendJson(res, 503, correlationId, {
        ok: false,
        outcome: "no_admin_token_configured",
        error: "GATEWAY_ADMIN_TOKEN is not configured",
      });
      return;
    }
    const header = req.headers["authorization"];
    const rawHeader = Array.isArray(header) ? header[0] : header;
    const match =
      typeof rawHeader === "string" ? /^Bearer[ ]+(.+)$/i.exec(rawHeader.trim()) : null;
    const token = match === null ? null : (match[1] ?? "").trim();
    // ROTATION GRACE. Both configured values are compared, always, with no
    // early exit, so the number of comparisons does not reveal which matched.
    // A NEXT value grants exactly what the current one does and nothing more.
    const matchesCurrent =
      token !== null && token.length > 0 && constantTimeEquals(token, config.adminToken);
    const matchesNext =
      token !== null &&
      token.length > 0 &&
      config.adminTokenNext !== null &&
      constantTimeEquals(token, config.adminTokenNext);
    if (!matchesCurrent && !matchesNext) {
      logger.warn({
        event: "bindings",
        correlationId,
        outcome: "unauthorized",
        httpStatus: 401,
      });
      sendJson(res, 401, correlationId, {
        ok: false,
        outcome: "unauthorized",
        error: "unauthorized",
      });
      return;
    }
    sendJson(res, 200, correlationId, {
      ok: true,
      outcome: "ok",
      chatwootBaseUrl: config.chatwootBaseUrl,
      runtimeBaseUrl: config.runtimeBaseUrl,
      bindings: bindingStore.list().map(redactBinding),
    });
  }

  const personalLineSource: PersonalLineSource | null =
    deps.personalLineSource ??
    (config.magnusBaseUrl !== null &&
    config.magnusApiKey !== null &&
    config.magnusApiSecret !== null
      ? createMagnusPersonalLineSource({
          baseUrl: config.magnusBaseUrl,
          apiKey: config.magnusApiKey,
          apiSecret: config.magnusApiSecret,
          safeFetch,
          timeoutMs: config.magnusTimeoutMs,
        })
      : null);

  const voiceRateLimiter =
    deps.voiceRateLimiter ??
    createRateLimiter(config.voiceRateLimit, config.voiceRateWindowMs);

  /**
   * `GET /v1/tenants/{tenantId}/members/{memberId}/personal-line`
   *
   * A read. There is no write twin here and there must not be one — NocoBase
   * owns the operator control plane. The browser never speaks to Magnus: the
   * portal's server calls this, and this builds the signed Magnus request.
   *
   * Everything that is not an authenticated, in-scope, resolvable seat answers
   * **404** — the same status as an unknown route. A 403 would confirm that the
   * tenant exists, which is exactly the enumeration this must not permit.
   */
  async function handlePersonalLine(
    req: IncomingMessage,
    res: ServerResponse,
    correlationId: string,
    tenantId: string,
    memberId: string,
  ): Promise<void> {
    const startedAt = now();

    // Audit carries route, outcome and correlation id — and identifiers only.
    // No seat field, no upstream body, no credential, ever.
    const finish = (
      status: number,
      outcome: Outcome,
      body: Record<string, unknown> = {},
      extra: Record<string, unknown> = {},
    ): void => {
      logger.log(status === 200 ? "info" : "warn", {
        event: "personal_line_read",
        correlationId,
        tenantId,
        memberId,
        route: "/v1/tenants/:tenantId/members/:memberId/personal-line",
        outcome,
        httpStatus: status,
        durationMs: now() - startedAt,
        ...extra,
      });
      sendJson(res, status, correlationId, { ok: status === 200, outcome, ...body });
    };

    if (config.voiceReadToken === null) {
      finish(503, "no_voice_token_configured", {
        error: "GATEWAY_VOICE_READ_TOKEN is not configured",
      });
      return;
    }

    const header = req.headers["authorization"];
    const rawHeader = Array.isArray(header) ? header[0] : header;
    const match =
      typeof rawHeader === "string" ? /^Bearer[ ]+(.+)$/i.exec(rawHeader.trim()) : null;
    const token = match === null ? null : (match[1] ?? "").trim();
    if (
      token === null ||
      token.length === 0 ||
      !constantTimeEquals(token, config.voiceReadToken)
    ) {
      finish(401, "unauthorized", { error: "unauthorized" });
      return;
    }

    // Rate limit AFTER authentication, so an unauthenticated flood cannot
    // exhaust a legitimate caller's budget, and keyed per seat so one tenant
    // cannot starve another.
    if (!voiceRateLimiter.take(`${tenantId}:${memberId}`, now())) {
      finish(429, "rate_limited", { error: "too many requests" });
      return;
    }

    // `resolveSeat` takes the whole parse RESULT and refuses anything whose
    // `ok` is not literally true, so a partially-invalid mapping resolves
    // nothing. Unknown seat, wrong tenant and rejected mapping are
    // indistinguishable here, and the upstream is never called for any of them.
    const seat = resolveSeat(config.voiceSeats, tenantId, memberId);
    if (seat === null) {
      finish(404, "not_found", { error: "not found" });
      return;
    }

    if (personalLineSource === null) {
      finish(503, "voice_upstream_unavailable", {
        error: "voice upstream is not configured",
      });
      return;
    }

    let upstream: Record<string, unknown> | null;
    try {
      upstream = await personalLineSource.fetchSeat(seat);
    } catch (err) {
      // Category only. A raw Magnus error may echo the credential it rejected.
      finish(
        503,
        "voice_upstream_unavailable",
        { error: "voice upstream unavailable" },
        { detail: err instanceof Error ? err.name : "unknown" },
      );
      return;
    }

    if (upstream === null) {
      finish(404, "not_found", { error: "not found" });
      return;
    }

    finish(200, "ok", { personalLine: projectPersonalLine(upstream) });
  }

  const handler: Handler = function handler(
    req: IncomingMessage,
    res: ServerResponse,
  ): void {
    const correlationId = newCorrelationId();
    let pathname = "/";
    try {
      pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    } catch {
      pathname = "/";
    }
    const method = (req.method ?? "GET").toUpperCase();

    const fail = (status: number, outcome: Outcome, error: string): void => {
      logger.warn({
        event: "request",
        correlationId,
        outcome,
        httpStatus: status,
        pathname,
        method,
      });
      sendJson(res, status, correlationId, { ok: false, outcome, error });
    };

    if (method === "GET" && pathname === "/healthz") {
      void handleHealth(res, correlationId).catch(() => {
        if (!res.headersSent) {
          sendJson(res, 200, correlationId, {
            status: "ok",
            version: SERVICE_VERSION,
            ledger: "unreachable",
          });
        }
      });
      return;
    }
    if (pathname === "/v1/bindings") {
      if (method !== "GET") {
        fail(405, "method_not_allowed", "method not allowed");
        return;
      }
      handleBindings(req, res, correlationId);
      return;
    }
    // KILL SWITCH. While disabled the route is not matched at all, so it 404s
    // exactly like any unknown path — the endpoint's existence is not
    // observable until it is deliberately turned on.
    if (config.voiceReadEnabled) {
      const seatRoute =
        /^\/v1\/tenants\/([^/]+)\/members\/([^/]+)\/personal-line$/.exec(pathname);
      if (seatRoute !== null) {
        // GET only — the published contract is GET, so HEAD is refused too
        // rather than silently taking the JSON response path. No method other
        // than an authenticated GET can reach the upstream read.
        if (method !== "GET") {
          fail(405, "method_not_allowed", "method not allowed");
          return;
        }
        // Decoding is guarded: `decodeURIComponent` throws URIError
        // synchronously on malformed percent-encoding, which would escape the
        // asynchronous handler's catch entirely. A bad identifier is the same
        // 404 as an unknown route.
        const tenantId = safeDecodeIdentifier(seatRoute[1] ?? "");
        const memberId = safeDecodeIdentifier(seatRoute[2] ?? "");
        if (tenantId === null || memberId === null) {
          fail(404, "not_found", "not found");
          return;
        }
        void handlePersonalLine(req, res, correlationId, tenantId, memberId).catch(
          (err: unknown) => {
            logger.error({
              event: "personal_line_read",
              correlationId,
              outcome: "voice_upstream_unavailable",
              httpStatus: 503,
              detail: err instanceof Error ? err.name : "unknown",
            });
            if (!res.headersSent) {
              sendJson(res, 503, correlationId, {
                ok: false,
                outcome: "voice_upstream_unavailable",
                error: "voice upstream unavailable",
              });
            } else {
              res.end();
            }
          },
        );
        return;
      }
    }
    if (pathname === "/v1/chatwoot/agent-bot") {
      if (method !== "POST") {
        fail(405, "method_not_allowed", "method not allowed");
        return;
      }
      handleWebhook(req, res, correlationId).catch((err: unknown) => {
        logger.error({
          event: "webhook",
          correlationId,
          outcome: "bad_request",
          httpStatus: 500,
          detail: err instanceof Error ? err.name : "unknown",
        });
        if (!res.headersSent) {
          sendJson(res, 500, correlationId, {
            ok: false,
            outcome: "bad_request",
            error: "internal error",
          });
        } else {
          res.end();
        }
      });
      return;
    }
    fail(404, "not_found", "not found");
  };

  return {
    handler,
    inflight: () => inflight.size,
    bindingStore,
    chatwoot,
    runtime,
    failpoint,
    drain: async () => {
      // Deliveries can be started while we wait, so loop until the set drains.
      while (inflight.size > 0) {
        await Promise.allSettled([...inflight]);
      }
    },
  };
}
