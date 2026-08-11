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

/**
 * The provider answered, but the response carried no usable assistant text.
 *
 * A subclass rather than a separate error on purpose: every existing caller
 * catches `ModelProviderError` and maps it to `502 provider_error` with the
 * message as the failure category, and that behaviour is unchanged byte for
 * byte. The subclass exists only so the inline response contract can report the
 * truthful `completionState: "invalid_output"` instead of a generic provider
 * fault.
 */
export class ModelInvalidOutputError extends ModelProviderError {
  constructor(detail: string, status: number | null = null) {
    super(detail, status);
    this.name = "ModelInvalidOutputError";
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

/**
 * A Paperclip REST call failed.
 *
 * `retryable` is the only thing the outbox needs to decide between backing off
 * and giving up: a 5xx, a 408, a 429 or a transport fault can succeed later; a
 * 400 or a 403 (for example a cost event whose `agentId` is not the calling
 * agent) never will, and retrying it forever would hide real lost spend behind
 * an endless queue.
 *
 * As everywhere else in this service, `detail` is a category string. Paperclip
 * response bodies are never carried here — they can echo request content.
 */
export class PaperclipApiError extends Error {
  readonly status: number | null;
  readonly retryable: boolean;
  readonly detail: string;
  constructor(detail: string, status: number | null, retryable: boolean) {
    super(`paperclip api error: ${detail}`);
    this.name = "PaperclipApiError";
    this.status = status;
    this.retryable = retryable;
    this.detail = detail;
  }
}
