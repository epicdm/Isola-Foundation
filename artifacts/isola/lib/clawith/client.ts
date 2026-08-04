/**
 * Structured Foundation → Clawith client.
 *
 * This WRAPS the existing direct bridge — same URL, same credential, same
 * permanent no-BFF-hop path as `tryIsolaBridge()` in lib/brain-provider.ts.
 * It is not a second Clawith client: it is the same seam carrying the
 * structured envelope, correlation, a real deadline, one bounded retry and a
 * classified failure instead of a swallowed null.
 */

import { CLAWITH_SCHEMA_VERSION, type ClawithRequest, type ClawithResponse } from './contract';
import { isCircuitOpen, recordClawithOutcome } from './circuit-breaker';
import {
  ClawithFailure,
  classifyHttpStatus,
  classifyThrown,
  isClawithFailure,
  isRetryable,
} from './errors';
import { parseClawithResponse } from './response';

/** Same endpoint and same override var as the text bridge, so there is one
 *  place to repoint Clawith and it moves both paths together. */
export const CLAWITH_STRUCTURED_URL =
  process.env.ISOLA_BRIDGE_URL || 'https://agents.epic.dm/api/isola/bridge/message';

/** One retry, and only for transient transport conditions. A customer is
 *  waiting; a retry storm is a worse outcome than a truthful safe reply. */
export const MAX_ATTEMPTS = 2;

export interface ClawithClientOptions {
  /** Injected in tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Injected in tests so the retry path does not actually sleep. */
  sleep?: (ms: number) => Promise<void>;
  /** Overrides the request's own response_deadline_ms. */
  timeoutMs?: number;
  retryDelayMs?: number;
  env?: NodeJS.ProcessEnv;
  /** Overrides the target URL for this call only. Defaults to the module's
   *  `CLAWITH_STRUCTURED_URL` (the gated inbox-46 loop's endpoint, driven by
   *  `ISOLA_BRIDGE_URL`) so every existing caller is unaffected. Lets a second
   *  caller (e.g. staff chat) target its own endpoint, independently
   *  configurable and killable, without repointing `ISOLA_BRIDGE_URL`. */
  url?: string;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface ClawithCallResult {
  response: ClawithResponse;
  attempts: number;
  latencyMs: number;
}

/**
 * Send one structured turn. Resolves with a validated response, or throws a
 * `ClawithFailure` carrying a classified `kind`. It never returns null and it
 * never falls back to anything — deciding what to do with a failure is the
 * caller's job (see ./invoke.ts), and conflating the two is exactly how the
 * silent native fallback happened.
 */
export async function callClawithStructured(
  request: ClawithRequest,
  options: ClawithClientOptions = {},
): Promise<ClawithCallResult> {
  const env = options.env ?? process.env;
  const secret = env.CLAWITH_SHARED_SECRET;
  if (!secret) {
    // Deliberately BEFORE any network work: with no credential there is
    // nothing to attempt, and "we tried and were rejected" is a materially
    // different diagnosis from "we never tried".
    throw new ClawithFailure('secret_missing', 'CLAWITH_SHARED_SECRET is not configured');
  }

  if (isCircuitOpen(request.designated_agent_id)) {
    // A known-failing credential was already caught (payment/leak) within
    // the cooldown window — refused before any network attempt, same as
    // the secret check above.
    throw new ClawithFailure('circuit_open', 'circuit breaker open for this agent/credential');
  }

  const doFetch = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const timeoutMs = options.timeoutMs ?? request.response_deadline_ms;
  const url = options.url ?? CLAWITH_STRUCTURED_URL;
  const startedAt = Date.now();

  const expected = {
    schemaVersion: CLAWITH_SCHEMA_VERSION,
    agentId: request.designated_agent_id,
    correlationId: request.correlation_id,
    tenantId: request.tenant_id,
    allowedToolNames: new Set(request.allowed_tools.map((t) => t.name)),
  };

  let lastFailure: ClawithFailure | null = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await doFetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Isola-Secret': secret,
          // Non-secret, safe to log on either side. Lets an operator join a
          // Foundation log line to a Clawith run without any shared identifier
          // that carries ownership.
          'X-Isola-Correlation-Id': request.correlation_id,
          'X-Isola-Schema-Version': request.schema_version,
        },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!res.ok) {
        const kind = classifyHttpStatus(res.status);
        const detail = await res.text().catch(() => '');
        throw new ClawithFailure(kind, detail.slice(0, 500) || null, res.status);
      }

      let body: unknown;
      try {
        body = await res.json();
      } catch {
        throw new ClawithFailure('invalid_response', 'response body was not JSON', res.status);
      }

      const parsed = parseClawithResponse(body, expected);
      recordClawithOutcome(request.designated_agent_id, 'success');
      return {
        response: parsed,
        attempts: attempt,
        latencyMs: Date.now() - startedAt,
      };
    } catch (err) {
      const failure = isClawithFailure(err)
        ? err
        : new ClawithFailure(classifyThrown(err), (err as Error | null)?.message ?? null);
      lastFailure = failure;

      if (attempt < MAX_ATTEMPTS && isRetryable(failure.kind)) {
        await sleep(options.retryDelayMs ?? 250);
        continue;
      }
      recordClawithOutcome(request.designated_agent_id, failure.kind);
      throw failure;
    }
  }

  /* c8 ignore next */
  throw lastFailure ?? new ClawithFailure('network_error', 'exhausted attempts');
}
