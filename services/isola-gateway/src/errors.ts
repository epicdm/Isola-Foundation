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
