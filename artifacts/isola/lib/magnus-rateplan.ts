/**
 * lib/magnus-rateplan.ts — app-layer Magnus rate-plan / tariff management.
 *
 * IMPORTANT: this file does NOT modify `engines/magnus.ts` (same discipline
 * as `lib/magnus-voice.ts`) — it calls the exported `magnusRequest()`
 * primitive directly.
 *
 * Every module/field name below was discovered LIVE (read-only probes) —
 * Magnus has no public schema docs for this billing panel:
 *
 *   - `plan`   — the rate plan itself. There is NO separate "rateplan" or
 *     "tariff" module — `plan` IS the rate plan (id, name, tariff_limit, …).
 *     EMA_Basic=34, EMA_Standard=45, EMA_Premium=46 (verified live).
 *   - `rate`   — one row per (id_plan, id_prefix): the actual per-destination
 *     sell rate for a plan. Key fields: id, id_plan, id_prefix, id_trunk_group,
 *     rateinitial (per-minute sell rate, decimal string), status,
 *     billingblock/initblock/minimal_time_charge/connectcharge/
 *     disconnectcharge/additional_grace/package_offer (billing mechanics).
 *     The `read` action returns these DENORMALIZED joins for display:
 *     idPlanname, idPrefixprefix, idPrefixdestination, idTrunkGroupname.
 *   - `prefix` — the destination/dial-prefix catalog (~95k rows): id, prefix
 *     (dial prefix string, e.g. "1767225"), destination (display name).
 *   - `trunk`  — the carrier trunk/route catalog: id, trunkcode (display name).
 *
 * MAGNUS FILTER QUIRK (verified live, non-obvious, costly to rediscover):
 *   Only `comparison: 'eq'` filters are actually honored by Magnus's grid
 *   `read` action. Any filter using 'cn' (contains) or 'like', and any `sort`
 *   parameter, are SILENTLY IGNORED — Magnus returns the unfiltered/
 *   unsorted first page instead of erroring. This means:
 *     - Exact-match lookups (by id, by exact prefix string) work great.
 *     - Free-text destination-name search must be done CLIENT-SIDE after
 *       fetching rows (fine for a single plan's ~0-400 rate rows; would NOT
 *       scale to the full ~95k prefix catalog — exact-prefix lookup only
 *       there).
 *   The `count` field (not `total`) carries the grid's total row count.
 *
 * WRITE CONTRACT (verified live against a real EMA_Basic rate row, bumped
 * then immediately reverted):
 *   - EDIT: `rate/save` with just `{ id, rateinitial }` is a clean partial
 *     UPDATE — every other column on the row is left untouched. Same
 *     partial-update contract already proven for `user/save`
 *     (patchUserPrefixLocal) and `sip/save` (patchSipCallerId).
 *   - CREATE (id: '0'): untested live in this file — by analogy with every
 *     other Magnus "save"-action create paths (user, sip, diddestination), several
 *     columns are NOT NULL with no DB default and a create silently no-ops
 *     with `success:false` (not a thrown error) if omitted. `createPlanRate`
 *     below sends the full field set mirrored from real existing rows and
 *     REQUIRES the caller to check `.success` — never assume it worked.
 *
 * PLAN-ASSIGNMENT NOTE: a Tenant's Magnus rate plan lives on `user.id_plan`
 * — NOT on our own `Tenant.plan` field (that's a separate internal
 * starter/growth/pro label, unrelated to Magnus billing).
 */

import { magnusRequest, type MagnusConfig } from '@/engines/magnus';

// ── generic grid helpers (same style as magnus-voice.ts's readRows/findOneByField) ──

async function readRows(
  config: MagnusConfig,
  magnusModule: string,
  opts: {
    filter?: Array<{ type: 'string' | 'numeric'; field: string; value: string; comparison: 'eq' }>;
    limit?: number;
    start?: number;
  } = {},
): Promise<{ rows: Record<string, any>[]; count: number }> {
  const res = await magnusRequest(config, magnusModule, 'read', {
    page: '1',
    start: String(opts.start ?? 0),
    limit: String(opts.limit ?? 25),
    ...(opts.filter ? { filter: JSON.stringify(opts.filter) } : {}),
  });
  return { rows: res?.rows ?? [], count: parseInt(String(res?.count ?? '0'), 10) };
}

async function findOneByField(
  config: MagnusConfig,
  magnusModule: string,
  field: string,
  value: string,
): Promise<Record<string, any> | null> {
  const isNumeric = /^\d+$/.test(value);
  const { rows } = await readRows(config, magnusModule, {
    filter: [{ type: isNumeric ? 'numeric' : 'string', field, value, comparison: 'eq' }],
    limit: 1,
  });
  return rows[0] ?? null;
}

// ── Rate plans (`plan` module) ──────────────────────────────────────────────

export interface RatePlan {
  id: string;
  name: string;
  tariffLimit: string;
  creationDate: string;
}

function toRatePlan(row: Record<string, any>): RatePlan {
  return {
    id: String(row.id),
    name: String(row.name ?? ''),
    tariffLimit: String(row.tariff_limit ?? ''),
    creationDate: String(row.creationdate ?? ''),
  };
}

/** Lists every Magnus rate plan (small table — ~20 rows currently). */
export async function listRatePlans(config: MagnusConfig): Promise<RatePlan[]> {
  const { rows } = await readRows(config, 'plan', { limit: 500 });
  return rows.map(toRatePlan).sort((a, b) => a.name.localeCompare(b.name));
}

export async function getRatePlan(config: MagnusConfig, id: string): Promise<RatePlan | null> {
  const row = await findOneByField(config, 'plan', 'id', id);
  return row ? toRatePlan(row) : null;
}

// ── Rates (`rate` module) — per-destination sell rates for a plan ──────────

export interface PlanRate {
  id: string;
  idPlan: string;
  idPrefix: string;
  idTrunkGroup: string;
  prefix: string;
  destination: string;
  trunkName: string;
  rateinitial: string; // per-minute sell rate, decimal string e.g. "0.300000"
  status: string;
  // billing-mechanics fields, echoed back so an edit can preserve them
  billingblock: string;
  initblock: string;
  connectcharge: string;
  disconnectcharge: string;
  minimalTimeCharge: string;
  additionalGrace: string;
  packageOffer: string;
}

function toPlanRate(row: Record<string, any>): PlanRate {
  return {
    id: String(row.id),
    idPlan: String(row.id_plan),
    idPrefix: String(row.id_prefix),
    idTrunkGroup: String(row.id_trunk_group ?? ''),
    prefix: String(row.idPrefixprefix ?? ''),
    destination: String(row.idPrefixdestination ?? ''),
    trunkName: String(row.idTrunkGroupname ?? ''),
    rateinitial: String(row.rateinitial ?? '0'),
    status: String(row.status ?? '1'),
    billingblock: String(row.billingblock ?? '1'),
    initblock: String(row.initblock ?? '1'),
    connectcharge: String(row.connectcharge ?? '0.00000'),
    disconnectcharge: String(row.disconnectcharge ?? '0.00000'),
    minimalTimeCharge: String(row.minimal_time_charge ?? '0'),
    additionalGrace: String(row.additional_grace ?? '0'),
    packageOffer: String(row.package_offer ?? '1'),
  };
}

/**
 * Every configured rate row for a plan. Magnus's own filter only supports
 * exact-match, so free-text search (by destination name or prefix) is done
 * here, client-side, after the full set is fetched. Fine for a single
 * plan's tariff (tens to a few hundred rows observed live); NOT suitable for
 * the full prefix catalog (~95k rows) — use `findPrefixByExact` for that.
 */
export async function listPlanRates(
  config: MagnusConfig,
  idPlan: string,
  opts: { search?: string; limit?: number } = {},
): Promise<{ rates: PlanRate[]; totalForPlan: number }> {
  const { rows, count } = await readRows(config, 'rate', {
    filter: [{ type: 'numeric', field: 'id_plan', value: idPlan, comparison: 'eq' }],
    limit: opts.limit ?? 1000,
  });
  let rates = rows.map(toPlanRate);
  const q = opts.search?.trim().toLowerCase();
  if (q) {
    rates = rates.filter((r) => r.destination.toLowerCase().includes(q) || r.prefix.includes(q));
  }
  rates.sort((a, b) => a.destination.localeCompare(b.destination) || a.prefix.localeCompare(b.prefix));
  return { rates, totalForPlan: count };
}

export async function getPlanRate(config: MagnusConfig, rateId: string): Promise<PlanRate | null> {
  const row = await findOneByField(config, 'rate', 'id', rateId);
  return row ? toPlanRate(row) : null;
}

export interface MagnusWriteResult {
  success: boolean;
  error?: string;
}

/**
 * EDIT an existing rate row's per-minute sell rate. Verified live: a
 * partial `{ id, rateinitial }` save leaves every other column untouched —
 * do NOT widen this to send other fields unless a caller actually needs to
 * change them (each additional field is one more risk of a NOT-NULL trap
 * on a value we don't intend to touch).
 */
export async function updatePlanRateAmount(
  config: MagnusConfig,
  rateId: string,
  rateinitial: number,
): Promise<MagnusWriteResult> {
  try {
    const res = await magnusRequest(config, 'rate', 'save', {
      id: rateId,
      rateinitial: rateinitial.toFixed(6),
    });
    if (res?.success === false) {
      return { success: false, error: res?.errors ? JSON.stringify(res.errors) : 'Magnus rejected the update' };
    }
    return { success: true };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
}

/**
 * CREATE a new rate row for a plan+prefix that doesn't have one yet.
 * UNTESTED against a real create (only the edit path was live-verified) —
 * field defaults mirror real existing rows exactly (billingblock/initblock
 * '1', connectcharge/disconnectcharge '0.00000', minimal_time_charge/
 * additional_grace '0', package_offer '1', status '1'). Callers MUST check
 * `.success` — Magnus returns HTTP 200 with `success:false` (not a thrown
 * error) when a NOT-NULL column is missing, same as every other Magnus
 * "save"-action create path in this codebase.
 */
export async function createPlanRate(
  config: MagnusConfig,
  params: { idPlan: string; idPrefix: string; idTrunkGroup: string; rateinitial: number },
): Promise<MagnusWriteResult & { rateId?: string }> {
  try {
    const res = await magnusRequest(config, 'rate', 'save', {
      id: '0',
      id_plan: params.idPlan,
      id_prefix: params.idPrefix,
      id_trunk_group: params.idTrunkGroup,
      rateinitial: params.rateinitial.toFixed(6),
      status: '1',
      billingblock: '1',
      initblock: '1',
      connectcharge: '0.00000',
      disconnectcharge: '0.00000',
      minimal_time_charge: '0',
      additional_grace: '0',
      package_offer: '1',
    });
    if (res?.success === false || !res?.rows?.[0]?.id) {
      return { success: false, error: res?.errors ? JSON.stringify(res.errors) : 'Magnus did not create the rate row' };
    }
    return { success: true, rateId: String(res.rows[0].id) };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
}

// ── Prefix catalog (`prefix` module, ~95k rows — exact match only) ─────────

export interface PrefixEntry {
  id: string;
  prefix: string;
  destination: string;
}

/** Exact dial-prefix lookup (e.g. "44" for UK, "1767225" for Dominica Cellular).
 *  Magnus's filter only supports exact match here — there is no server-side
 *  substring search over the ~95k-row prefix catalog. */
export async function findPrefixByExact(config: MagnusConfig, prefix: string): Promise<PrefixEntry | null> {
  const row = await findOneByField(config, 'prefix', 'prefix', prefix);
  if (!row) return null;
  return { id: String(row.id), prefix: String(row.prefix), destination: String(row.destination ?? '') };
}

// ── Trunk groups (`trunk` module) ───────────────────────────────────────────

export interface TrunkEntry {
  id: string;
  code: string;
}

export async function listTrunks(config: MagnusConfig): Promise<TrunkEntry[]> {
  const { rows } = await readRows(config, 'trunk', { limit: 500 });
  return rows
    .map((r) => ({ id: String(r.id), code: String(r.trunkcode ?? '') }))
    .sort((a, b) => a.code.localeCompare(b.code));
}

// ── Customer plan assignment (`user.id_plan`) ───────────────────────────────

/** Read-only: which Magnus rate plan a Magnus user (Tenant.magnus_user_id or
 *  ConsumerAccount.magnus_user_id) is currently on. */
export async function getUserRatePlanId(config: MagnusConfig, magnusUserId: string): Promise<string | null> {
  const row = await findOneByField(config, 'user', 'id', magnusUserId);
  if (!row) return null;
  return String(row.id_plan ?? '');
}

/** Change which rate plan a Magnus user is billed under. Partial update —
 *  same proven-safe contract as `patchUserPrefixLocal` (only `id_plan` is
 *  touched; every other `user` column is left alone). */
export async function setUserRatePlanId(
  config: MagnusConfig,
  magnusUserId: string,
  idPlan: string,
): Promise<MagnusWriteResult> {
  try {
    const res = await magnusRequest(config, 'user', 'save', { id: magnusUserId, id_plan: idPlan });
    if (res?.success === false) {
      return { success: false, error: res?.errors ? JSON.stringify(res.errors) : 'Magnus rejected the plan change' };
    }
    return { success: true };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
}
