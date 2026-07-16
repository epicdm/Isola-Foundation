/**
 * lib/magnus-voice.ts — app-layer Magnus voice/PBX provisioning.
 *
 * IMPORTANT: this file does NOT modify `engines/magnus.ts`. That module only
 * exports 4 read/write helpers (balance, calls, addCredit, debitCredit) by
 * design — DID/SIP/caller-ID provisioning was explicitly out of scope for
 * that extraction. This file calls Magnus's documented signed REST endpoints
 * directly via the exported `magnusRequest()` primitive, following the same
 * HMAC-SHA512 + module/action convention already proven live by the engine.
 *
 * Every field name and destination-string convention below was verified
 * against LIVE production Magnus data (read-only probes) before being wired
 * into a write path — see the "verified live" notes on each function.
 *
 * DID SELECTOR LAWS (hard rules — do not relax without re-verifying live):
 *   - 11-digit number matching /^1767818\d{4}$/
 *   - activated = 1
 *   - id_user IS NULL (unassigned)
 *   - reserved = 0
 *   - no existing `diddestination` row referencing it
 *   - never one of the FORBIDDEN numbers below
 */

import crypto from 'node:crypto';
import { magnusRequest, type MagnusConfig } from '@/engines/magnus';

export const MAGNUS_REGISTRATION_SERVER = 'voice00.epic.dm';

/**
 * Local-dialing prefix rules — verified live against every existing,
 * correctly-configured Magnus account (every `ep_*`/`lt_*` tenant PBX
 * account, plus long-standing retail/wholesale accounts like
 * `AcmetelUSALLC`, `DEBUG_FLOW`, `Donald_17678181502`, etc.) all carry this
 * EXACT same comma-separated value on `user.prefix_local`:
 *   - "star / 1767 / 7"    — any 7-digit local dial (e.g. 2552300) → strip 0
 *                            digits, prepend 1767 → full E.164 1767xxxxxxx.
 *   - "767 / 1767 / 10"    — any 10-digit dial already starting with 767
 *                            (e.g. 7672552300) → strip 0 digits, prepend 1767.
 * Without these two rules, outbound calls to local Dominica numbers have no
 * route. This is a Magnus-side field (not modeled in our own DB) — reconcile
 * against it the same way `sip.callerid`/`cid_number` are reconciled above.
 */
export const DOMINICA_LOCAL_PREFIX_RULES = '*/1767/7,767/1767/10';

export const FORBIDDEN_DIDS = new Set([
  '17678183742',
  '17678189525',
  '17678180001',
  '17678188326',
  '17678180000',
  '17678189043',
]);

export class VoiceProvisioningError extends Error {
  constructor(public step: string, message: string) {
    super(`[${step}] ${message}`);
  }
}

// ── generic grid-read helper (mirrors the private findRowByField in
//    engines/magnus.ts, which is not exported — duplicated here in app
//    code rather than touching the engine file) ─────────────────────────────
async function readRows(
  config: MagnusConfig,
  module: string,
  filter: Array<{ type: 'string' | 'numeric'; field: string; value: string; comparison: string }>,
  limit = 25,
): Promise<Record<string, any>[]> {
  const res = await magnusRequest(config, module, 'read', {
    page: '1',
    start: '0',
    limit: String(limit),
    filter: JSON.stringify(filter),
  });
  return res?.rows ?? [];
}

async function findOneByField(
  config: MagnusConfig,
  module: string,
  field: string,
  value: string,
): Promise<Record<string, any> | null> {
  const isNumeric = /^\d+$/.test(value);
  const rows = await readRows(
    config,
    module,
    [{ type: isNumeric ? 'numeric' : 'string', field, value, comparison: 'eq' }],
    1,
  );
  return rows[0] ?? null;
}

// ── reconciliation reads (backfill-safe re-provisioning) ────────────────────
//
// These are read-only lookups used to resync a Tenant's owner-facing voice
// fields from whatever Magnus actually has on file, WITHOUT ever issuing a
// create/save call. They exist because Magnus is the source of truth for the
// live `sip.secret` (our locally-cached password can drift — e.g. a prior
// partial/duplicate provisioning run patched the row after we last read it)
// and for which DID is actually the one currently wired to a given SIP
// extension (that's whatever `sip.callerid`/`sip.cid_number` is stamped with,
// per the verified-live `patchSipCallerId` convention above — NOT necessarily
// whichever DID row a stale/duplicate earlier run happened to draw).

export interface LiveSipAccount {
  id: string;
  name: string;
  secret: string;
  callerid: string;
  cid_number: string;
}

/** Read-only: fetch the live Magnus `sip` row for an existing SIP account id. */
export async function readSipAccount(config: MagnusConfig, sipId: string): Promise<LiveSipAccount | null> {
  const row = await findOneByField(config, 'sip', 'id', sipId);
  if (!row) return null;
  return {
    id: String(row.id),
    name: String(row.name ?? ''),
    secret: String(row.secret ?? ''),
    callerid: String(row.callerid ?? ''),
    cid_number: String(row.cid_number ?? ''),
  };
}

/** Read-only: find an existing `did` row by its number (never draws/claims). */
export async function findDidByNumber(config: MagnusConfig, did: string): Promise<DrawnDid | null> {
  const row = await findOneByField(config, 'did', 'did', did);
  return row ? { id: String(row.id), did: String(row.did) } : null;
}

/** Read-only: find the `diddestination` row wiring a given SIP extension
 *  (optionally scoped to a specific DID id) — never creates one. */
export async function findDidDestinationForSip(
  config: MagnusConfig,
  sipId: string,
  didId?: string | null,
): Promise<{ id: string; id_did: string } | null> {
  const filter = didId
    ? [{ type: 'numeric' as const, field: 'id_did', value: didId, comparison: 'eq' }]
    : [{ type: 'numeric' as const, field: 'id_sip', value: sipId, comparison: 'eq' }];
  const rows = await readRows(config, 'diddestination', filter, 10);
  const row = rows.find((r) => String(r.id_sip) === String(sipId)) ?? null;
  return row ? { id: String(row.id), id_did: String(row.id_did) } : null;
}

/** Read-only: fetch a diddestination row's current `destination`/`context`
 *  shape, to check whether it's currently extension-first (`destination ===
 *  ''`) or forwarding elsewhere — never creates/patches. */
export async function readDidDestination(
  config: MagnusConfig,
  diddestinationId: string,
): Promise<{ id: string; destination: string; context: string; voip_call: string } | null> {
  const row = await findOneByField(config, 'diddestination', 'id', diddestinationId);
  if (!row) return null;
  return {
    id: String(row.id),
    destination: String(row.destination ?? ''),
    context: String(row.context ?? ''),
    // `voip_call` is the OTHER half of the extension-first signal — a row can
    // have `destination === ''` yet still be wrong if `voip_call !== '1'`
    // (verified live: 2592 had voip_call='0' alongside a non-empty
    // destination; the fix must check both, not destination alone).
    voip_call: String(row.voip_call ?? ''),
  };
}

/** Read-only: find an existing `callerid` row for a given cid — never creates one. */
export async function findCallerIdByCid(config: MagnusConfig, cid: string): Promise<{ id: string; cid: string } | null> {
  const row = await findOneByField(config, 'callerid', 'cid', cid);
  return row ? { id: String(row.id), cid: String(row.cid) } : null;
}

/** Read-only: fetch the live `user.prefix_local` value for a Magnus user id.
 *  Returns '' if the user has no rules set, or null if the user doesn't exist. */
export async function readUserPrefixLocal(config: MagnusConfig, magnusUserId: string): Promise<string | null> {
  const row = await findOneByField(config, 'user', 'id', magnusUserId);
  if (!row) return null;
  return String(row.prefix_local ?? '');
}

// ── naming ───────────────────────────────────────────────────────────────────

/** SIP/user naming pattern derived from tenant id, following the existing
 *  live `ep_<slug>` convention (used today for EMA_Basic business accounts —
 *  the closest existing precedent to a business PBX extension, as opposed to
 *  `lt_` which is reserved for the separate ISOLA_LITE diaspora product). */
export function genMagnusUsername(tenantId: string): string {
  return `ep_${tenantId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 16).toLowerCase()}`;
}

/** Same naming convention as genMagnusUsername, but for consumer/EMA voice
 *  lines — kept as a distinct prefix (`ema_` vs `ep_`) so a live Magnus grid
 *  listing can tell tenants and EMA consumers apart at a glance. Seeded from
 *  the VoiceLine's identity_id (Phase C: voice lines are identity-anchored
 *  for the consumer realm), not the ConsumerAccount id. */
export function genConsumerMagnusUsername(identityId: string): string {
  return `ema_${identityId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 16).toLowerCase()}`;
}

function genPassword(len = 12): string {
  return crypto.randomBytes(len).toString('base64url').slice(0, len);
}

function genCallingCardPin(): string {
  return String(Math.floor(100000 + Math.random() * 900000));
}

// ── Magnus user (verified live against the REAL create endpoint: `user/save`
//    returns the newly-created row directly in `res.rows[0]` — including its
//    `id` — so no follow-up `user/read` is needed at all. The previous
//    implementation issued a separate readback, which is not the actual bug:
//    the real bug is that `user.callingcard_pin` is a NOT NULL column with no
//    DB default. Omitting it makes `user/save` return HTTP 200 with
//    `{success:false, errors:"...doesn't have a default value..."}` — Magnus
//    never creates the row, and `magnusRequest()` doesn't throw on
//    `success:false` (only on `status:'error'`), so the old code silently
//    "succeeded" into a readback of a row that was never created. Confirmed
//    live: passing a random 6-digit `callingcard_pin` (matching the format
//    already used on every existing live user row) makes the create succeed
//    and return the row with its `id` inline.
//    id_group=3 "Client", id_plan=34 "EMA_Basic" is the plan already used by
//    every live `ep_*` account — the closest existing analog for a business
//    PBX tenant. ─────────────────────────────────────────────────────────────

export async function createMagnusUser(
  config: MagnusConfig,
  params: { username: string; password: string; description: string },
): Promise<string> {
  const res = await magnusRequest(config, 'user', 'save', {
    id: '0',
    username: params.username,
    password: params.password,
    id_group: '3',
    id_plan: '34',
    active: '1',
    credit: '0',
    description: params.description,
    callingcard_pin: genCallingCardPin(),
    // Verified live: every correctly-configured account carries these two
    // local-dialing normalization rules — set them at creation time so a
    // brand-new tenant never has the local-dialing gap in the first place.
    // (voice-provisioning.ts also reconciles this for pre-existing accounts.)
    prefix_local: DOMINICA_LOCAL_PREFIX_RULES,
  });
  // The save response IS the source of truth — use it directly. Only fall
  // back to a read-by-username if some future Magnus response ever omits it.
  let row = res?.rows?.[0] ?? null;
  if (!row?.id) {
    row = await findOneByField(config, 'user', 'username', params.username);
  }
  if (!row?.id) {
    const detail = res?.errors ? ` — Magnus said: ${JSON.stringify(res.errors)}` : '';
    throw new VoiceProvisioningError('magnus_user', `user/save did not produce a readable row afterward${detail}`);
  }
  return String(row.id);
}

// ── SIP account (verified live `sip` module shape: host='dynamic' for
//    softphone-registered dynamic extensions, as opposed to the static-IP
//    trunk peers also present in this Magnus instance) ─────────────────────

// Same shape of bug as the user create above, confirmed live: `sip/save`
// throws a PHP "Undefined index: callerid" 500 (not JSON, not a clean
// success:false) when `callerid`/`cid_number` are omitted — that column pair
// has no server-side default either. Passing them as empty strings (they get
// patched to the real DID via `patchSipCallerId` once one is drawn) makes the
// create succeed, and the response's `rows[0]` again carries the new row and
// its `id` directly — no follow-up `sip/read` needed.
export async function createSipAccount(
  config: MagnusConfig,
  params: { id_user: string; name: string; secret: string },
): Promise<string> {
  const res = await magnusRequest(config, 'sip', 'save', {
    id: '0',
    id_user: params.id_user,
    name: params.name,
    secret: params.secret,
    accountcode: params.name,
    defaultuser: params.name,
    host: 'dynamic',
    type: 'friend',
    context: 'billing',
    nat: 'force_rport,comedia',
    qualify: 'yes',
    dtmfmode: 'RFC2833',
    disallow: 'all',
    allow: 'ulaw,alaw,g729',
    status: '1',
    callerid: '',
    cid_number: '',
  });
  let row = res?.rows?.[0] ?? null;
  if (!row?.id) {
    row = await findOneByField(config, 'sip', 'name', params.name);
  }
  if (!row?.id) {
    const detail = res?.errors ? ` — Magnus said: ${JSON.stringify(res.errors)}` : '';
    throw new VoiceProvisioningError('magnus_sip', `sip/save did not produce a readable row afterward${detail}`);
  }
  const sipId = String(row.id);

  // sip/save on CREATE (id='0') does not reliably persist the `secret` we
  // send — confirmed live: the row it creates can end up with a DIFFERENT
  // secret than the one in this request, and the create response's own
  // `secret` field is not trustworthy either. The password we generated here
  // (params.secret) is the single source of truth — it's the exact value
  // that goes into ConsumerAccount/Tenant.magnus_sip_password and the
  // Acrobits CSC link — so force it onto the newly-created row with an
  // explicit UPDATE, then verify. Never trust "the save succeeded" alone.
  await enforceSipSecret(config, sipId, params.secret);

  return sipId;
}

/**
 * enforceSipSecret — force a SIP account's `secret` on Magnus to EXACTLY
 * equal `expectedSecret` (the value already stored locally / already handed
 * to the user in the Acrobits CSC link), verifying with a read-back. Local
 * DB / the CSC link is always the source of truth; Magnus is reconciled to
 * match it — never the other way around. Logs PASS/FAIL (never the secret
 * value itself). Throws VoiceProvisioningError if Magnus still doesn't match
 * after one corrective write, so a broken registration surfaces as a failed
 * provisioning run instead of silently completing.
 */
export async function enforceSipSecret(
  config: MagnusConfig,
  sipId: string,
  expectedSecret: string,
): Promise<void> {
  const before = await readSipAccount(config, sipId);
  if (before?.secret === expectedSecret) {
    console.log(`[voice-provisioning] SIP secret self-check sip_id=${sipId}: PASS (already matched)`);
    return;
  }

  await magnusRequest(config, 'sip', 'save', { id: sipId, secret: expectedSecret });

  const after = await readSipAccount(config, sipId);
  const matched = after?.secret === expectedSecret;
  console.log(`[voice-provisioning] SIP secret self-check sip_id=${sipId}: ${matched ? 'PASS' : 'FAIL'} (corrective write ${matched ? 'took effect' : 'did NOT take effect'})`);
  if (!matched) {
    throw new VoiceProvisioningError(
      'magnus_sip',
      `sip_id=${sipId} secret still does not match the value handed to the user after a corrective write — registrar auth will fail`,
    );
  }
}

/** Patch a Magnus user's local-dialing prefix rules to the canonical
 *  Dominica value. Idempotent by construction — callers should only invoke
 *  this after confirming (via `readUserPrefixLocal`) that the live value
 *  differs, so a re-run never issues a redundant write. */
export async function patchUserPrefixLocal(
  config: MagnusConfig,
  magnusUserId: string,
  prefixLocal: string = DOMINICA_LOCAL_PREFIX_RULES,
): Promise<void> {
  await magnusRequest(config, 'user', 'save', {
    id: magnusUserId,
    prefix_local: prefixLocal,
  });
}

/** Patch a SIP account's caller-ID fields once the DID is known — verified
 *  live: `sip.callerid` and `sip.cid_number` both carry the bare 11-digit DID. */
export async function patchSipCallerId(
  config: MagnusConfig,
  sipId: string,
  didNumber: string,
): Promise<void> {
  await magnusRequest(config, 'sip', 'save', {
    id: sipId,
    callerid: didNumber,
    cid_number: didNumber,
  });
}

// ── caller-ID (Magnus `callerid` module — verified live read shape) ────────

export async function createCallerId(
  config: MagnusConfig,
  params: { id_user: string; cid: string },
): Promise<string> {
  const res = await magnusRequest(config, 'callerid', 'save', {
    id: '0',
    id_user: params.id_user,
    cid: params.cid,
    activated: '1',
  });
  // Verified live: callerid/save (unlike user/save and sip/save) has no
  // missing-required-field trap — it already returns the new row with its
  // id in rows[0]. Use that directly; keep the read as a defensive fallback.
  let row = res?.rows?.[0] ?? null;
  if (!row?.id) {
    row = await findOneByField(config, 'callerid', 'cid', params.cid);
  }
  if (!row?.id) {
    const detail = res?.errors ? ` — Magnus said: ${JSON.stringify(res.errors)}` : '';
    throw new VoiceProvisioningError('magnus_callerid', `callerid/save did not produce a readable row afterward${detail}`);
  }
  return String(row.id);
}

// ── DID draw + claim (verified live against the full `did` and
//    `diddestination` tables) ───────────────────────────────────────────────

export interface DrawnDid {
  id: string;
  did: string;
}

/** Finds one available DID satisfying every DID SELECTOR LAW. Does not claim
 *  it — call `claimDid` immediately after, and re-verify freshness there to
 *  guard against a race with another concurrent provisioning run. */
export async function drawAvailableDid(config: MagnusConfig): Promise<DrawnDid> {
  const rows = await readRows(
    config,
    'did',
    [{ type: 'string', field: 'did', value: '1767818', comparison: 'cn' }],
    500,
  );

  const candidates = rows
    .filter((r) => /^1767818\d{4}$/.test(String(r.did)))
    .filter((r) => String(r.activated) === '1')
    .filter((r) => String(r.reserved) === '0')
    .filter((r) => r.id_user === null || r.id_user === undefined || r.id_user === '')
    .filter((r) => !FORBIDDEN_DIDS.has(String(r.did)))
    .sort((a, b) => Number(a.did) - Number(b.did));

  for (const c of candidates) {
    // No existing diddestination row referencing it.
    const existing = await readRows(
      config,
      'diddestination',
      [{ type: 'numeric', field: 'id_did', value: String(c.id), comparison: 'eq' }],
      1,
    );
    if (existing.length === 0) {
      return { id: String(c.id), did: String(c.did) };
    }
  }

  throw new VoiceProvisioningError('did_draw', 'No available DID matches the selector laws (pool exhausted)');
}

/** Re-verifies the DID is still free, then claims it for the tenant. */
export async function claimDid(config: MagnusConfig, didId: string, magnusUserId: string): Promise<string> {
  const fresh = await findOneByField(config, 'did', 'id', didId);
  if (!fresh) throw new VoiceProvisioningError('did_claim', `DID row ${didId} no longer exists`);
  if (fresh.id_user !== null && fresh.id_user !== undefined && fresh.id_user !== '') {
    throw new VoiceProvisioningError('did_claim', `DID ${fresh.did} was claimed by another process — retry provisioning`);
  }
  if (FORBIDDEN_DIDS.has(String(fresh.did))) {
    throw new VoiceProvisioningError('did_claim', `DID ${fresh.did} is on the forbidden list — refusing to claim`);
  }
  await magnusRequest(config, 'did', 'save', {
    id: didId,
    id_user: magnusUserId,
    reserved: '1',
  });
  return String(fresh.did);
}

/** Creates the routing row pointing a DID at a SIP extension.
 *
 *  CORRECTED convention (re-verified live 2026-07-11 against genuine
 *  long-lived production accounts — e.g. Emilla_Daway/sip 1033/diddest 8,
 *  Bureau_Of_Standards/sip 1024/diddest 48, sip 15253/diddest 51 — NOT just
 *  the two just-created test tenants): every real extension-ringing
 *  `diddestination` row has `destination = ''` (empty string) and
 *  `context = ''` (empty string), with routing resolved purely via the
 *  `id_sip` foreign key already on the row. The previously-documented
 *  `destination = "SIP/<name>"` / `context = null` shape (still what the
 *  Magnus admin UI *displays* as a hint) is NOT a value Magnus's dialplan
 *  generator recognizes for a plain softphone extension — a diddestination
 *  row saved that way silently falls through to a PSTN/trunk default
 *  instead of ringing the SIP phone. This was the exact bug behind
 *  "inbound rings PSTN instead of the SIP extension." Do not reintroduce
 *  the `SIP/<name>` shape without re-verifying against live working rows.
 *
 *  Same bug shape as `user/save` and `sip/save`: `diddestination/save` throws
 *  a PHP "Undefined index: voip_call" 500 unless `voip_call` is explicitly
 *  present — confirmed live it has no server-side default either. `'0'`
 *  matches the non-trunk/non-voip-call rows already seen live. */
export async function createDidDestinationToSip(
  config: MagnusConfig,
  params: { id_did: string; id_user: string; id_sip: string; sipUsername: string },
): Promise<string> {
  const res = await magnusRequest(config, 'diddestination', 'save', {
    id: '0',
    id_did: params.id_did,
    id_user: params.id_user,
    id_sip: params.id_sip,
    // Empty string (not '0') — the working reference row (diddestination
    // 2565, DID 17678185035, live since day one) stores these as NULL.
    // Magnus normalizes '' to NULL on save; sending '0' instead left a
    // structural difference from the reference row even after destination/
    // context matched. Re-verified 2026-07-11 by diffing 2593 against 2565
    // field-by-field after the destination/context fix alone didn't resolve
    // the reported PSTN-routing symptom.
    id_queue: '',
    id_ivr: '',
    destination: '',
    context: '',
    priority: '1',
    activated: '1',
    // MUST be '1' — verified live against the known-good reference row
    // (diddestination 2565) AND against the owner-hand-corrected 2593:
    // voip_call = '1' is what tells Magnus to resolve the ring target from
    // this row's own `id_sip` (extension-first). `voip_call = '0'` was the
    // actual bug in this file for several rounds — it silently produced the
    // WRONG (non-ringing) form even though destination/context looked right
    // (see diddestination 2592, a live example of exactly this wrong form:
    // voip_call='0', destination='SIP/...', id_ivr/id_queue='0'). Do not
    // change this back to '0' without re-diffing against a real working row.
    voip_call: '1',
  });
  let row = res?.rows?.[0] ?? null;
  if (!row?.id) {
    const rows = await readRows(
      config,
      'diddestination',
      [{ type: 'numeric', field: 'id_did', value: params.id_did, comparison: 'eq' }],
      1,
    );
    row = rows[0] ?? null;
  }
  if (!row?.id) {
    const detail = res?.errors ? ` — Magnus said: ${JSON.stringify(res.errors)}` : '';
    throw new VoiceProvisioningError('diddestination', `diddestination/save did not produce a readable row afterward${detail}`);
  }
  return String(row.id);
}

/** Flips an existing diddestination row between routing to the SIP extension
 *  (EXTENSION-FIRST default: `destination = ''`, resolved via the row's own
 *  `id_sip` — see `createDidDestinationToSip` for the live-verified evidence)
 *  and forwarding to a bare cell number (verified live convention: a bare
 *  E.164-without-plus digit string, e.g. "9715...", dials straight out;
 *  `context` stays `''` in both cases — that field never carries the
 *  sip/cell distinction on a plain extension row). */
export async function setDidDestinationRoute(
  config: MagnusConfig,
  diddestinationId: string,
  route: { mode: 'sip' } | { mode: 'cell'; cellNumber: string },
): Promise<void> {
  if (route.mode === 'sip') {
    // Extension-first form — MUST write voip_call/id_ivr/id_queue too, not
    // just destination/context. Live-verified 2026-07-12: a row can already
    // have destination === '' and still fail to ring because voip_call was
    // left at '0' (or id_ivr/id_queue at '0' instead of NULL) — writing only
    // destination/context, as this function used to, silently left those
    // fields wrong and was the actual reason earlier fixes never stuck.
    await magnusRequest(config, 'diddestination', 'save', {
      id: diddestinationId,
      destination: '',
      context: '',
      voip_call: '1',
      id_ivr: '',
      id_queue: '',
    });
    return;
  }
  const destination = route.cellNumber.replace(/^\+/, '');
  await magnusRequest(config, 'diddestination', 'save', {
    id: diddestinationId,
    destination,
    context: '',
    voip_call: '0',
  });
}
