/**
 * Writing the run outcome back into Paperclip.
 *
 * Paperclip's `http` adapter discards this service's response body entirely, so
 * the response body cannot carry the answer. The only way the work reaches the
 * employee's run is this write-back.
 *
 * The exact Paperclip endpoint is not yet pinned, so the transport is behind an
 * interface and the path is a configurable template.
 */
import type { SafeFetch } from "./egress.js";
import { EgressBlockedError, RecorderError } from "./errors.js";
import type { Exposure } from "./registry.js";

export type RunStatus =
  | "succeeded"
  | "timed_out"
  | "provider_error"
  | "internal_error";

export interface RunOutcome {
  correlationId: string;
  agentId: string | null;
  runId: string | null;
  issueId: string | null;
  templateId: string;
  templateVersion: string;
  exposure: Exposure;
  status: RunStatus;
  durationMs: number;
  /** Model output. Present only when status === "succeeded". */
  content: string | null;
  /**
   * Failure category. Present only when status !== "succeeded".
   * A category string built by this service — never a secret, never a raw
   * provider payload.
   */
  failureCategory: string | null;
  contextTruncated: boolean;
  /**
   * Who picks this up when the run failed, and what they should do.
   *
   * A blocked issue with no named owner and no next action is how work goes
   * quiet, so the failure comment always carries both. Optional only so the
   * existing callers and tests that predate the handoff contract still compile.
   */
  handoff?: { owner: string; nextAction: string } | null;
}

export interface RunRecorder {
  readonly kind: string;
  record(outcome: RunOutcome): Promise<void>;
}

const FAILURE_HEADLINE: Record<Exclude<RunStatus, "succeeded">, string> = {
  timed_out: "This run FAILED: the model provider did not answer inside the deadline.",
  provider_error: "This run FAILED: the model provider returned an error.",
  internal_error: "This run FAILED: the Isola runtime hit an internal error.",
};

/**
 * The human-readable body written back to Paperclip.
 *
 * On failure this states plainly that the run failed and gives the category.
 * It never fabricates an answer, never speculates about what the answer would
 * have been, and never embeds a secret or a provider payload.
 */
export function renderOutcomeBody(outcome: RunOutcome): string {
  const header = [
    `**Isola runtime** · template \`${outcome.templateId}\` · exposure \`${outcome.exposure}\``,
    `correlationId \`${outcome.correlationId}\` · runId \`${outcome.runId ?? "unknown"}\` · ${outcome.durationMs}ms`,
  ].join("  \n");

  if (outcome.status === "succeeded") {
    const notes: string[] = [];
    if (outcome.contextTruncated) {
      notes.push(
        "> Note: the run context exceeded the size cap and was truncated before the model saw it.",
      );
    }
    return [header, "", ...notes, notes.length > 0 ? "" : null, outcome.content ?? ""]
      .filter((line): line is string => line !== null)
      .join("\n")
      .trimEnd();
  }

  const handoff = outcome.handoff
    ? [
        "",
        `**Owner:** ${outcome.handoff.owner}`,
        `**Next action:** ${outcome.handoff.nextAction}`,
      ]
    : [];

  return [
    header,
    "",
    FAILURE_HEADLINE[outcome.status],
    "",
    `Failure category: \`${outcome.failureCategory ?? "unknown"}\``,
    ...handoff,
    "",
    "No answer was produced. Nothing in this run was inferred, guessed or filled in.",
    "No external system was contacted and no record was changed by this runtime.",
  ].join("\n");
}

/** Used when PAPERCLIP_API_KEY is unset: the outcome is simply not written back. */
export class NullRunRecorder implements RunRecorder {
  readonly kind = "null";
  async record(_outcome: RunOutcome): Promise<void> {
    // Intentionally does nothing. The caller logs `recorded:false`.
  }
}

export interface PaperclipRunRecorderOptions {
  baseUrl: string;
  apiKey: string;
  /**
   * The employee's own agent API key, per exposure class. Paperclip
   * authenticates callbacks as the agent, and a cost event is rejected unless
   * the calling agent matches — so the agent key, not a shared board key, is
   * the right credential for the comment too. Falls back to `apiKey`.
   */
  apiKeyByExposure?: Readonly<Partial<Record<Exposure, string | null>>>;
  /** e.g. "/api/issues/{issueId}/comments" */
  pathTemplate: string;
  safeFetch: SafeFetch;
  timeoutMs?: number;
}

const PLACEHOLDER = /\{(issueId|agentId|runId)\}/g;

/**
 * Substitute {issueId} / {agentId} / {runId} into the path template.
 * Throws if the template needs a value the run does not have — better a loud
 * recorder failure than a POST to a wrong, half-substituted path.
 */
export function renderRecordPath(
  pathTemplate: string,
  values: { issueId: string | null; agentId: string | null; runId: string | null },
): string {
  const missing: string[] = [];
  const path = pathTemplate.replace(PLACEHOLDER, (_match, key: string) => {
    const value = values[key as "issueId" | "agentId" | "runId"];
    if (value === null || value.length === 0) {
      missing.push(key);
      return "";
    }
    return encodeURIComponent(value);
  });
  if (missing.length > 0) {
    throw new RecorderError(
      `PAPERCLIP_RECORD_PATH requires ${missing.join(", ")} but the run context did not supply it`,
    );
  }
  return path.startsWith("/") ? path : `/${path}`;
}

export class PaperclipRunRecorder implements RunRecorder {
  readonly kind = "paperclip";
  private readonly options: PaperclipRunRecorderOptions;

  constructor(options: PaperclipRunRecorderOptions) {
    this.options = options;
  }

  async record(outcome: RunOutcome): Promise<void> {
    const path = renderRecordPath(this.options.pathTemplate, {
      issueId: outcome.issueId,
      agentId: outcome.agentId,
      runId: outcome.runId,
    });
    const url = `${this.options.baseUrl.replace(/\/+$/, "")}${path}`;

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.options.timeoutMs ?? 15_000);
    if (typeof timer.unref === "function") timer.unref();

    const apiKey =
      this.options.apiKeyByExposure?.[outcome.exposure] ?? this.options.apiKey;

    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json",
      authorization: `Bearer ${apiKey}`,
    };
    // Paperclip reads this in its auth middleware and its own agent guidance
    // says to send it on every mutating call.
    if (outcome.runId !== null && outcome.runId.length > 0) {
      headers["x-paperclip-run-id"] = outcome.runId;
    }

    const payload = JSON.stringify({ body: renderOutcomeBody(outcome) });

    let response: Response;
    try {
      response = await this.options.safeFetch(url, {
        method: "POST",
        headers,
        body: payload,
        signal: controller.signal,
      });
      // Paperclip 500s when X-Paperclip-Run-Id names a run it cannot resolve
      // (verified live: no header 201, unknown run id 500). This is the employee's
      // actual output — losing it to a correlation-header artefact is unacceptable,
      // so retry once without the header. Mirrors HttpPaperclipApi.request.
      if (response.status === 500 && "x-paperclip-run-id" in headers) {
        const { "x-paperclip-run-id": _dropped, ...withoutRunId } = headers;
        response = await this.options.safeFetch(url, {
          method: "POST",
          headers: withoutRunId,
          body: payload,
          signal: controller.signal,
        });
      }
    } catch (err) {
      if (timedOut) throw new RecorderError("write-back timed out");
      if (err instanceof EgressBlockedError) {
        throw new RecorderError("write-back host is not on the egress allowlist");
      }
      const name = err instanceof Error ? err.name : "unknown";
      throw new RecorderError(`write-back transport failure (${name})`);
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      throw new RecorderError(`write-back returned HTTP ${response.status}`);
    }
  }
}

/** Choose a recorder: Paperclip when a key and a base URL exist, Null otherwise. */
export function createRecorder(args: {
  baseUrl: string | null;
  apiKey: string | null;
  apiKeyByExposure?: Readonly<Partial<Record<Exposure, string | null>>>;
  pathTemplate: string;
  safeFetch: SafeFetch;
}): RunRecorder {
  if (args.apiKey === null || args.baseUrl === null) return new NullRunRecorder();
  return new PaperclipRunRecorder({
    baseUrl: args.baseUrl,
    apiKey: args.apiKey,
    ...(args.apiKeyByExposure === undefined
      ? {}
      : { apiKeyByExposure: args.apiKeyByExposure }),
    pathTemplate: args.pathTemplate,
    safeFetch: args.safeFetch,
  });
}
