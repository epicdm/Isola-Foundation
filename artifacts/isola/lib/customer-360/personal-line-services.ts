/**
 * personal-line-services.ts — Foundation's FIRST server-to-server read of
 * bff-v2, closing the gap `lib/context/customer-sources.ts`'s
 * `CALLS_NOT_CONNECTED_REASON` already documented for the sibling "calls"
 * section: "Foundation itself has no server-to-server path to it... expose
 * a small bff-v2 read endpoint and add a Foundation-side reader that calls
 * it server-to-server, keyed off this partner's ... LiteAccount.odooPartnerId."
 *
 * A DIFFERENT credential from `engines/bff.ts`'s `BffConfig`. That module
 * holds `BFF_INTERNAL_SECRET` -- a BROAD secret that also authorizes
 * consumer money movement (mirror-account, topup, callback) against
 * bff.epic.dm's "BFF Lite" consumer-facing surface. This module needs only
 * a READ of one customer's Personal Line summary, so it uses the NARROWER
 * `BFF_V2_PL_OPERATOR_READ_TOKEN` -- the same scoped credential
 * isola-portal's `personal_line_bff_client.py` already prefers for
 * `get_service_detail()`/`list_accounts()`/`get_registration_batch()`, per
 * the 2026-09-19 owner ruling that moved those reads OFF the broad secret.
 * Reusing `BffConfig`/`BFF_INTERNAL_SECRET` here would reintroduce the
 * exact anti-pattern that ruling closed -- a read-only surface holding a
 * credential that also moves money -- so this module deliberately does NOT
 * import `engines/bff.ts` or `resolveBffConfigForTenant`.
 *
 * PROVISIONING: `BFF_V2_INTERNAL_BASE_URL` / `BFF_V2_PL_OPERATOR_READ_TOKEN`
 * do not exist in Foundation's runtime as of this file's creation --
 * granting Foundation this credential is a genuine trust-boundary widening
 * (a third consumer of the same scoped token, after isola-portal's two
 * existing ones) and needs an explicit owner ruling, the same class of
 * decision `get_service_detail()`'s own docstring records for the last
 * time this token was widened. Until that ruling lands and the env vars
 * are set, `_configured()` returns false and every call here resolves to
 * `{ available: false, services: [] }` -- fails closed, never a fabricated
 * empty-looking-healthy result.
 */

import type { Customer360Service } from './contracts';

const ENDPOINT_PATH = '/api/internal/customer-360/services';
const TIMEOUT_MS = 10_000;

function baseUrl(): string | null {
  const url = process.env.BFF_V2_INTERNAL_BASE_URL;
  return url ? url.replace(/\/+$/, '') : null;
}

function readToken(): string | null {
  return process.env.BFF_V2_PL_OPERATOR_READ_TOKEN || null;
}

function _configured(): boolean {
  return Boolean(baseUrl() && readToken());
}

/** Present so a test can assert the honest not-configured path without
 *  needing to poke real env vars. */
export function isPersonalLineServicesConfigured(): boolean {
  return _configured();
}

function normaliseService(raw: unknown): Customer360Service | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const did = typeof r.did === 'string' && r.did ? r.did : null;
  // A service this module cannot key on (no readable `did`) is not a
  // service to render -- same discipline as isola-portal's own
  // `normaliseTransaction`/`normaliseFollowup` dropping an unkeyable row
  // rather than rendering a broken one.
  if (!did) return null;
  return {
    kind: 'personal_line',
    did,
    sipRegistered: typeof r.sipRegistered === 'boolean' ? r.sipRegistered : null,
    magnusUserAssigned: r.magnusUserAssigned === true,
    createdAt: typeof r.createdAt === 'string' ? r.createdAt : null,
  };
}

/**
 * ONE customer's Personal Line service summary. NEVER throws -- a
 * transport failure, a missing credential, or a malformed body all resolve
 * to `{ available: false, services: [] }`, which the caller (odoo-
 * projection.ts) reports as `servicesAvailable: false`, the same tolerated-
 * failure shape `openLoopsAvailable`/`followUpsAvailable` already use. This
 * function does not decide whether "unavailable" is rendered as an error
 * or a quiet gap -- that is the UI's call, same as every other tolerated
 * section.
 */
export async function readPersonalLineServices(
  odooPartnerId: number,
): Promise<{ available: boolean; services: Customer360Service[] }> {
  const url = baseUrl();
  const token = readToken();
  if (!url || !token) {
    return { available: false, services: [] };
  }

  let res: Response;
  try {
    res = await fetch(`${url}${ENDPOINT_PATH}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-pl-operator-read-token': token,
      },
      body: JSON.stringify({ odooPartnerId }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    const detail = e instanceof Error ? e.message : 'network error';
    console.error('[customer-360] personal-line-services network error:', detail);
    return { available: false, services: [] };
  }

  if (!res.ok) {
    console.error('[customer-360] personal-line-services rejected:', res.status);
    return { available: false, services: [] };
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    console.error('[customer-360] personal-line-services non-JSON response');
    return { available: false, services: [] };
  }

  const rawServices =
    typeof body === 'object' && body !== null && Array.isArray((body as Record<string, unknown>).services)
      ? ((body as Record<string, unknown>).services as unknown[])
      : null;
  if (rawServices === null) {
    console.error('[customer-360] personal-line-services malformed body (no services array)');
    return { available: false, services: [] };
  }

  const services = rawServices.map(normaliseService).filter((s): s is Customer360Service => s !== null);
  return { available: true, services };
}
