/**
 * Secret custody.
 *
 * This is the only module that holds a Meta credential, and it never returns one
 * to a caller. `withTenantCredential()` hands the token to a callback and the
 * value goes out of scope when that callback returns; nothing else in the
 * process can ask for it.
 *
 * The store is a Docker Swarm secret mounted read-only at /run/secrets. Swarm
 * secrets are encrypted in the Raft log, are delivered only to the services that
 * declare them, and are never written to the container filesystem — the mount is
 * a tmpfs. That makes them gateway-exclusive by construction, which is what the
 * owner decision asked for.
 *
 * DELIBERATELY ABSENT:
 *   - reading a credential from the application database
 *   - reading a credential from a name supplied by a database row
 *   - reading a credential from a name supplied by a caller
 *   - any code path that puts a credential in a return value, a log line, an
 *     audit record, an error message or a stack trace
 *
 * Per-tenant selection is derived from the AUTHENTICATED workload's tenant and
 * the asset scope declared for that tenant. A caller cannot name a credential.
 */

import { readFileSync } from 'node:fs';
import { createHash, timingSafeEqual } from 'node:crypto';

export interface AssetRef {
  readonly kind: 'waba' | 'phone_number' | 'token';
  readonly id: string;
}

export interface Workload {
  readonly workload_id: string;
  readonly tenant_id: string;
  readonly roles: readonly string[];
}

interface TenantRecord {
  readonly assets: readonly AssetRef[];
  /** Never leaves this module. */
  readonly meta_token: string;
}

interface SecretFile {
  readonly workloads: Record<string, { workload_id: string; tenant_id: string; roles: string[] }>;
  readonly tenants: Record<string, { assets: AssetRef[]; meta_token: string }>;
}

let WORKLOADS = new Map<string, Workload>();
let TENANTS = new Map<string, TenantRecord>();
let loadedAt = 0;

/** SHA-256 hex of a presented bearer token; the file stores hashes, not tokens. */
function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function loadSecrets(path: string): { workloads: number; tenants: number } {
  const raw = readFileSync(path, 'utf8');
  let parsed: SecretFile;
  try {
    parsed = JSON.parse(raw) as SecretFile;
  } catch {
    // The message deliberately carries no content from the file.
    throw new Error('secret store is not valid JSON');
  }

  const workloads = new Map<string, Workload>();
  for (const [hash, w] of Object.entries(parsed.workloads ?? {})) {
    if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error('secret store workload key is not a sha256 hex digest');
    if (!w.workload_id || !w.tenant_id) throw new Error('secret store workload record is incomplete');
    workloads.set(hash, { workload_id: w.workload_id, tenant_id: w.tenant_id, roles: w.roles ?? [] });
  }

  const tenants = new Map<string, TenantRecord>();
  for (const [tid, t] of Object.entries(parsed.tenants ?? {})) {
    if (!t.meta_token) throw new Error('secret store tenant record has no credential');
    tenants.set(tid, { assets: t.assets ?? [], meta_token: t.meta_token });
  }

  WORKLOADS = workloads;
  TENANTS = tenants;
  loadedAt = Date.now();
  return { workloads: workloads.size, tenants: tenants.size };
}

export function secretsLoadedAt(): number {
  return loadedAt;
}

/**
 * Authenticate a presented bearer token in constant time.
 *
 * The comparison is over the SHA-256 digests, so it is fixed-length and
 * timing-safe regardless of how long the presented token is.
 */
export function authenticate(presented: string | null): Workload | null {
  if (!presented) return null;
  const digest = Buffer.from(hashToken(presented), 'utf8');

  let found: Workload | null = null;
  for (const [hash, workload] of WORKLOADS) {
    const candidate = Buffer.from(hash, 'utf8');
    if (candidate.length === digest.length && timingSafeEqual(candidate, digest)) {
      found = workload;
      // No early return: the loop cost must not depend on which entry matched.
    }
  }
  return found;
}

/** Is this asset inside the authenticated tenant's declared scope? */
export function tenantOwnsAsset(tenantId: string, kind: AssetRef['kind'], id: string): boolean {
  const t = TENANTS.get(tenantId);
  if (!t) return false;
  return t.assets.some((a) => a.kind === kind && a.id === id);
}

/**
 * Run `fn` with the tenant's Meta credential.
 *
 * The credential is passed in and never returned. If the tenant has no record,
 * the call fails closed rather than falling back to any shared or default token
 * — there is no default token in this design.
 */
export async function withTenantCredential<T>(
  tenantId: string,
  fn: (token: string) => Promise<T>,
): Promise<T> {
  const t = TENANTS.get(tenantId);
  if (!t) throw new Error('no credential is provisioned for this tenant');
  return fn(t.meta_token);
}

/** Diagnostics that are safe to expose: counts and identities, never values. */
export function custodySummary(): { workloads: number; tenants: number; loadedAt: number } {
  return { workloads: WORKLOADS.size, tenants: TENANTS.size, loadedAt };
}

/** Test seam. Never called in production. */
export function __loadForTest(file: SecretFile): void {
  WORKLOADS = new Map(
    Object.entries(file.workloads ?? {}).map(([h, w]) => [h, { workload_id: w.workload_id, tenant_id: w.tenant_id, roles: w.roles ?? [] }]),
  );
  TENANTS = new Map(Object.entries(file.tenants ?? {}).map(([t, r]) => [t, { assets: r.assets ?? [], meta_token: r.meta_token }]));
  loadedAt = Date.now();
}

export { hashToken };
