/**
 * The HTTP surface. Plain node:http — no framework, no runtime dependencies.
 *
 * Security posture, restated because it is the reason this service exists:
 *  - no shell, no child processes  (nothing imports node:child_process)
 *  - no filesystem access except the durable state store: `src/state.ts` is the ONLY
 *    module permitted to import node:fs, it may touch only RUNTIME_STATE_DIR, and
 *    test/no-direct-network.test.ts asserts both by source scan
 *  - no MCP, no plugins, no custom tools — there is no extension point at all
 *  - outbound network only via src/egress.ts, against an explicit host allowlist
 *  - templates are hardcoded; the request may select one, never define one
 *  - the caller's bearer decides which exposure class it may run
 */
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { RuntimeConfig } from "./config.js";
import { hasAnyCredential } from "./config.js";
import { resolveCredential } from "./auth.js";
import {
  nextActionFor,
  postNoticeComment,
  renderBudgetAlertComment,
  renderBudgetExhaustedComment,
  statusForRun,
  transitionIssue,
  transitionNotAttempted,
} from "./callbacks.js";
import { buildUserMessage, renderContext } from "./context.js";
import {
  ConversationIssues,
  asContextString,
  extractConversationRef,
  extractTenantId,
  readContextPath,
} from "./conversation.js";
import { createSafeFetch, type SafeFetch } from "./egress.js";
import {
  createInstructionsProvider,
  type InstructionsProvider,
} from "./instructions.js";
import {
  ModelInvalidOutputError,
  ModelProviderError,
  ModelTimeoutError,
} from "./errors.js";
import { createLogger, type Logger } from "./log.js";
import { buildIdempotencyKey, MeteringService, type MeteringOptions } from "./metering.js";
import { createOpenAiCompatibleClient, type ModelClient } from "./model.js";
import type { TokenUsage } from "./money.js";
import { createPaperclipApi, type PaperclipApi, type PaperclipCall } from "./paperclip.js";
import {
  createStateStore,
  type RunResultRecord,
  type RunUsageRecord,
  type StateStore,
} from "./state.js";
import {
  allTemplates,
  findTemplate,
  healthTemplateSummary,
  normaliseRequestedExposure,
  templateMetadata,
  type Exposure,
  type TemplateEntry,
} from "./registry.js";
import {
  createRecorder,
  type RunOutcome,
  type RunRecorder,
  type RunStatus,
} from "./recorder.js";
import {
  RESPONSE_CONTRACT_VERSION,
  RESPONSE_MODES,
  completionStateForOutcome,
  inlineFailureBody,
  inlineHttpStatus,
  inlineSuccessBody,
  isCompletionState,
  parseResponseMode,
  type CompletionState,
  type InlineUsage,
  type ResponseMode,
} from "./response.js";
import { SERVICE_VERSION } from "./version.js";

export type Outcome =
  | "ok"
  | "unauthorized"
  | "no_credential_configured"
  | "bad_request"
  | "unknown_template"
  | "exposure_mismatch"
  | "payload_too_large"
  | "model_timeout"
  | "provider_error"
  | "internal_error"
  | "not_found"
  /** 400: `responseMode` was present but is not a mode this version implements. */
  | "unsupported_response_mode"
  /**
   * 502, `responseMode:"inline"` only: the model answered but Paperclip would
   * not accept the write-back. The answer was not persisted, so it is not
   * returned and the run is NOT reported as completed.
   */
  | "persistence_failed"
  /** 402: the monthly budget is committed in full. The provider was NOT called. */
  | "budget_exhausted"
  /** 503: measured spend has not reached the ledger. Fail closed, do not run. */
  | "cost_delivery_unconfirmed"
  /** A duplicate of a run that is still in flight. Nothing was done twice. */
  | "duplicate_run_suppressed";

export interface AppDeps {
  config: RuntimeConfig;
  logger?: Logger;
  /** Injected in tests; defaults to the real allowlisted OpenAI-compatible client. */
  modelClient?: ModelClient;
  /** Injected in tests; defaults to Paperclip-or-Null based on config. */
  recorder?: RunRecorder;
  /** Injected in tests; defaults to the real Paperclip REST client, or null. */
  paperclipApi?: PaperclipApi | null;
  /** Injected in tests; defaults to the configured file or in-memory store. */
  stateStore?: StateStore;
  safeFetch?: SafeFetch;
  /** Injectable so tests can drive prompt resolution without a network. */
  instructions?: InstructionsProvider;
  now?: () => number;
  newCorrelationId?: () => string;
}

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

/**
 * After an overflow we keep reading (and discarding) so the client can finish
 * its write and actually receive the 413 instead of a reset socket — but only
 * up to a bounded amount, after which the connection is cut.
 */
const DRAIN_MULTIPLIER = 8;
const DRAIN_FLOOR_BYTES = 1024 * 1024;
const DRAIN_CEILING_BYTES = 16 * 1024 * 1024;

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
        // Stop buffering immediately, but keep reading so the client finishes
        // its write and can read our 413 instead of seeing a reset socket.
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

// One implementation of the context-reading semantics, shared with the
// conversation reference resolver so the two cannot drift apart.
const asString = asContextString;
const nested = readContextPath;

/**
 * Resolve the issue id from the run context.
 *
 * ONLY explicit, unambiguous fields are accepted. There is deliberately no
 * "first element of an array" or "any key ending in Id" rule: transitioning the
 * wrong issue is worse than transitioning none, and the contract is that a run
 * with no resolvable issue is logged as `no_issue_context` and left alone.
 */
const ISSUE_ID_PATHS: readonly (readonly string[])[] = [
  ["issueId"],
  ["issue_id"],
  ["issue", "id"],
  ["task", "issueId"],
  ["task", "issue_id"],
  ["task", "issue", "id"],
  ["assignedIssue", "id"],
  ["paperclip", "issueId"],
  ["run", "issueId"],
];

export function extractIssueId(context: unknown): string | null {
  if (typeof context !== "object" || context === null) return null;
  for (const path of ISSUE_ID_PATHS) {
    const value = nested(context, path);
    if (value !== null) return value;
  }
  return null;
}

const COMPANY_ID_PATHS: readonly (readonly string[])[] = [
  ["companyId"],
  ["company_id"],
  ["company", "id"],
  ["paperclip", "companyId"],
];

/** Company that owns the cost events. Falls back to PAPERCLIP_COMPANY_ID. */
export function extractCompanyId(context: unknown): string | null {
  if (typeof context !== "object" || context === null) return null;
  for (const path of COMPANY_ID_PATHS) {
    const value = nested(context, path);
    if (value !== null) return value;
  }
  return null;
}

export interface InvokeRequestShape {
  templateId: unknown;
  exposure: unknown;
  agentId: unknown;
  runId: unknown;
  /**
   * Who ISSUED `runId`. Only the literal "paperclip" means Paperclip did, and
   * only then may it be sent as `x-paperclip-run-id` — that header populates two
   * FOREIGN KEYS into a table only Paperclip writes.
   *
   * Absent means NOT issued, so the gateway (which sends its own delivery id)
   * needs no change and the default is the safe one.
   */
  runIdIssuedBy: unknown;
  context: unknown;
  /**
   * Optional and versioned. Absent or `"none"` is exactly today's behaviour;
   * `"inline"` additionally returns the persisted answer. Anything else is a
   * 400 — see `parseResponseMode`.
   */
  responseMode: unknown;
}

export function parseInvokeBody(raw: Buffer): InvokeRequestShape | null {
  if (raw.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const body = parsed as Record<string, unknown>;
  return {
    templateId: body["templateId"],
    exposure: body["exposure"],
    agentId: body["agentId"],
    runId: body["runId"],
    runIdIssuedBy: body["runIdIssuedBy"],
    context: body["context"],
    responseMode: body["responseMode"],
  };
}

/**
 * Exposure decision. Pure, and the single place the boundary is decided.
 *
 * Order matters and is deliberate:
 *  1. the template's registry exposure has no credential configured  -> 503
 *  2. credential exposure != template exposure                       -> 403
 *  3. the request's advisory `exposure` disagrees with the credential -> 403
 *
 * Rule 3 keeps the original fail-closed behaviour: a missing or unrecognised
 * `exposure` collapses to INTERNAL, so a PUBLIC template still only runs when
 * the request explicitly and correctly declares PUBLIC. The credential remains
 * the thing that actually decides; the body can only narrow, never widen.
 */
export type ExposureDecision =
  | { kind: "allow"; exposure: Exposure }
  | { kind: "no_credential_configured" }
  | { kind: "mismatch"; reason: string };

export function decideExposure(args: {
  template: TemplateEntry;
  credentialExposure: Exposure;
  requestedExposureRaw: unknown;
  configuredExposures: Readonly<Record<Exposure, string | null>>;
}): ExposureDecision {
  const templateExposure = args.template.exposure;

  if (args.configuredExposures[templateExposure] === null) {
    return { kind: "no_credential_configured" };
  }
  if (templateExposure !== args.credentialExposure) {
    return {
      kind: "mismatch",
      reason: "credential is not authorised for this template's exposure class",
    };
  }
  const advisory = normaliseRequestedExposure(args.requestedExposureRaw);
  if (advisory !== args.credentialExposure) {
    return {
      kind: "mismatch",
      reason: "request exposure does not match the credential exposure",
    };
  }
  return { kind: "allow", exposure: templateExposure };
}

/**
 * The assembled runtime. `server.ts` needs the metering service as well as the
 * handler so it can reconcile the outbox on startup and sweep it periodically.
 */
export interface Runtime {
  handler: Handler;
  metering: MeteringService;
  stateStore: StateStore;
}

export function createApp(deps: AppDeps): Handler {
  return createRuntime(deps).handler;
}

export function createRuntime(deps: AppDeps): Runtime {
  const { config } = deps;
  const logger = deps.logger ?? createLogger();
  const now = deps.now ?? (() => Date.now());
  const newCorrelationId = deps.newCorrelationId ?? (() => randomUUID());

  const safeFetch =
    deps.safeFetch ?? createSafeFetch({ allowlist: config.egressAllowlist });

  const modelClient =
    deps.modelClient ??
    createOpenAiCompatibleClient({
      baseUrl: config.modelBaseUrl,
      apiKey: config.modelApiKey,
      safeFetch,
    });

  /**
   * WHICH BRAIN SERVES THIS TEMPLATE.
   *
   * THE DEFAULT IS UNTOUCHED, and that is the guarantee this function exists to
   * make: a template with no `modelBaseUrl` gets `modelClient` — the same object
   * built above, the same endpoint, the same request. 6737 and 3742 are that
   * case. `test/model-menu.test.ts` sabotage-verifies it.
   *
   * Clients are cached per endpoint so a template does not construct one per
   * request, and an override with no resolvable credential FAILS CLOSED to an
   * error rather than silently falling back to the default provider — sending a
   * staff conversation to the customer brain is precisely the defect this fixes.
   */
  const overrideClients = new Map<string, ModelClient>();
  const clientForTemplate = (template: TemplateEntry): ModelClient => {
    const base = template.modelBaseUrl;
    if (base === undefined) return modelClient;
    const cached = overrideClients.get(base);
    if (cached !== undefined) return cached;
    const keyEnv = template.modelApiKeyEnv;
    const apiKey = keyEnv === undefined ? null : (process.env[keyEnv] ?? null);
    if (apiKey === null) {
      throw new ModelProviderError(
        `template ${template.id} declares modelBaseUrl but ${keyEnv ?? "no credential"} is unset`,
      );
    }
    const made = createOpenAiCompatibleClient({ baseUrl: base, apiKey, safeFetch });
    overrideClients.set(base, made);
    return made;
  };

  const recorder =
    deps.recorder ??
    createRecorder({
      baseUrl: config.paperclipBaseUrl,
      apiKey: config.paperclipApiKey,
      apiKeyByExposure: config.paperclipAgentKeys,
      pathTemplate: config.paperclipRecordPath,
      safeFetch,
    });

  const paperclipApi =
    deps.paperclipApi !== undefined
      ? deps.paperclipApi
      : createPaperclipApi({ baseUrl: config.paperclipBaseUrl, safeFetch });

  /**
   * A template is only bound to Paperclip when BOTH a mapping and a board token are
   * configured. Without the token the map collapses to empty and every template keeps
   * its compiled-in prompt — a missing credential must not silently become the
   * fail-closed prompt for live customers.
   */
  const instructions =
    deps.instructions ??
    createInstructionsProvider({
      baseUrl: config.paperclipBaseUrl ?? "",
      map:
        config.paperclipBoardToken === null || config.paperclipBaseUrl === null
          ? {}
          : config.paperclipInstructionsMap,
      // Same "no board token/base URL, no binding at all" collapse as the persona map
      // above -- an unreachable credential must never silently become "every agent is
      // authorized", it must become "no agent is authorized".
      businessFactsMap:
        config.paperclipBoardToken === null || config.paperclipBaseUrl === null
          ? {}
          : config.paperclipBusinessFactsMap,
      readToken: () => config.paperclipBoardToken ?? "",
      safeFetch,
      ttlMs: config.paperclipInstructionsTtlMs,
      timeoutMs: config.paperclipInstructionsTimeoutMs,
      now,
    });

  const stateStore =
    deps.stateStore ??
    createStateStore({
      backend: config.stateBackend,
      dir: config.stateDir,
      onWarn: (detail) =>
        logger.warn({ event: "state_store", outcome: "state_store_degraded", detail }),
    });

  const agentKeyFor = (exposure: string): string | null =>
    exposure === "PUBLIC"
      ? config.paperclipAgentKeys.PUBLIC
      : config.paperclipAgentKeys.INTERNAL;

  const meteringOptions: MeteringOptions = {
    companyIdDefault: config.paperclipCompanyId,
    provider: config.modelProvider,
    rateOverrides: config.rateOverrides,
    syntheticEnabled: config.syntheticPricing,
    alertPct: config.budgetAlertPct,
    // Non-null by the time we get here: bootErrors refuses to start the process
    // when enforcement is on and this is unset. The `?? 0` is unreachable and
    // deliberately NOT a permissive value — 0 would be rejected by
    // evaluateBudget's own guard rather than becoming "unlimited" again.
    budgetFallbackCents: config.budgetFallbackCents ?? 0,
    budgetRefreshMs: config.budgetRefreshMs,
    budgetEnforcement: config.budgetEnforcement,
    pauseOnExhausted: config.pauseOnExhausted,
    maxUndeliveredCents: config.maxUndeliveredCostCents,
    maxUndeliveredAgeMs: config.maxUndeliveredAgeMs,
    reservationTtlMs: config.reservationTtlMs,
    idempotencyTtlMs: config.idempotencyTtlMs,
    estimatedOutputTokens: config.estimatedOutputTokens,
    outboxMaxAttempts: config.outboxMaxAttempts,
    outboxBaseBackoffMs: config.outboxBaseBackoffMs,
    outboxMaxBackoffMs: config.outboxMaxBackoffMs,
    outboxRetentionMs: config.outboxRetentionMs,
    outboxFlushLimit: config.outboxFlushLimit,
  };

  const metering = new MeteringService({
    store: stateStore,
    api: paperclipApi,
    agentKeyFor,
    options: meteringOptions,
    logger,
    now,
  });

  // A customer conversation has no Paperclip issue. This gives it one, so the
  // PUBLIC path can persist its output through the unchanged write-back and can
  // therefore reach `completed`. See src/conversation.ts.
  const conversationIssues = new ConversationIssues({
    api: paperclipApi,
    store: stateStore,
    logger,
    now,
    enabled: config.conversationIssues,
  });

  async function handleInvoke(
    req: IncomingMessage,
    res: ServerResponse,
    correlationId: string,
  ): Promise<void> {
    const startedAt = now();

    /**
     * The response contract this request selected. Stays `"none"` until the
     * body has been parsed AND the mode recognised, so every rejection that
     * happens before that point keeps the original body shape exactly.
     */
    let responseMode: ResponseMode = "none";
    /** Resolved model name, once a template is known. Never invented. */
    let resolvedModel: string | null = null;
    /** Run id as parsed, so an inline failure body can still name the run. */
    let resolvedRunId: string | null = null;

    /** Usage metadata carrying no measurements — used on the failure paths. */
    const noUsage = (durationMs: number): InlineUsage => ({
      inputTokens: null,
      cachedInputTokens: null,
      outputTokens: null,
      model: resolvedModel,
      provider: config.modelProvider,
      durationMs,
    });

    const finish = (
      status: number,
      outcome: Outcome,
      body: Record<string, unknown>,
      logFields: Record<string, unknown> = {},
      /**
       * Present ⇒ this outcome has an inline shape. When the request asked for
       * `inline` the structured failure body is sent instead of the plain one;
       * the plain body is byte-for-byte unchanged for every other request.
       */
      inlineFailure?: { completionState: Exclude<CompletionState, "completed">; failureCategory: string },
    ): void => {
      const durationMs = now() - startedAt;
      logger.log(outcome === "ok" ? "info" : "warn", {
        event: "invoke",
        correlationId,
        outcome,
        durationMs,
        httpStatus: status,
        ...(responseMode === "inline" ? { responseMode } : {}),
        ...(inlineFailure !== undefined && responseMode === "inline"
          ? { completionState: inlineFailure.completionState }
          : {}),
        ...logFields,
      });
      if (responseMode === "inline" && inlineFailure !== undefined) {
        sendJson(
          res,
          status,
          correlationId,
          inlineFailureBody({
            outcome,
            completionState: inlineFailure.completionState,
            failureCategory: inlineFailure.failureCategory,
            runId: resolvedRunId,
            recorded: false,
            recorderError: null,
            transitioned: false,
            issueStatus: null,
            replay: false,
            usage: noUsage(durationMs),
          }),
        );
        return;
      }
      sendJson(res, status, correlationId, { ok: outcome === "ok", outcome, ...body });
    };

    /**
     * Answer a replayed `inline` request from the stored idempotency record.
     *
     * NO model call happens here, ever. If the record holds a completed run the
     * stored answer is returned verbatim; anything else is reported as the
     * failure it was. The one case that can hold neither is a record written by
     * a build older than this contract: it completed, but the answer was not
     * retained. That is reported as `invalid_output` with an explicit category
     * — regenerating it would be a second run and a different answer.
     */
    const sendInlineReplay = (
      prior: RunResultRecord,
      ctx: {
        idempotencyKey: string;
        runId: string | null;
        agentId: string | null;
        templateId: string;
      },
    ): void => {
      const durationMs = now() - startedAt;
      const usage: InlineUsage = prior.usage
        ? {
            inputTokens: prior.usage.inputTokens,
            cachedInputTokens: prior.usage.cachedInputTokens,
            outputTokens: prior.usage.outputTokens,
            model: prior.usage.model,
            provider: prior.usage.provider,
            durationMs: prior.usage.durationMs,
          }
        : noUsage(durationMs);

      const stored: CompletionState = isCompletionState(prior.completionState)
        ? prior.completionState
        : completionStateForOutcome(prior.outcome);

      // A stored answer is the ONLY thing that can produce a replayed success.
      const answerText = stored === "completed" ? prior.answerText : null;
      // A record written before this contract completed but kept no answer.
      // Reported as `invalid_output` — never regenerated, never guessed.
      const failureState: Exclude<CompletionState, "completed"> =
        stored === "completed" ? "invalid_output" : stored;
      const state: CompletionState = answerText !== null ? "completed" : failureState;
      const status = inlineHttpStatus(state, prior.httpStatus);

      logger.warn({
        event: "invoke",
        correlationId,
        runId: ctx.runId,
        agentId: ctx.agentId,
        templateId: ctx.templateId,
        outcome: "duplicate_run_suppressed",
        durationMs,
        httpStatus: status,
        idempotencyKey: ctx.idempotencyKey,
        replayedOutcome: prior.outcome,
        responseMode: "inline",
        completionState: state,
        detail:
          "this run id has already been executed; the stored result was replayed, the model provider was NOT called again and nothing was written a second time",
      });

      if (answerText !== null) {
        sendJson(
          res,
          status,
          correlationId,
          inlineSuccessBody({
            runId: ctx.runId,
            // The stored string, returned as stored. Never re-rendered.
            answerText,
            // A completed run is one Paperclip accepted, so there is no
            // recorder error to carry.
            recorderError: null,
            transitioned: prior.transitioned,
            issueStatus: prior.transitionStatus,
            replay: true,
            usage,
          }),
        );
        return;
      }

      sendJson(
        res,
        status,
        correlationId,
        inlineFailureBody({
          outcome: prior.outcome,
          completionState: failureState,
          failureCategory:
            stored === "completed"
              ? "the original run's answer text is not retained in the idempotency record; it was not regenerated"
              : (prior.recorderError ?? `replayed_${prior.outcome}`),
          runId: ctx.runId,
          recorded: prior.recorded,
          recorderError: prior.recorderError,
          transitioned: prior.transitioned,
          issueStatus: prior.transitionStatus,
          replay: true,
          usage,
        }),
      );
    };

    // Fail closed: no credential configured at all.
    if (!hasAnyCredential(config)) {
      finish(503, "no_credential_configured", {
        error: "no runtime credential is configured",
      });
      return;
    }

    const auth = resolveCredential(config, req.headers["authorization"]);
    if (auth.kind === "not_configured") {
      finish(503, "no_credential_configured", {
        error: "no runtime credential is configured",
      });
      return;
    }
    if (auth.kind === "unauthorized") {
      finish(401, "unauthorized", { error: "unauthorized" });
      return;
    }
    const credentialExposure = auth.credentialExposure;

    let raw: Buffer;
    try {
      raw = await readBody(req, config.maxRequestBytes);
    } catch (err) {
      if (err instanceof PayloadTooLargeError) {
        finish(413, "payload_too_large", { error: "request body too large" }, {
          credentialExposure,
        });
        return;
      }
      finish(400, "bad_request", { error: "could not read request body" }, {
        credentialExposure,
      });
      return;
    }

    const body = parseInvokeBody(raw);
    if (body === null) {
      finish(400, "bad_request", { error: "body must be a JSON object" }, {
        credentialExposure,
      });
      return;
    }

    // ---- the versioned response contract ----------------------------------
    // Reject an unrecognised mode rather than degrading to "no answer": a
    // gateway that asked for the text and got a bare 200 would have no way to
    // tell a silent downgrade from a run that genuinely produced nothing.
    const modeDecision = parseResponseMode(body.responseMode);
    if (modeDecision.kind === "unrecognised") {
      finish(
        400,
        "unsupported_response_mode",
        {
          error: "unrecognised responseMode",
          supportedResponseModes: [...RESPONSE_MODES],
          contractVersion: RESPONSE_CONTRACT_VERSION,
        },
        { credentialExposure },
      );
      return;
    }
    responseMode = modeDecision.mode;

    const agentId = asString(body.agentId);
    const runId = asString(body.runId);
    resolvedRunId = runId;

    // PROVENANCE. Whose run id is this?
    //
    // Paperclip's `x-paperclip-run-id` header lands in `req.actor.runId` and is
    // written straight into `issue_comments.created_by_run_id` and
    // `cost_events.heartbeat_run_id` — both FOREIGN KEYS into `heartbeat_runs`,
    // a table only Paperclip populates. So the header may only carry an id
    // PAPERCLIP ISSUED.
    //
    // Two callers reach this endpoint with very different ids:
    //   · Paperclip's own http adapter  -> a real heartbeat run
    //   · isola-gateway                 -> its own delivery id, never valid
    //
    // ABSENCE MEANS NOT ISSUED, so the default is the safe one and the gateway
    // needs no change. An agent Paperclip dispatches declares it in
    // adapterConfig.payloadTemplate as { "runIdIssuedBy": "paperclip" }.
    //
    // Measured 2026-08-17, why this is not cosmetic: EVERY customer reply cost a
    // guaranteed Paperclip 500 (53 of them on the comments endpoint) because the
    // header was always wrong on the gateway path. A retry-without-the-header
    // usually rescued it. When that retry ALSO failed — a transport TypeError at
    // 20:18:43 — the model's answer was generated, billed, and WITHHELD from the
    // customer. Not sending a wrong id removes both legs: no 500, so no retry,
    // so no retry to fail.
    const paperclipRunId = body.runIdIssuedBy === "paperclip" ? runId : null;

    // Unknown template: 400, and record nothing.
    const template = findTemplate(body.templateId);
    if (template === null) {
      finish(
        400,
        "unknown_template",
        { error: "unknown templateId" },
        {
          agentId,
          runId,
          templateId: asString(body.templateId),
          credentialExposure,
        },
        { completionState: "rejected", failureCategory: "unknown_template" },
      );
      return;
    }

    const decision = decideExposure({
      template,
      credentialExposure,
      requestedExposureRaw: body.exposure,
      configuredExposures: config.secrets,
    });

    if (decision.kind === "no_credential_configured") {
      // Never fall back to the other exposure's credential.
      finish(
        503,
        "no_credential_configured",
        {
          error: `no credential configured for exposure ${template.exposure}`,
        },
        {
          agentId,
          runId,
          templateId: template.id,
          templateExposure: template.exposure,
          credentialExposure,
        },
        {
          completionState: "rejected",
          failureCategory: `no_credential_configured_for_${template.exposure}`,
        },
      );
      return;
    }

    if (decision.kind === "mismatch") {
      finish(
        403,
        "exposure_mismatch",
        { error: decision.reason },
        {
          agentId,
          runId,
          templateId: template.id,
          templateExposure: template.exposure,
          credentialExposure,
          reason: decision.reason,
        },
        { completionState: "rejected", failureCategory: "exposure_mismatch" },
      );
      return;
    }

    // ---- authorised: do the work synchronously ----------------------------
    const exposure = decision.exposure;
    const rendered = renderContext(body.context, template.maxContextBytes);
    const model = config.modelNameOverride ?? template.model;
    resolvedModel = model;
    // The tighter of the template deadline and the operator deadline wins.
    const timeoutMs = Math.min(template.timeoutMs, config.modelTimeoutMs);
    const userMessage = buildUserMessage(rendered);

    const issueId = extractIssueId(body.context);
    // Resolved (not acted on) here so it can be logged even when it is unused.
    // The issue is only created after the model has answered — see below.
    const conversationRef =
      issueId === null ? extractConversationRef(body.context) : null;
    const companyId = extractCompanyId(body.context) ?? config.paperclipCompanyId;
    const agentKey = agentKeyFor(exposure);
    // Every callback authenticates as the employee's own agent and carries the
    // run id header Paperclip reads.
    const call: PaperclipCall | null =
      agentKey === null ? null : { apiKey: agentKey, runId: paperclipRunId };

    const idemKey = buildIdempotencyKey({
      companyId,
      agentId,
      runId,
      issueId,
      contextText: rendered.text,
    });

    // ---- idempotency gate: a replay never reaches the provider -------------
    const claim = await metering.claimOrReplay({
      key: idemKey,
      companyId,
      agentId,
      runId,
      issueId,
    });

    if (claim.kind === "replay" && claim.record.result !== null) {
      const prior = claim.record.result;

      // The replay of an inline run returns the STORED answer. The provider is
      // not called a second time under any circumstance — that is the whole
      // point of the record, and re-running the model would be a second charge
      // and, worse, a different answer to a customer who already has one.
      if (responseMode === "inline") {
        sendInlineReplay(prior, {
          idempotencyKey: idemKey,
          runId,
          agentId,
          templateId: template.id,
        });
        return;
      }

      logger.warn({
        event: "invoke",
        correlationId,
        runId,
        agentId,
        templateId: template.id,
        outcome: "duplicate_run_suppressed",
        durationMs: now() - startedAt,
        httpStatus: prior.httpStatus,
        idempotencyKey: idemKey,
        replayedOutcome: prior.outcome,
        detail:
          "this run id has already been executed; the original result was replayed and nothing was written a second time",
      });
      sendJson(res, prior.httpStatus, correlationId, {
        ok: prior.outcome === "ok",
        outcome: prior.outcome,
        replay: true,
        recorded: prior.recorded,
        recorderError: prior.recorderError,
        transitioned: prior.transitioned,
        issueStatus: prior.transitionStatus,
        durationMs: now() - startedAt,
      });
      return;
    }

    if (claim.kind === "in_flight" || claim.kind === "replay") {
      // A duplicate arriving while the original is still running. Reporting 2xx
      // stops Paperclip re-scheduling; the original run owns the write-backs.
      const durationMs = now() - startedAt;
      logger.warn({
        event: "invoke",
        correlationId,
        runId,
        agentId,
        templateId: template.id,
        outcome: "duplicate_run_suppressed",
        durationMs,
        httpStatus: 200,
        idempotencyKey: idemKey,
        detail: "a run with this id is already in flight; this duplicate did nothing",
      });
      if (responseMode === "inline") {
        // 200 keeps Paperclip from re-scheduling, but there is no answer to
        // give: the original run has not finished. Say so, do not invent one.
        sendJson(
          res,
          200,
          correlationId,
          inlineFailureBody({
            outcome: "duplicate_run_suppressed",
            completionState: "duplicate_in_flight",
            failureCategory:
              "a run with this id is already in flight; this duplicate produced no answer",
            runId,
            recorded: false,
            recorderError: null,
            transitioned: false,
            issueStatus: null,
            replay: true,
            usage: noUsage(durationMs),
          }),
        );
        return;
      }
      sendJson(res, 200, correlationId, {
        ok: true,
        outcome: "duplicate_run_suppressed",
        replay: true,
        durationMs,
      });
      return;
    }

    let reservationId: string | null = null;
    let finalized = false;

    try {
      // ---- deliver anything the outbox still owes -------------------------
      await metering.flush("invoke");

      // ---- fail closed on undelivered spend -------------------------------
      const gate = await metering.undeliveredGate();
      if (gate.blocked) {
        logger.error({
          event: "invoke",
          correlationId,
          runId,
          agentId,
          templateId: template.id,
          outcome: "cost_delivery_unconfirmed",
          durationMs: now() - startedAt,
          httpStatus: 503,
          pendingCostCents: gate.pendingCents,
          pendingEntries: gate.pendingEntries,
          failedEntries: gate.failedEntries,
          oldestPendingAgeMs: gate.oldestAgeMs,
          failureCategory: gate.reason,
          ...(responseMode === "inline"
            ? { responseMode, completionState: "rejected" }
            : {}),
        });
        if (responseMode === "inline") {
          sendJson(
            res,
            503,
            correlationId,
            inlineFailureBody({
              outcome: "cost_delivery_unconfirmed",
              completionState: "rejected",
              failureCategory: gate.reason ?? "cost_delivery_unconfirmed",
              runId,
              recorded: false,
              recorderError: null,
              transitioned: false,
              issueStatus: null,
              replay: false,
              usage: noUsage(now() - startedAt),
              extra: { pendingCostCents: gate.pendingCents },
            }),
          );
          return;
        }
        sendJson(res, 503, correlationId, {
          ok: false,
          outcome: "cost_delivery_unconfirmed",
          error: gate.reason,
          pendingCostCents: gate.pendingCents,
          durationMs: now() - startedAt,
        });
        return;
      }

      // ---- behaviour comes from Paperclip ----------------------------------
      // Resolved BEFORE the budget preflight so the reservation is costed against
      // the prompt actually sent. Never throws: an unreachable Paperclip yields the
      // fail-closed prompt, which escalates instead of answering.
      // PHASE TIMING. `durationMs` alone cannot say WHERE a slow reply went, and
      // that gap cost a whole trace: three hypotheses (MCP respawn, first-run
      // init, a slow Paperclip host) were each probed and eliminated, because the
      // only number available was the total. These three marks are emitted on the
      // invoke line so the next question is answered by reading a log rather than
      // by instrumenting under pressure.
      const tCharterStart = now();
      const resolvedPrompt = await instructions.resolve(template.id, template.systemPrompt, agentId);
      const charterMs = now() - tCharterStart;
      if (resolvedPrompt.source === "fail_closed") {
        logger.error({
          event: "instructions",
          outcome: "instructions_unavailable",
          correlationId,
          runId,
          templateId: template.id,
          detail: resolvedPrompt.failure,
        });
      } else if (resolvedPrompt.failure !== null) {
        logger.warn({
          event: "instructions",
          outcome: "instructions_stale",
          correlationId,
          runId,
          templateId: template.id,
          cacheAgeMs: resolvedPrompt.cacheAgeMs,
          detail: resolvedPrompt.failure,
        });
      }
      if (resolvedPrompt.businessFactsRejectedAgentId !== null) {
        // A claimed agent id that failed business-facts authorization is either a
        // forged/stale claim or a gateway binding bug -- either way it is the exact
        // signal that would reveal a compromised or misconfigured caller, and it must
        // never be silent just because the reply itself degraded safely to
        // persona-only.
        logger.warn({
          event: "instructions",
          outcome: "business_facts_identity_rejected",
          correlationId,
          runId,
          templateId: template.id,
          rejectedAgentId: resolvedPrompt.businessFactsRejectedAgentId,
        });
      }

      // ---- budget preflight and reservation --------------------------------
      const pre = await metering.preflight({
        companyId,
        agentId,
        exposure,
        runId,
        paperclipRunId,
        model,
        promptChars: resolvedPrompt.prompt.length + userMessage.length,
      });

      if (pre.kind === "exhausted") {
        // The provider is NOT called. Nothing is spent on this run.
        let paused = false;
        if (pre.pause && agentId !== null) {
          paused = await metering.pauseAgent(agentId, exposure, paperclipRunId);
        }
        await postNoticeComment({
          api: paperclipApi,
          issueId,
          body: renderBudgetExhaustedComment({
            usedPct: pre.usedPct,
            budgetCents: pre.budgetCents,
            agentId,
            owner: config.handoff.owner,
            correlationId,
            paused,
          }),
          call,
          logger,
          correlationId,
          outcome: "budget_exhausted",
        });
        logger.error({
          event: "invoke",
          correlationId,
          runId,
          agentId,
          templateId: template.id,
          outcome: "budget_exhausted",
          durationMs: now() - startedAt,
          httpStatus: 402,
          usedPct: pre.usedPct,
          budgetCents: pre.budgetCents,
          agentPaused: paused,
          providerCalled: false,
          ...(responseMode === "inline"
            ? { responseMode, completionState: "budget_exhausted" }
            : {}),
        });
        if (responseMode === "inline") {
          sendJson(
            res,
            402,
            correlationId,
            inlineFailureBody({
              outcome: "budget_exhausted",
              completionState: "budget_exhausted",
              failureCategory:
                "monthly budget is fully committed; the model provider was not called",
              runId,
              recorded: false,
              recorderError: null,
              transitioned: false,
              issueStatus: null,
              replay: false,
              usage: noUsage(now() - startedAt),
              extra: { usedPct: pre.usedPct, agentPaused: paused },
            }),
          );
          return;
        }
        sendJson(res, 402, correlationId, {
          ok: false,
          outcome: "budget_exhausted",
          error: "monthly budget is fully committed; the model provider was not called",
          usedPct: pre.usedPct,
          agentPaused: paused,
          durationMs: now() - startedAt,
        });
        return;
      }

      reservationId = pre.reservationId;

      if (pre.alert && pre.verdict.kind !== "unlimited") {
        logger.warn({
          event: "budget",
          correlationId,
          runId,
          agentId,
          outcome: "budget_alert",
          usedPct: pre.verdict.usedPct,
          alertPct: config.budgetAlertPct,
          budgetCents: pre.verdict.budgetCents,
          detail: "budget alert threshold crossed; this fires once per crossing",
        });
        await postNoticeComment({
          api: paperclipApi,
          issueId,
          body: renderBudgetAlertComment({
            usedPct: pre.verdict.usedPct,
            budgetCents: pre.verdict.budgetCents,
            alertPct: config.budgetAlertPct,
            agentId,
            correlationId,
          }),
          call,
          logger,
          correlationId,
          outcome: "budget_alert",
        });
      }

      // ---- the model call --------------------------------------------------
      let status: RunStatus;
      let content: string | null = null;
      let failureCategory: string | null = null;
      let httpStatus: number;
      let outcome: Outcome;
      let usage: TokenUsage | null = null;
      /**
       * True when the provider answered with nothing usable, as opposed to
       * erroring. Both are `502 provider_error` on the wire — unchanged — but
       * the inline contract reports them apart.
       */
      let invalidOutput = false;
      // Wall time of the brain round-trip, including any agent loop and tool
      // calls the runtime cannot see from here. Measured around the call rather
      // than inferred from a downstream accounting table: `first_seen` there may
      // be usage-WRITE time, not call-start, and a duration derived from two
      // timestamps whose meanings were never checked is not a measurement.
      let brainMs = 0;
      const tBrainStart = now();

      try {
        const result = await clientForTemplate(template).complete({
          model,
          timeoutMs,
          messages: [
            { role: "system", content: resolvedPrompt.prompt },
            { role: "user", content: userMessage },
          ],
        });
        brainMs = now() - tBrainStart;
        status = "succeeded";
        content = result.content;
        httpStatus = 200;
        outcome = "ok";
        if (result.usage !== null) {
          // `promptTokens` includes the cached subset; billing splits them.
          const cached = result.usage.cachedPromptTokens ?? 0;
          const prompt = result.usage.promptTokens ?? 0;
          usage = {
            inputTokens: Math.max(0, prompt - cached),
            cachedInputTokens: cached,
            outputTokens: result.usage.completionTokens ?? 0,
          };
        }
      } catch (err) {
        // Recorded on the FAILURE path too. A timeout's brainMs is the most
        // useful number there is when asking whether the ceiling is wrong or the
        // upstream is; omitting it would leave exactly the case we most need.
        brainMs = now() - tBrainStart;
        // NEVER fabricate an answer here. The write-back says the run failed.
        if (err instanceof ModelTimeoutError) {
          status = "timed_out";
          failureCategory = `model_timeout_after_${timeoutMs}ms`;
          httpStatus = 504;
          outcome = "model_timeout";
        } else if (err instanceof ModelProviderError) {
          status = "provider_error";
          failureCategory = err.message;
          httpStatus = 502;
          outcome = "provider_error";
          // Subclass of the above: same status, same outcome, same category.
          invalidOutput = err instanceof ModelInvalidOutputError;
        } else {
          status = "internal_error";
          failureCategory = `internal_error (${err instanceof Error ? err.name : "unknown"})`;
          httpStatus = 500;
          outcome = "internal_error";
        }
      }

      // ---- settle the reservation and meter the real cost ------------------
      const settlement = await metering.settle({
        reservationId,
        companyId,
        agentId,
        exposure,
        runId,
        issueId,
        model,
        usage,
        card: pre.card,
      });
      reservationId = null;

      // ---- where this run's output is persisted ----------------------------
      // An issue-driven run already knows. A conversation-driven run does not:
      // create-or-get the issue that represents the conversation, so the
      // unchanged write-back below has somewhere to write. Deliberately AFTER
      // the model call, so a run that never produced anything never opens an
      // issue, and so a Paperclip refusal lands as `persistence_failed` — the
      // truthful state — rather than as a pre-flight rejection.
      let recordIssueId = issueId;
      let conversationScoped = false;
      let conversationFailure: string | null = null;
      if (conversationRef !== null) {
        const resolution = await conversationIssues.resolve({
          ref: conversationRef,
          companyId,
          call,
          tenantId: extractTenantId(body.context),
          correlationId,
          runId: paperclipRunId,
          agentId,
        });
        if (resolution.kind === "resolved") {
          recordIssueId = resolution.issueId;
          conversationScoped = true;
        } else if (resolution.kind === "failed") {
          conversationFailure = resolution.detail;
        }
        // `not_attempted` is not a failure: the feature is off, Paperclip is not
        // configured, or no company owns the issue. Everything below then behaves
        // exactly as it did before conversation issues existed.
      }

      const durationMs = now() - startedAt;
      const runOutcome: RunOutcome = {
        correlationId,
        agentId,
        // The recorder POSTs the answer as a Paperclip comment, so this must be
        // the PAPERCLIP-scoped id. Logs and the cost outbox key keep the real
        // `runId` — those are ours and a fabricated value there would only make
        // our own traces lie.
        runId: paperclipRunId,
        issueId: recordIssueId,
        templateId: template.id,
        templateVersion: template.version,
        exposure,
        status,
        durationMs,
        content,
        failureCategory,
        contextTruncated: rendered.truncated,
        handoff:
          status === "succeeded"
            ? null
            : { owner: config.handoff.owner, nextAction: nextActionFor(status) },
      };

      // ---- callback 1: the comment -----------------------------------------
      // A recorder failure must never flip a successful model run into a failed
      // HTTP status. It is logged and surfaced as `recorded:false`.
      let recorded = false;
      let recorderError: string | null = null;
      /** Wall time of the Paperclip write-back. 0 when no record was attempted. */
      let recordMs = 0;
      if (conversationFailure !== null) {
        // There is no issue to write to. The recorder is not called: it would
        // fail on the missing {issueId} anyway, and reporting the real reason is
        // more useful than reporting the symptom.
        recorded = false;
        recorderError = conversationFailure;
        logger.error({
          event: "recorder_failed",
          correlationId,
          runId,
          agentId,
          templateId: template.id,
          outcome: "recorder_failed",
          durationMs: now() - startedAt,
          detail: recorderError,
        });
      } else {
        try {
          const tRecordStart = now();
          await recorder.record(runOutcome);
          recordMs = now() - tRecordStart;
          recorded = recorder.kind !== "null";
          if (recorder.kind === "null") recorderError = "no recorder configured";
        } catch (err) {
          recorded = false;
          recorderError = err instanceof Error ? err.message : "unknown recorder failure";
          logger.error({
            event: "recorder_failed",
            correlationId,
            runId,
            agentId,
            templateId: template.id,
            outcome: "recorder_failed",
            durationMs: now() - startedAt,
            detail: recorderError,
          });
        }
      }

      // ---- callback 2: the issue transition (this is the loop fix) ---------
      // Only for a genuinely issue-driven run. A conversation issue must never
      // be transitioned: those statuses close a work item and hand it to a
      // human, and doing that per customer message would bury the operator.
      if (conversationScoped) {
        logger.info({
          event: "transition",
          outcome: "conversation_issue_not_transitioned",
          correlationId,
          runId: paperclipRunId,
          agentId,
          issueId: recordIssueId,
          detail:
            "this run is conversation-scoped; the conversation's issue is a record, not a work item, so no status transition was attempted",
        });
      }
      const transition = conversationScoped
        ? transitionNotAttempted()
        : await transitionIssue({
            api: paperclipApi,
            issueId,
            status: statusForRun(status, config.handoff),
            call,
            logger,
            correlationId,
            runId: paperclipRunId,
            agentId,
            reviewAssigneeUserId: config.handoff.reviewAssigneeUserId,
          });

      // ---- the one and only answer -----------------------------------------
      // `runOutcome.content` is the exact string the recorder was handed and
      // embedded verbatim in the Paperclip comment. The response reuses THIS
      // reference. Nothing re-renders it, re-derives it, trims it or asks the
      // provider again — byte equality with what was persisted is guaranteed by
      // construction, and `test/inline.test.ts` pins it.
      const persistedAnswer = runOutcome.content;

      /**
       * The truthful end state.
       *
       * `completed` requires BOTH that the model answered and that Paperclip
       * accepted the write-back. A recorder failure is `persistence_failed`:
       * the answer exists but was not persisted, so it is not handed out — the
       * caller would otherwise reply to a customer with text that no record
       * anywhere contains.
       */
      const completionState: CompletionState =
        outcome === "ok"
          ? !recorded
            ? "persistence_failed"
            : persistedAnswer === null || persistedAnswer.trim().length === 0
              ? "invalid_output"
              : "completed"
          : outcome === "model_timeout"
            ? "timeout"
            : outcome === "provider_error"
              ? invalidOutput
                ? "invalid_output"
                : "provider_error"
              : "internal_error";

      const usageRecord: RunUsageRecord = {
        inputTokens: usage?.inputTokens ?? null,
        cachedInputTokens: usage?.cachedInputTokens ?? null,
        outputTokens: usage?.outputTokens ?? null,
        model,
        provider: config.modelProvider,
        durationMs,
      };

      // ---- record the result so a replay is a no-op ------------------------
      // The stored `httpStatus`/`outcome` are the mode-independent ones, so a
      // later replay in EITHER mode reproduces exactly what that mode would
      // have returned. The answer is retained only for a run that completed.
      await metering.finalize(idemKey, {
        httpStatus,
        outcome,
        recorded,
        recorderError,
        transitioned: transition.transitioned,
        transitionStatus: transition.status,
        costEventKey: settlement.costEventKey,
        costKind: settlement.costKind,
        accruedMicrocents:
          settlement.kind === "skipped" ? 0 : settlement.accruedMicrocents,
        answerText: completionState === "completed" ? persistedAnswer : null,
        completionState,
        usage: usageRecord,
      });
      finalized = true;

      // The inline contract only ever changes the RESPONSE. A non-inline
      // request's status, body and log line are byte-for-byte what they were.
      const inline = responseMode === "inline";
      const responseStatus = inline
        ? inlineHttpStatus(completionState, httpStatus)
        : httpStatus;
      const responseOutcome: Outcome =
        inline && outcome === "ok" && completionState !== "completed"
          ? completionState === "persistence_failed"
            ? "persistence_failed"
            : "provider_error"
          : outcome;

      // NOTE: `answerText` is deliberately absent from every log field below,
      // and `redact()` strips it by key name if anyone ever adds it.
      logger.log(responseOutcome === "ok" ? "info" : "error", {
        event: "invoke",
        correlationId,
        runId,
        agentId,
        templateId: template.id,
        outcome: responseOutcome,
        durationMs: now() - startedAt,
        httpStatus: responseStatus,
        exposure,
        ...(inline ? { responseMode, completionState } : {}),
        model,
        // WHICH BRAIN AND WHICH CHARTER SERVED THIS ANSWER.
        // Added 2026-08-17 after the 9043 internal line answered in the CUSTOMER
        // front desk's voice, on DeepSeek, while carrying the manager's agent id.
        // Nothing in the log said which runtime or which persona had served it, so
        // a fluent answer from the wrong brain was indistinguishable from a right
        // one. These two fields are what make that visible without reading the text.
        brain: template.modelBaseUrl ?? "default",
        charterSource: resolvedPrompt.source,
        // WHICH TENANT'S BUSINESS FACTS, IF ANY. The invoke's claimed agentId, but
        // only once CHECKED against PAPERCLIP_BUSINESS_FACTS_MAP for this exact
        // templateId -- never trusted merely because it was present. Null covers both
        // "no claim" and "claim rejected"; see businessFactsRejectedAgentId below for
        // the security-relevant subset of that null.
        businessFactsAgentId: resolvedPrompt.businessFactsAgentId,
        businessFactsRejectedAgentId: resolvedPrompt.businessFactsRejectedAgentId,
        // WHERE THE TIME WENT. `durationMs` is the total; these three name the
        // legs, so "why was that slow" is a log read and not an investigation.
        // They do not have to sum to durationMs — the remainder is this service's
        // own work (context render, budget preflight, ledger) and a growing
        // remainder is itself the finding.
        charterMs,
        brainMs,
        recordMs,
        contextTruncated: rendered.truncated,
        contextOriginalBytes: rendered.originalBytes,
        contextEmittedBytes: rendered.emittedBytes,
        recorded,
        recorderKind: recorder.kind,
        // For an issue-driven run this is the extracted id, exactly as before.
        // For a conversation-driven run it is the conversation's own issue.
        issueId: recordIssueId,
        ...(conversationScoped
          ? { conversationScoped: true, conversationKey: conversationRef?.key ?? null }
          : {}),
        issueTransitioned: transition.transitioned,
        issueStatus: transition.status,
        costOutcome: settlement.kind,
        costKind: settlement.costKind,
        costEventKey: settlement.costEventKey,
        inputTokens: usage?.inputTokens ?? null,
        cachedInputTokens: usage?.cachedInputTokens ?? null,
        outputTokens: usage?.outputTokens ?? null,
        failureCategory,
      });

      if (inline) {
        if (completionState === "completed") {
          sendJson(
            res,
            responseStatus,
            correlationId,
            inlineSuccessBody({
              runId,
              // Same reference the recorder received. Not a copy of a copy.
              answerText: persistedAnswer as string,
              recorderError: null,
              transitioned: transition.transitioned,
              issueStatus: transition.status,
              replay: false,
              usage: usageRecord,
            }),
          );
        } else {
          sendJson(
            res,
            responseStatus,
            correlationId,
            inlineFailureBody({
              outcome: responseOutcome,
              completionState,
              failureCategory:
                failureCategory ??
                recorderError ??
                (completionState === "persistence_failed"
                  ? "the answer was produced but Paperclip did not accept the write-back"
                  : "the provider returned no usable assistant text"),
              runId,
              recorded,
              recorderError,
              transitioned: transition.transitioned,
              issueStatus: transition.status,
              replay: false,
              usage: usageRecord,
            }),
          );
        }
        return;
      }

      sendJson(res, httpStatus, correlationId, {
        ok: outcome === "ok",
        outcome,
        recorded,
        recorderError,
        transitioned: transition.transitioned,
        issueStatus: transition.status,
        durationMs,
        ...(failureCategory !== null ? { error: failureCategory } : {}),
      });
    } finally {
      // A reservation must never outlive its run, and an unfinished claim must
      // never permanently suppress a legitimate retry.
      await metering.releaseReservation(reservationId);
      if (!finalized) await metering.release(idemKey);
    }
  }

  function handleHealth(res: ServerResponse, correlationId: string): void {
    sendJson(res, 200, correlationId, {
      status: "ok",
      version: SERVICE_VERSION,
      // Contract discovery: a caller can tell whether this build implements
      // inline responses without having to try one and interpret a 400.
      responseModes: [...RESPONSE_MODES],
      responseContractVersion: RESPONSE_CONTRACT_VERSION,
      templates: healthTemplateSummary(),
      egressAllowlist: config.egressAllowlist,
    });
  }

  function handleTemplates(
    req: IncomingMessage,
    res: ServerResponse,
    correlationId: string,
  ): void {
    if (!hasAnyCredential(config)) {
      sendJson(res, 503, correlationId, {
        ok: false,
        outcome: "no_credential_configured",
        error: "no runtime credential is configured",
      });
      return;
    }
    const auth = resolveCredential(config, req.headers["authorization"]);
    if (auth.kind !== "ok") {
      const status = auth.kind === "not_configured" ? 503 : 401;
      sendJson(res, status, correlationId, {
        ok: false,
        outcome: auth.kind === "not_configured" ? "no_credential_configured" : "unauthorized",
        error: auth.kind === "not_configured" ? "no runtime credential is configured" : "unauthorized",
      });
      return;
    }
    sendJson(res, 200, correlationId, {
      ok: true,
      // Metadata only. The system prompt is never exposed over the API.
      templates: allTemplates().map(templateMetadata),
    });
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
      logger.warn({ event: "request", correlationId, outcome, httpStatus: status, pathname, method });
      sendJson(res, status, correlationId, { ok: false, outcome, error });
    };

    if (method === "GET" && pathname === "/healthz") {
      handleHealth(res, correlationId);
      return;
    }
    if (method === "GET" && pathname === "/v1/templates") {
      handleTemplates(req, res, correlationId);
      return;
    }
    if (pathname === "/v1/invoke") {
      if (method !== "POST") {
        fail(405, "not_found", "method not allowed");
        return;
      }
      handleInvoke(req, res, correlationId).catch((err: unknown) => {
        logger.error({
          event: "invoke",
          correlationId,
          outcome: "internal_error",
          httpStatus: 500,
          detail: err instanceof Error ? err.name : "unknown",
        });
        if (!res.headersSent) {
          sendJson(res, 500, correlationId, {
            ok: false,
            outcome: "internal_error",
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

  return { handler, metering, stateStore };
}
