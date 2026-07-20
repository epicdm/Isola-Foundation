/**
 * lib/voice-health.ts — operator-facing per-VoiceLine health computation.
 *
 * Task 2 of the Voice Resource Health Check. Reuses the existing
 * degraded-routing classifier (deriveVoiceRoutingMode/readVoiceRoutingSnapshot
 * in ./voice-routing) rather than reimplementing it, and mirrors the
 * DB<->Magnus resolution checks from scripts/voice-health-audit.ts (Task 1)
 * scoped to a single VoiceLine. Read-only — never issues a Magnus save/refill
 * action and never writes to Neon.
 *
 * classifyVoiceLineHealth is a pure function (no I/O) so it can be unit
 * tested directly; computeVoiceLineHealth is the impure orchestrator that
 * fetches live Magnus state and feeds it in.
 */
import { magnusRequest, type MagnusConfig } from '@/engines/magnus';
import { readSipAccount, readDidDestination } from './magnus-voice';
import { readVoiceRoutingSnapshot, deriveVoiceRoutingMode } from './voice-routing';

export type HealthStatus = 'OK' | 'DEGRADED' | 'MISMATCH' | 'MISSING' | 'LEGACY_DUP' | 'RETIRED';
export type HealthColor = 'green' | 'amber' | 'red' | 'gray';

const STATUS_COLOR: Record<HealthStatus, HealthColor> = {
  OK: 'green',
  DEGRADED: 'amber',
  MISMATCH: 'red',
  MISSING: 'red',
  LEGACY_DUP: 'amber',
  RETIRED: 'gray',
};

// Precedence for escalating status when multiple issues are found on one line
// — most severe wins. Mirrors scripts/voice-health-audit.ts's addIssue().
// RETIRED is never reached through escalate() (classifyVoiceLineHealth
// short-circuits to it before any addIssue call) — it's listed last only for
// type completeness.
const PRECEDENCE: HealthStatus[] = ['MISMATCH', 'MISSING', 'DEGRADED', 'LEGACY_DUP', 'OK', 'RETIRED'];

export interface VoiceLineRecord {
  id: string;
  ownerName: string;
  ownerKind: 'business' | 'consumer';
  did: string | null;
  magnusUserId: string | null;
  magnusSipId: string | null;
  magnusCallerIdId: string | null;
  magnusDidId: string | null;
  magnusDidDestinationId: string | null;
  provisioningState: string;
}

/** Result of resolving a VoiceLine's stored magnus_*_id fields against live
 *  Magnus rows. `null` means "not applicable" (the VoiceLine had no id stored
 *  for that field) — distinct from `found: false`, which means an id WAS
 *  stored but no live row resolves it (the class of bug that hit DID
 *  17678182220's line during the Task 1 audit). */
export interface MagnusResolution {
  sip: { found: boolean; cidNumber: string | null } | null;
  did: { found: boolean; did: string | null } | null;
  callerId: { found: boolean; cid: string | null } | null;
  didDestination: { found: boolean; idSip: string | null } | null;
  routing: { mode: string; reason?: string } | { error: string } | null;
}

export interface VoiceLineHealth {
  status: HealthStatus;
  color: HealthColor;
  mode: string;
  issues: string[];
}

function escalate(current: HealthStatus, next: HealthStatus): HealthStatus {
  return PRECEDENCE.indexOf(next) < PRECEDENCE.indexOf(current) ? next : current;
}

/**
 * Pure classification — given a VoiceLine's stored fields and a resolution of
 * those fields against live Magnus state, derive a single health verdict.
 * No network/DB access here; safe to unit test directly.
 *
 * `legacyDuplicateAccountIds` — ids of legacy ConsumerAccount rows that share
 * this line's magnus_sip_id/magnus_did_number (a pre-VoiceLine-model
 * duplicate of the same underlying Magnus resource; see Task A's retirement
 * of +17672859610 for the canonical example).
 */
export function classifyVoiceLineHealth(
  line: VoiceLineRecord,
  resolution: MagnusResolution,
  legacyDuplicateAccountIds: string[] = [],
): VoiceLineHealth {
  // Terminal state — a soft-retired line intentionally has no live Magnus
  // resources anymore. Short-circuit before any other check so it never
  // shows up as a false OK/green (it isn't healthy) or a false MISSING/red
  // (its missing resources are expected, not a bug) — it just drops off the
  // problem list entirely.
  if (line.provisioningState === 'retired') {
    return { status: 'RETIRED', color: STATUS_COLOR.RETIRED, mode: 'retired', issues: [] };
  }

  let status: HealthStatus = 'OK';
  const issues: string[] = [];

  function addIssue(next: HealthStatus, issue: string) {
    issues.push(issue);
    status = escalate(status, next);
  }

  // ASSIGNMENT — a completed line is expected to have every resource id a
  // working line needs. A null id here means it was never stored in the
  // first place, distinct from a stored-but-unresolvable id (handled by the
  // DB<->MAGNUS resolution checks below). Missing this generalization was
  // the false-green class of bug: a completed line missing e.g.
  // magnus_sip_id read as OK because resolution.sip was simply `null`
  // ("not applicable") rather than "found: false".
  if (line.provisioningState === 'completed') {
    if (!line.did) addIssue('MISSING', 'provisioning_state=completed but no DID number is stored');
    if (!line.magnusSipId) addIssue('MISSING', 'provisioning_state=completed but magnus_sip_id is not stored');
    if (!line.magnusCallerIdId) addIssue('MISSING', 'provisioning_state=completed but magnus_callerid_id is not stored');
    if (!line.magnusDidDestinationId) addIssue('MISSING', 'provisioning_state=completed but magnus_diddestination_id is not stored');
    if (!line.magnusDidId) addIssue('MISSING', 'provisioning_state=completed but magnus_did_id is not stored — cannot evaluate live routing');
  }

  // DB<->MAGNUS resolution — each stored magnus_*_id must resolve to a live row.
  if (resolution.sip) {
    if (!resolution.sip.found) {
      addIssue('MISSING', `magnus_sip_id=${line.magnusSipId} does not resolve to a live sip row`);
    } else if (line.did && resolution.sip.cidNumber && resolution.sip.cidNumber !== line.did) {
      addIssue('MISMATCH', `sip.cid_number=${resolution.sip.cidNumber} does not match stored DID ${line.did}`);
    }
  }
  if (resolution.did) {
    if (!resolution.did.found) {
      addIssue('MISSING', `magnus_did_id=${line.magnusDidId} does not resolve to a live did row`);
    } else if (line.did && resolution.did.did && resolution.did.did !== line.did) {
      addIssue('MISMATCH', `did.did=${resolution.did.did} does not match stored DID ${line.did}`);
    }
  }
  if (resolution.callerId) {
    if (!resolution.callerId.found) {
      addIssue('MISSING', `magnus_callerid_id=${line.magnusCallerIdId} does not resolve to a live callerid row`);
    } else if (line.did && resolution.callerId.cid && resolution.callerId.cid !== line.did) {
      addIssue('MISMATCH', `callerid.cid=${resolution.callerId.cid} does not match stored DID ${line.did}`);
    }
  }
  if (resolution.didDestination) {
    if (!resolution.didDestination.found) {
      addIssue('MISSING', `magnus_diddestination_id=${line.magnusDidDestinationId} does not resolve to a live diddestination row`);
    } else if (line.magnusSipId && resolution.didDestination.idSip && resolution.didDestination.idSip !== line.magnusSipId) {
      addIssue('MISMATCH', `diddestination.id_sip=${resolution.didDestination.idSip} does not match stored magnus_sip_id=${line.magnusSipId}`);
    }
  }

  // ROUTING HEALTH — reuse of the existing degraded-detection classifier's verdict.
  let mode = '-';
  if (resolution.routing) {
    if ('error' in resolution.routing) {
      mode = 'error';
      addIssue('DEGRADED', `routing snapshot read failed — ${resolution.routing.error}`);
    } else {
      mode = resolution.routing.mode;
      if (resolution.routing.mode === 'degraded' || resolution.routing.mode === 'unknown') {
        addIssue('DEGRADED', `routing mode=${resolution.routing.mode}${resolution.routing.reason ? ` — ${resolution.routing.reason}` : ''}`);
      }
    }
  }

  // LEGACY_DUP — this line's Magnus resource is also referenced by an
  // older, pre-VoiceLine-model ConsumerAccount row (see Task A's retirement
  // of +17672859610 for the canonical example of this dup class).
  for (const consumerAccountId of legacyDuplicateAccountIds) {
    addIssue('LEGACY_DUP', `legacy ConsumerAccount duplicate (${consumerAccountId})`);
  }

  return { status, color: STATUS_COLOR[status], mode, issues };
}

async function findOneById(config: MagnusConfig, module: string, id: string): Promise<Record<string, any> | null> {
  const res = await magnusRequest(config, module, 'read', {
    page: '1',
    start: '0',
    limit: '1',
    filter: JSON.stringify([{ type: 'numeric', field: 'id', value: id, comparison: 'eq' }]),
  });
  return res?.rows?.[0] ?? null;
}

/** Impure: fetches live Magnus state for one VoiceLine's stored ids and
 *  builds the MagnusResolution classifyVoiceLineHealth needs. Read-only. */
export async function resolveVoiceLineAgainstMagnus(config: MagnusConfig, line: VoiceLineRecord): Promise<MagnusResolution> {
  const [sip, did, callerId, didDestination] = await Promise.all([
    line.magnusSipId
      ? readSipAccount(config, line.magnusSipId).then((row) => ({ found: !!row, cidNumber: row?.cid_number ?? null }))
      : Promise.resolve(null),
    line.magnusDidId
      ? findOneById(config, 'did', line.magnusDidId).then((row) => ({ found: !!row, did: row ? String(row.did) : null }))
      : Promise.resolve(null),
    line.magnusCallerIdId
      ? findOneById(config, 'callerid', line.magnusCallerIdId).then((row) => ({ found: !!row, cid: row ? String(row.cid) : null }))
      : Promise.resolve(null),
    line.magnusDidDestinationId
      ? readDidDestination(config, line.magnusDidDestinationId).then((row) => ({ found: !!row, idSip: row?.id_sip ?? null }))
      : Promise.resolve(null),
  ]);

  let routing: MagnusResolution['routing'] = null;
  if (line.magnusDidId && line.did) {
    try {
      const snapshot = await readVoiceRoutingSnapshot(config, line.magnusDidId, line.did);
      const state = deriveVoiceRoutingMode(snapshot);
      routing = { mode: state.mode, reason: state.reason };
    } catch (e: any) {
      routing = { error: e?.message ?? String(e) };
    }
  }

  return { sip, did, callerId, didDestination, routing };
}

/** Impure: full compute for one VoiceLine — fetch + classify. Retired lines
 *  skip the live Magnus round-trip entirely (classifyVoiceLineHealth would
 *  discard the resolution anyway, and their sub-resource ids are gone). */
export async function computeVoiceLineHealth(
  config: MagnusConfig,
  line: VoiceLineRecord,
  legacyDuplicateAccountIds: string[] = [],
): Promise<VoiceLineHealth> {
  if (line.provisioningState === 'retired') {
    return classifyVoiceLineHealth(line, { sip: null, did: null, callerId: null, didDestination: null, routing: null });
  }
  const resolution = await resolveVoiceLineAgainstMagnus(config, line);
  return classifyVoiceLineHealth(line, resolution, legacyDuplicateAccountIds);
}

export interface VoiceHealthSummary {
  total: number;
  green: number;
  amber: number;
  red: number;
  gray: number;
}

export function summarize(results: VoiceLineHealth[]): VoiceHealthSummary {
  const summary: VoiceHealthSummary = { total: results.length, green: 0, amber: 0, red: 0, gray: 0 };
  for (const r of results) summary[r.color]++;
  return summary;
}
