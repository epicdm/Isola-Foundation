/**
 * Error taxonomy. Every error that can reach a log line or an HTTP body must be
 * one of these, and every message must be safe to print: category only, never a
 * secret, never a raw upstream payload, never customer message content.
 */

export class EgressBlockedError extends Error {
  readonly host: string;
  constructor(host: string) {
    super(`egress blocked: host "${host}" is not in the egress allowlist`);
    this.name = "EgressBlockedError";
    this.host = host;
  }
}

/**
 * An allowed host answered with a 3xx. The redirect is NOT followed (Codex R1: a
 * followed 307/308 re-sent the customer-bearing body to a host the allowlist never
 * checked). It is an EgressBlockedError so every existing caller already treats it as
 * a configuration defect (nothing was sent to the redirect target), never as an
 * uncertain send. The message carries the status only: never the Location, which can
 * carry a token, and never a body.
 */
export class EgressRedirectBlockedError extends EgressBlockedError {
  readonly status: number;
  constructor(host: string, status: number) {
    super(host);
    this.name = "EgressRedirectBlockedError";
    this.status = status;
    this.message = `egress blocked: host "${host}" answered a redirect (${status}); redirects are never followed`;
  }
}

/**
 * A Chatwoot Application API call failed.
 *
 * `detail` is a category string built by this service. Chatwoot response bodies
 * are never carried here — they echo conversation content.
 */
export class ChatwootApiError extends Error {
  readonly status: number | null;
  readonly detail: string;
  constructor(detail: string, status: number | null = null) {
    super(`chatwoot api error: ${detail}`);
    this.name = "ChatwootApiError";
    this.status = status;
    this.detail = detail;
  }
}

/**
 * The call to isola-runtime did not produce a usable result. `outcome` is the
 * gateway-side category, never the runtime's raw body.
 */
export class RuntimeCallError extends Error {
  readonly outcome: string;
  readonly status: number | null;
  constructor(outcome: string, status: number | null = null) {
    super(`runtime call failed: ${outcome}`);
    this.name = "RuntimeCallError";
    this.outcome = outcome;
    this.status = status;
  }
}
