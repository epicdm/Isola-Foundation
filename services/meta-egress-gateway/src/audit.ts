/**
 * Audit.
 *
 * One structured event per gateway decision, on stdout, collected by the
 * platform's log pipeline. Events carry identity, operation, asset, outcome and
 * a correlation id — and never credential material.
 *
 * The redaction here is an ALLOWLIST, matching the response projection: an audit
 * event is assembled from named fields, so there is no path by which an
 * unexpected value reaches the log. A denylist scrubber would be the wrong
 * shape — it fails open on whatever it has not been taught.
 *
 * The `assertNoSecret` sweep is a backstop for the assembled record only. It
 * exists so that a future edit that adds a field cannot quietly start logging a
 * token, and it throws rather than emitting a redacted line, because a silent
 * near-miss is how these things survive review.
 */

export type AuditOutcome =
  | 'ok'
  | 'denied_auth'
  | 'denied_unknown_operation'
  | 'denied_schema'
  | 'denied_scope'
  | 'denied_approval'
  | 'denied_rate'
  | 'denied_kill_switch'
  | 'denied_no_credential'
  | 'upstream_failed';

export interface AuditEvent {
  readonly event: 'meta.gateway';
  readonly ts: string;
  readonly correlation_id: string;
  readonly workload_id: string | null;
  readonly tenant_id: string | null;
  readonly operation_id: string | null;
  readonly operation_class: string | null;
  readonly asset_kind: string | null;
  readonly asset_id: string | null;
  readonly target: string | null;
  readonly method: string | null;
  readonly outcome: AuditOutcome;
  readonly upstream_status: number | null;
  readonly failure: string | null;
  readonly duration_ms: number;
  readonly approval_id: string | null;
}

/**
 * Shapes that must never appear in an audit line. Meta user and system tokens
 * begin `EAA`; app secrets and long opaque strings are caught by length.
 */
const SECRET_SHAPES: readonly RegExp[] = [
  /EAA[A-Za-z0-9]{20,}/,
  /\bBearer\s+\S+/i,
  /\baccess_token\b/i,
  /\bappsecret_proof\b/i,
  /\bclient_secret\b/i,
  /[A-Za-z0-9_-]{60,}/,
];

export function assertNoSecret(record: unknown): void {
  const serialised = JSON.stringify(record);
  for (const re of SECRET_SHAPES) {
    if (re.test(serialised)) {
      throw new Error(`audit record rejected: matched a credential shape (${re.source})`);
    }
  }
}

export function emit(event: AuditEvent, sink: (line: string) => void = (l) => process.stdout.write(l + '\n')): void {
  assertNoSecret(event);
  sink(JSON.stringify(event));
}

export function newCorrelationId(): string {
  return `mg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}
