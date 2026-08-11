/**
 * The HTTP surface. Plain node:http — no framework, no runtime dependencies.
 *
 * Security posture, restated because it is the reason this service exists:
 *  - no shell, no child processes  (nothing imports node:child_process)
 *  - no filesystem writes, no reads outside the app dir (nothing imports node:fs)
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
import { buildUserMessage, renderContext } from "./context.js";
import { createSafeFetch, type SafeFetch } from "./egress.js";
import { ModelProviderError, ModelTimeoutError } from "./errors.js";
import { createLogger, type Logger } from "./log.js";
import { createOpenAiCompatibleClient, type ModelClient } from "./model.js";
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
  | "not_found";

export interface AppDeps {
  config: RuntimeConfig;
  logger?: Logger;
  /** Injected in tests; defaults to the real allowlisted OpenAI-compatible client. */
  modelClient?: ModelClient;
  /** Injected in tests; defaults to Paperclip-or-Null based on config. */
  recorder?: RunRecorder;
  safeFetch?: SafeFetch;
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

function asString(value: unknown): string | null {
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

/** Best-effort issue id, used only for the write-back path template. */
export function extractIssueId(context: unknown): string | null {
  if (typeof context !== "object" || context === null) return null;
  const ctx = context as Record<string, unknown>;
  const direct = asString(ctx["issueId"]) ?? asString(ctx["issue_id"]);
  if (direct !== null) return direct;
  const issue = ctx["issue"];
  if (typeof issue === "object" && issue !== null) {
    return asString((issue as Record<string, unknown>)["id"]);
  }
  return null;
}

export interface InvokeRequestShape {
  templateId: unknown;
  exposure: unknown;
  agentId: unknown;
  runId: unknown;
  context: unknown;
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
    context: body["context"],
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

export function createApp(deps: AppDeps): Handler {
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

  const recorder =
    deps.recorder ??
    createRecorder({
      baseUrl: config.paperclipBaseUrl,
      apiKey: config.paperclipApiKey,
      pathTemplate: config.paperclipRecordPath,
      safeFetch,
    });

  async function handleInvoke(
    req: IncomingMessage,
    res: ServerResponse,
    correlationId: string,
  ): Promise<void> {
    const startedAt = now();
    const finish = (
      status: number,
      outcome: Outcome,
      body: Record<string, unknown>,
      logFields: Record<string, unknown> = {},
    ): void => {
      const durationMs = now() - startedAt;
      logger.log(outcome === "ok" ? "info" : "warn", {
        event: "invoke",
        correlationId,
        outcome,
        durationMs,
        httpStatus: status,
        ...logFields,
      });
      sendJson(res, status, correlationId, { ok: outcome === "ok", outcome, ...body });
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

    const agentId = asString(body.agentId);
    const runId = asString(body.runId);

    // Unknown template: 400, and record nothing.
    const template = findTemplate(body.templateId);
    if (template === null) {
      finish(400, "unknown_template", { error: "unknown templateId" }, {
        agentId,
        runId,
        templateId: asString(body.templateId),
        credentialExposure,
      });
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
      );
      return;
    }

    if (decision.kind === "mismatch") {
      finish(403, "exposure_mismatch", { error: decision.reason }, {
        agentId,
        runId,
        templateId: template.id,
        templateExposure: template.exposure,
        credentialExposure,
        reason: decision.reason,
      });
      return;
    }

    // ---- authorised: do the work synchronously ----------------------------
    const rendered = renderContext(body.context, template.maxContextBytes);
    const model = config.modelNameOverride ?? template.model;
    // The tighter of the template deadline and the operator deadline wins.
    const timeoutMs = Math.min(template.timeoutMs, config.modelTimeoutMs);

    let status: RunStatus;
    let content: string | null = null;
    let failureCategory: string | null = null;
    let httpStatus: number;
    let outcome: Outcome;

    try {
      const result = await modelClient.complete({
        model,
        timeoutMs,
        messages: [
          { role: "system", content: template.systemPrompt },
          { role: "user", content: buildUserMessage(rendered) },
        ],
      });
      status = "succeeded";
      content = result.content;
      httpStatus = 200;
      outcome = "ok";
    } catch (err) {
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
      } else {
        status = "internal_error";
        failureCategory = `internal_error (${err instanceof Error ? err.name : "unknown"})`;
        httpStatus = 500;
        outcome = "internal_error";
      }
    }

    const durationMs = now() - startedAt;
    const runOutcome: RunOutcome = {
      correlationId,
      agentId,
      runId,
      issueId: extractIssueId(body.context),
      templateId: template.id,
      templateVersion: template.version,
      exposure: decision.exposure,
      status,
      durationMs,
      content,
      failureCategory,
      contextTruncated: rendered.truncated,
    };

    // A recorder failure must never flip a successful model run into a failed
    // HTTP status. It is logged and surfaced as `recorded:false`.
    let recorded = false;
    let recorderError: string | null = null;
    try {
      await recorder.record(runOutcome);
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

    logger.log(outcome === "ok" ? "info" : "error", {
      event: "invoke",
      correlationId,
      runId,
      agentId,
      templateId: template.id,
      outcome,
      durationMs: now() - startedAt,
      httpStatus,
      exposure: decision.exposure,
      model,
      contextTruncated: rendered.truncated,
      contextOriginalBytes: rendered.originalBytes,
      contextEmittedBytes: rendered.emittedBytes,
      recorded,
      recorderKind: recorder.kind,
      failureCategory,
    });

    sendJson(res, httpStatus, correlationId, {
      ok: outcome === "ok",
      outcome,
      recorded,
      recorderError,
      durationMs,
      ...(failureCategory !== null ? { error: failureCategory } : {}),
    });
  }

  function handleHealth(res: ServerResponse, correlationId: string): void {
    sendJson(res, 200, correlationId, {
      status: "ok",
      version: SERVICE_VERSION,
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

  return function handler(req: IncomingMessage, res: ServerResponse): void {
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
}
