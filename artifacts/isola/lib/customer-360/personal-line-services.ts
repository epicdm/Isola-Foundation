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

import type { Customer360Service, LifecycleMilestones, Milestone, MilestoneStatus } from './contracts';

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

const MILESTONE_STATUSES: readonly MilestoneStatus[] = ['done', 'pending', 'blocked', 'unknown'];
const MILESTONE_KEYS = [
  'signup',
  'number_assigned',
  'sip_registered',
  'first_confirmation_or_call',
  'trial_or_plan_active',
  'odoo_linked',
] as const;

function normaliseMilestone(raw: unknown): Milestone | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const status = typeof r.status === 'string' && (MILESTONE_STATUSES as readonly string[]).includes(r.status)
    ? (r.status as MilestoneStatus)
    : null;
  // A milestone this module cannot read an honest status for is not a
  // milestone to render as if it were one -- same "drop rather than guess"
  // rule normaliseService already applies to an unkeyable service.
  if (!status) return null;
  return {
    status,
    evidenceAt: typeof r.evidenceAt === 'string' ? r.evidenceAt : null,
    failureReason: typeof r.failureReason === 'string' ? r.failureReason : null,
    nextAction: typeof r.nextAction === 'string' ? r.nextAction : null,
  };
}

/** `undefined` (not present -- an older server) or `null` (present but
 *  malformed/failed) both mean "no checklist to show", distinctly from a
 *  real `LifecycleMilestones` -- the panel decides how to render each. */
function normaliseLifecycle(raw: unknown): LifecycleMilestones | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const milestones: Partial<Record<(typeof MILESTONE_KEYS)[number], Milestone>> = {};
  for (const key of MILESTONE_KEYS) {
    const m = normaliseMilestone(r[key]);
    // Any one milestone failing to parse honestly means the whole checklist
    // cannot be trusted -- a five-sixths-complete checklist with one gap
    // silently dropped would misrepresent which step the operator is
    // actually missing, not just show less than it could.
    if (!m) return null;
    milestones[key] = m;
  }
  return milestones as LifecycleMilestones;
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
    lifecycle: normaliseLifecycle(r.lifecycle),
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

const RESOLVE_PATH = '/api/internal/personal-line/resolve-action-target';
const SERVICE_DETAIL_PATH_PREFIX = '/api/internal/personal-line/';
const SERVICE_DETAIL_PATH_SUFFIX = '/service-detail';

export type LifecycleReadResult =
  | { state: 'ready'; lifecycle: LifecycleMilestones }
  | { state: 'not-found'; message: string }
  | { state: 'unavailable'; message: string };

/**
 * A Personal Line's onboarding checklist, fetched on demand for ONE `did`
 * (owner baseline, 2026-09-20 + the resolve-action-target design, 2026-09-21:
 * this is the ONLY function in this module that ever asks bff-v2 for a
 * liteAccountId, and it does so purely server-to-server -- the id is used to
 * call service-detail and then discarded, never returned by this function,
 * never reaching the caller's caller.
 *
 * CALLER MUST HAVE ALREADY PROVEN OWNERSHIP of `did` against this specific
 * customer's own snapshot (same rule `/api/isola-360/objects` already
 * applies to an objectId) before calling this -- this function trusts the
 * `did` it is given the same way readPersonalLineServices trusts the
 * odooPartnerId it is given; neither one re-derives ownership itself.
 *
 * MULTIPLE MATCHING ACCOUNTS ARE NEVER GUESSED THROUGH: `did` is not
 * schema-unique in bff-v2 (fixture-reset's own findMany already proves
 * this). Rather than pick one and risk showing the wrong account's
 * checklist, an ambiguous match reports 'unavailable' with an honest
 * reason -- the same "never picks a winner" discipline resolve-action-
 * target's own route enforces for the WRITE side, applied here for reads.
 */
export async function resolveAndReadLifecycle(did: string): Promise<LifecycleReadResult> {
  const url = baseUrl();
  const token = readToken();
  if (!url || !token) {
    return { state: 'unavailable', message: 'The Personal Line lifecycle read is not configured on this server yet.' };
  }

  let liteAccountIds: string[];
  try {
    const res = await fetch(`${url}${RESOLVE_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-pl-operator-read-token': token },
      body: JSON.stringify({ did }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return { state: 'unavailable', message: 'bff-v2 could not resolve this Personal Line right now.' };
    const body = await res.json();
    liteAccountIds = Array.isArray(body?.liteAccountIds) ? body.liteAccountIds.filter((id: unknown) => typeof id === 'string') : [];
  } catch (e) {
    const detail = e instanceof Error ? e.message : 'network error';
    console.error('[customer-360] resolveAndReadLifecycle: resolve-action-target failed:', detail);
    return { state: 'unavailable', message: 'bff-v2 could not be reached to resolve this Personal Line.' };
  }

  if (liteAccountIds.length === 0) {
    return { state: 'not-found', message: 'No Personal Line account matches this number.' };
  }
  if (liteAccountIds.length > 1) {
    // Never guess which one this customer's did actually is -- see this
    // function's own header. A real ambiguity is rare (a fixture/duplicate
    // row sharing a number) but showing the WRONG customer's onboarding
    // status would be a serious mistake, not a cosmetic one.
    return { state: 'unavailable', message: 'This number matches more than one Personal Line account and cannot be shown safely here.' };
  }

  const liteAccountId = liteAccountIds[0];

  try {
    const res = await fetch(`${url}${SERVICE_DETAIL_PATH_PREFIX}${encodeURIComponent(liteAccountId)}${SERVICE_DETAIL_PATH_SUFFIX}`, {
      method: 'GET',
      headers: { 'x-pl-operator-read-token': token },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return { state: 'unavailable', message: 'bff-v2 could not read this Personal Line’s status right now.' };
    const body = await res.json();
    const lifecycle = normaliseLifecycle(body?.lifecycle);
    if (!lifecycle) {
      return { state: 'unavailable', message: 'This Personal Line’s onboarding status could not be determined right now.' };
    }
    return { state: 'ready', lifecycle };
  } catch (e) {
    const detail = e instanceof Error ? e.message : 'network error';
    console.error('[customer-360] resolveAndReadLifecycle: service-detail failed:', detail);
    return { state: 'unavailable', message: 'bff-v2 could not be reached to read this Personal Line’s status.' };
  }
}
