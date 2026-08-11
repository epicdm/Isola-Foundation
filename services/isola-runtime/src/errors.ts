/**
 * Error taxonomy. Every error that can reach a log line or an HTTP body must be
 * one of these, and every message must be safe to print: category only, never a
 * secret, never a raw provider payload.
 */

export class EgressBlockedError extends Error {
  readonly host: string;
  constructor(host: string) {
    super(`egress blocked: host "${host}" is not in the egress allowlist`);
    this.name = "EgressBlockedError";
    this.host = host;
  }
}

/** The model provider did not answer inside the hard deadline. */
export class ModelTimeoutError extends Error {
  readonly timeoutMs: number;
  constructor(timeoutMs: number) {
    super(`model provider timed out after ${timeoutMs}ms`);
    this.name = "ModelTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

/**
 * The model provider was reachable but did not produce a usable completion, or
 * was not reachable at all. `detail` is a category string built by this service.
 * Raw provider response bodies are never carried here.
 */
export class ModelProviderError extends Error {
  readonly status: number | null;
  constructor(detail: string, status: number | null = null) {
    super(`model provider error: ${detail}`);
    this.name = "ModelProviderError";
    this.status = status;
  }
}

/** The run recorder could not write the outcome back into Paperclip. */
export class RecorderError extends Error {
  readonly detail: string;
  constructor(detail: string) {
    super(`run recorder failed: ${detail}`);
    this.name = "RecorderError";
    this.detail = detail;
  }
}
