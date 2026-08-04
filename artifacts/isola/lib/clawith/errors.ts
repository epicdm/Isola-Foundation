/**
 * Foundation ↔ Clawith failure taxonomy.
 *
 * Every way the structured path can fail is named here, because the whole
 * point of the gated path is that a failure is CLASSIFIED and acted on rather
 * than silently swallowed into an unrelated native reply. `lib/brain-provider.ts`
 * today logs `Isola bridge failed — falling back to native` for all of
 * timeout, 401, 5xx and malformed body alike; that is precisely the
 * indistinguishability this taxonomy removes.
 */

export type ClawithFailureKind =
  /** No CLAWITH_SHARED_SECRET in the environment — no request was made. */
  | 'secret_missing'
  /** brain_provider=clawith but no ClawithBinding / designated agent resolved. */
  | 'agent_missing'
  /** Foundation refused to build the request (bad or cross-tenant input). */
  | 'request_invalid'
  /** Deadline elapsed before Clawith answered. */
  | 'timeout'
  /** Clawith rejected our credential (401/403). */
  | 'auth_rejected'
  /** Clawith answered with a non-2xx that is not an auth rejection. */
  | 'http_error'
  /** 402 / insufficient balance — the credential has no funds. Never
   *  retryable on the same model+credential (see `RETRYABLE`). */
  | 'payment_required'
  /** 429 — retryable, but not on the tight in-call retry loop. */
  | 'rate_limited'
  /** 502/503/504 — the provider itself is down, not our credential. */
  | 'provider_unavailable'
  /** Transport failed before any status was seen. */
  | 'network_error'
  /** Body was not JSON, or failed schema validation. */
  | 'invalid_response'
  /** Response correlation_id did not echo the request's. */
  | 'correlation_mismatch'
  /** Response agent_id was not the designated agent. */
  | 'agent_mismatch'
  /** Response referenced a tenant other than the requesting one. */
  | 'tenant_mismatch'
  /** Response asked for a tool this request did not authorise. */
  | 'unsupported_tool'
  /** Response asserted mutually exclusive states (e.g. a success claim
   *  alongside an unresolved required tool failure). */
  | 'contradictory_response'
  /** A structurally valid 200 response whose customer-visible text is
   *  itself a raw provider/runtime failure (HTTP code, run id, billing
   *  text, non-English runtime error) — the exact leak this taxonomy
   *  exists to catch when it arrives through a "successful" call. */
  | 'provider_error_leaked'
  /** The per-agent circuit breaker is open for this credential; refused
   *  before any network attempt was made. */
  | 'circuit_open';

/** Kinds worth one bounded retry: transient transport conditions only.
 *  An auth rejection, a schema violation or a config error will fail
 *  identically on a retry and retrying only delays the customer. Payment
 *  failures and leaked provider errors are deliberately excluded — retrying
 *  the same model/credential cannot fix either, and retrying only delays a
 *  reply that will fail again. */
const RETRYABLE: ReadonlySet<ClawithFailureKind> = new Set<ClawithFailureKind>([
  'timeout',
  'network_error',
  'http_error',
  'provider_unavailable',
]);

/** Kinds that are a CONFIGURATION defect on our side rather than a runtime
 *  fault. Telling the customer "we're having trouble" for these would be a
 *  claim about the conversation that isn't true — nothing about their message
 *  failed. These are recorded and the turn is suppressed instead. */
const CONFIGURATION: ReadonlySet<ClawithFailureKind> = new Set<ClawithFailureKind>([
  'secret_missing',
  'agent_missing',
  'request_invalid',
  'tenant_mismatch',
]);

export class ClawithFailure extends Error {
  readonly kind: ClawithFailureKind;
  readonly status: number | null;
  readonly detail: string | null;

  constructor(kind: ClawithFailureKind, detail?: string | null, status?: number | null) {
    super(`clawith:${kind}${detail ? ` (${detail})` : ''}`);
    this.name = 'ClawithFailure';
    this.kind = kind;
    this.status = status ?? null;
    this.detail = detail ?? null;
  }
}

export function isClawithFailure(err: unknown): err is ClawithFailure {
  return err instanceof ClawithFailure;
}

export function isRetryable(kind: ClawithFailureKind): boolean {
  return RETRYABLE.has(kind);
}

export function isConfigurationFailure(kind: ClawithFailureKind): boolean {
  return CONFIGURATION.has(kind);
}

/** Map an HTTP status from the bridge onto a failure kind.
 *  401/403 are called out separately from the rest of 4xx/5xx because an
 *  expired or rotated shared secret is an operational condition someone must
 *  fix, not a transient blip to retry — and it is exactly the condition that
 *  took inbox 46 to a silent native fallback on 2026-07-25. */
export function classifyHttpStatus(status: number): ClawithFailureKind {
  if (status === 401 || status === 403) return 'auth_rejected';
  if (status === 402) return 'payment_required';
  if (status === 429) return 'rate_limited';
  if (status === 502 || status === 503 || status === 504) return 'provider_unavailable';
  return 'http_error';
}

/** Normalise anything thrown by `fetch`/`AbortSignal.timeout` into a kind. */
export function classifyThrown(err: unknown): ClawithFailureKind {
  const name = (err as { name?: unknown } | null)?.name;
  if (name === 'TimeoutError' || name === 'AbortError') return 'timeout';
  return 'network_error';
}
