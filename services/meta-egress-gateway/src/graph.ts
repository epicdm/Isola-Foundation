/**
 * The ONLY module in this service that talks to Meta.
 *
 * Everything about the request is built here from an Operation entry plus
 * validated input. There is no parameter, header, host, scheme, version or
 * redirect behaviour a caller can reach.
 *
 * Redirects are refused rather than followed: a 3xx is an error. Following one
 * is how a bearer credential ends up at an address nobody allowlisted, and it is
 * precisely the class the command-text guard could never close.
 */

import type { Operation } from './operations.js';

/** Server-pinned. A caller cannot select an API version; neither can a database row. */
const GRAPH_VERSION = process.env.META_GRAPH_VERSION?.trim() || 'v23.0';
const GRAPH_ORIGIN = 'https://graph.facebook.com';

export interface GraphOutcome {
  readonly ok: boolean;
  readonly status: number;
  /** Parsed JSON, unprojected. Never returned to a caller directly. */
  readonly body: unknown;
  /** Safe, coarse failure class for audit and for the caller. */
  readonly failure?: 'timeout' | 'redirect_refused' | 'too_large' | 'upstream_error' | 'bad_payload' | 'transport';
}

export function graphVersion(): string {
  return GRAPH_VERSION;
}

/** The exact URL this operation will contact, for audit. Contains no credential. */
export function describeTarget(op: Operation, path: string): string {
  const u = new URL(`${GRAPH_ORIGIN}/${GRAPH_VERSION}${path}`);
  for (const [k, v] of Object.entries(op.query ?? {})) u.searchParams.set(k, v);
  return u.toString();
}

export async function callGraph(
  op: Operation,
  path: string,
  token: string,
  body?: unknown,
): Promise<GraphOutcome> {
  const url = new URL(`${GRAPH_ORIGIN}/${GRAPH_VERSION}${path}`);
  for (const [k, v] of Object.entries(op.query ?? {})) url.searchParams.set(k, v);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), op.timeoutMs);

  try {
    const res = await fetch(url, {
      method: op.method,
      // The credential goes in a header, never in the URL — a URL is logged by
      // proxies and intermediaries; a header is not.
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      // Do not follow. A redirect is refused, loudly.
      redirect: 'manual',
      signal: controller.signal,
    });

    if (res.status >= 300 && res.status < 400) {
      return { ok: false, status: res.status, body: null, failure: 'redirect_refused' };
    }

    const raw = await readCapped(res, op.maxResponseBytes);
    if (raw === null) {
      return { ok: false, status: res.status, body: null, failure: 'too_large' };
    }

    let parsed: unknown = null;
    if (raw.length > 0) {
      try {
        parsed = JSON.parse(raw);
      } catch {
        return { ok: false, status: res.status, body: null, failure: 'bad_payload' };
      }
    }

    if (!res.ok) {
      // The upstream error body is NOT returned to the caller: Meta error bodies
      // can echo request parameters, and this service does not forward anything
      // it has not projected.
      return { ok: false, status: res.status, body: parsed, failure: 'upstream_error' };
    }

    return { ok: true, status: res.status, body: parsed };
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError';
    return { ok: false, status: 0, body: null, failure: aborted ? 'timeout' : 'transport' };
  } finally {
    clearTimeout(timer);
  }
}

/** Read at most `limit` bytes; return null if the body exceeds it. */
async function readCapped(res: Response, limit: number): Promise<string | null> {
  const declared = Number(res.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > limit) return null;

  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
}
