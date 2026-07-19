/**
 * lib/voice-routing.ts — S5 Foundation routing control layer: canonical
 * VoiceRoutingMode derivation, Magnus-truth reads, mutation planning, and
 * forward-target guards.
 *
 * Foundation Spine S5 PR 1 — schema-free (dec-foundation-s5-no-schema-first-pr-2026-07-18).
 * No routing-mode data is ever persisted in Neon; every read here derives the
 * current mode live from Magnus each time it's asked. Foundation owns
 * tenant/identity authorization, routing policy, validation, loop prevention,
 * managed-DID protection, audit, and normalized route-state reporting. Magnus
 * owns DID/SIP/forwarding execution, timeout, and call handling.
 *
 * Layering:
 *   - This file: pure derivation/validation/mutation-planning
 *     (deriveVoiceRoutingMode, planRouteMutation, validateForwardTarget) plus
 *     the impure Magnus snapshot reader/writer built on lib/magnus-voice.ts
 *     primitives.
 *   - lib/voice-routing-connector.ts: the narrow governed adapter
 *     (voiceRoutingRead/voiceRoutingSet) — tenant-scoped, audited,
 *     allow-listed to just these two ops.
 *   - lib/voice-routing-service.ts: the central orchestration service (auth,
 *     ownership resolution, guards, before/after verification, audit).
 *
 * Does NOT touch `setDidDestinationRoute` (the legacy binary sip/cell writer)
 * — that function remains in lib/magnus-voice.ts, still used as-is by
 * lib/voice-provisioning.ts's extension-first reconciliation (Step 3b), which
 * is existing production logic out of scope for this PR.
 */

import type { MagnusConfig } from '@/engines/magnus';
import { magnusRequest } from '@/engines/magnus';
import { findDidDestinationForDid, readSipAccount, patchSipDialTimeout, ConflictingDidDestinationsError } from './magnus-voice';

// ── Section 1: code-level routing model ─────────────────────────────────────

/** The three modes Foundation can WRITE. */
export type VoiceRoutingMode = 'app' | 'app_then_cell' | 'cell';

/** The full set of states a READ can report. `degraded`/`unknown` mean the
 *  live Magnus state could not be safely interpreted as one of the three
 *  supported modes — never silently mislabel one of these as a healthy mode. */
export type VoiceRoutingReadMode = VoiceRoutingMode | 'degraded' | 'unknown';

export function isVoiceRoutingMode(value: unknown): value is VoiceRoutingMode {
  return value === 'app' || value === 'app_then_cell' || value === 'cell';
}

/** Sentinel `sip.dial_timeout` value meaning "ring the SIP extension for
 *  effectively no time before falling through to the forward target" — the
 *  mechanism that keeps `cell` mode structurally SIP-first-safe (voip_call
 *  stays '1', destination stays the forward target, id_sip stays wired)
 *  instead of disabling SIP routing outright the way the legacy
 *  `voip_call='0'` convention did. */
export const CELL_ONLY_DIAL_TIMEOUT_SENTINEL = '1';

/**
 * Upper bound for a configured ring timeout — a sanity ceiling for input
 * validation, not a traced/verified "correct" ring duration. Guards against a
 * pathological deployment value (e.g. a typo'd extra zero) rather than
 * asserting any particular timeout is right for a given account. Chosen
 * generously above realistic PBX ring durations (typically well under a
 * minute) while still catching obviously-wrong configuration.
 */
export const MAX_RING_TIMEOUT_SECONDS = 300;

/** A safe ring timeout must be a positive integer greater than the `'1'`
 *  cell-only sentinel (so it can never collide with it) and no larger than
 *  MAX_RING_TIMEOUT_SECONDS. */
export function isValidRingTimeoutSeconds(value: string): boolean {
  return /^\d+$/.test(value) && Number(value) > 1 && Number(value) <= MAX_RING_TIMEOUT_SECONDS;
}

// ── snapshot shape ───────────────────────────────────────────────────────────

export interface VoiceRoutingSnapshot {
  did: string;
  didId: string;
  /** null when the DID has no diddestination row at all (never provisioned). */
  diddestinationId: string | null;
  /** diddestination.destination — '' means no forward target set. Null when no diddestination row. */
  destination: string | null;
  /** diddestination.voip_call. Null when no diddestination row. */
  voipCall: string | null;
  /** diddestination.id_sip — null means no SIP account wired to this DID's route. */
  sipId: string | null;
  /** sip.dial_timeout. Null when no SIP account is wired, or its row/field could not be read. */
  dialTimeout: string | null;
  /** Set only when Magnus has more than one `diddestination` row for this
   *  DID — an ambiguous/conflicting routing-truth shape. When present, every
   *  other field above is meaningless (all null) and
   *  deriveVoiceRoutingMode/planRouteMutation must refuse to proceed rather
   *  than inspect them. */
  conflictingDestinationRows?: number;
}

export interface VoiceRoutingState {
  mode: VoiceRoutingReadMode;
  /** Normalized (bare-digit, Magnus-convention) forward target when one is
   *  set — present for app_then_cell/cell reads (and for degraded/unknown
   *  reads that still had a destination on file). */
  forwardToCellNumber: string | null;
  /** Present only for degraded/unknown — human-readable, safe to log/return;
   *  never includes secret material. */
  reason?: string;
  snapshot: VoiceRoutingSnapshot;
}

function isPositiveTimeout(dialTimeout: string): boolean {
  return /^\d+$/.test(dialTimeout) && Number(dialTimeout) > 1;
}

/** Magnus convention: forward targets are stored as bare digit strings (no
 *  '+', dashes, or spaces). Used both for the write path and for comparisons
 *  in validateForwardTarget. */
export function normalizeForwardNumber(raw: string): string {
  return raw.replace(/[^\d]/g, '');
}

/** 11-digit DID → its 10-digit equivalent (strips a leading '1' from an
 *  11-digit string only — never truncates a shorter/longer number). */
function tenDigitEquivalent(digits: string): string {
  return /^1\d{10}$/.test(digits) ? digits.slice(1) : digits;
}

// ── Section 2: authoritative state derivation ───────────────────────────────

/**
 * Pure function — no I/O. Derives the current VoiceRoutingReadMode from a
 * Magnus-truth snapshot. Never silently labels an inconsistent state as one
 * of the three healthy modes — anything structurally unexpected comes back
 * as `degraded` (recognized-bad shape, explained) or `unknown` (couldn't even
 * read enough of Magnus to tell).
 */
export function deriveVoiceRoutingMode(snapshot: VoiceRoutingSnapshot): VoiceRoutingState {
  const { destination, voipCall, sipId, dialTimeout } = snapshot;

  // More than one diddestination row exists for this DID — routing truth is
  // ambiguous. Never guess which row is "the" route; this must never be
  // classified as one of the three healthy modes.
  if (snapshot.conflictingDestinationRows && snapshot.conflictingDestinationRows > 1) {
    return {
      mode: 'degraded',
      forwardToCellNumber: null,
      reason: `conflicting_did_destinations: ${snapshot.conflictingDestinationRows} diddestination rows exist for this DID — routing truth is ambiguous, refusing to guess`,
      snapshot,
    };
  }

  // No diddestination row at all — DID has never been routed to anything.
  if (snapshot.diddestinationId === null || destination === null || voipCall === null) {
    return {
      mode: 'degraded',
      forwardToCellNumber: null,
      reason: 'DID has no diddestination row — never provisioned, or routing was removed',
      snapshot,
    };
  }

  // No SIP account wired to this route at all — cannot be SIP-first-safe in
  // any of the three modes. Covers both a bare-PSTN shape (forward target set,
  // no SIP account) and a route with neither SIP nor a forward target.
  if (!sipId) {
    return {
      mode: 'degraded',
      forwardToCellNumber: destination.trim() ? normalizeForwardNumber(destination) : null,
      reason: destination.trim()
        ? 'diddestination has a forward target but no SIP account wired — bare-PSTN shape, not SIP-first-safe'
        : 'diddestination has no SIP account wired and no forward target — DID is not routed to anything',
      snapshot,
    };
  }

  // SIP account is wired but its record (or dial_timeout field) could not be
  // read — an incomplete Magnus response, not a structurally bad shape.
  if (dialTimeout === null) {
    return {
      mode: 'unknown',
      forwardToCellNumber: destination.trim() ? normalizeForwardNumber(destination) : null,
      reason: 'SIP account is referenced but its record (or dial_timeout field) could not be read from Magnus',
      snapshot,
    };
  }

  const hasForward = destination.trim() !== '';

  if (!hasForward) {
    if (voipCall === '1') {
      return { mode: 'app', forwardToCellNumber: null, snapshot };
    }
    return {
      mode: 'degraded',
      forwardToCellNumber: null,
      reason: `no forward target set but voip_call=${JSON.stringify(voipCall)} (expected '1' for a plain SIP-only route)`,
      snapshot,
    };
  }

  const forwardToCellNumber = normalizeForwardNumber(destination);

  if (voipCall === '0') {
    // Legacy binary hard-bypass convention (pre-S5 `setDidDestinationRoute`
    // cell writes: voip_call='0', SIP routing disabled outright) —
    // backward-compatible read as `cell`. New S5 writes never produce this
    // shape (see planRouteMutation, which always keeps voip_call='1'); this
    // branch exists solely to correctly interpret pre-existing tenant data
    // without requiring a migration or write-back.
    return { mode: 'cell', forwardToCellNumber, snapshot };
  }

  if (voipCall === '1') {
    if (dialTimeout === CELL_ONLY_DIAL_TIMEOUT_SENTINEL) {
      return { mode: 'cell', forwardToCellNumber, snapshot };
    }
    if (isPositiveTimeout(dialTimeout)) {
      return { mode: 'app_then_cell', forwardToCellNumber, snapshot };
    }
    return {
      mode: 'degraded',
      forwardToCellNumber,
      reason: `forward target present with voip_call='1' but dial_timeout=${JSON.stringify(dialTimeout)} is not a recognized value (expected the '1' sentinel or a positive ring timeout)`,
      snapshot,
    };
  }

  return {
    mode: 'degraded',
    forwardToCellNumber,
    reason: `forward target present but voip_call=${JSON.stringify(voipCall)} is neither '1' nor '0'`,
    snapshot,
  };
}

/** Impure: reads live Magnus truth for a single DID and assembles the
 *  snapshot deriveVoiceRoutingMode() consumes. Never writes. */
export async function readVoiceRoutingSnapshot(
  config: MagnusConfig,
  didId: string,
  did: string,
): Promise<VoiceRoutingSnapshot> {
  let diddest;
  try {
    diddest = await findDidDestinationForDid(config, didId);
  } catch (err) {
    if (err instanceof ConflictingDidDestinationsError) {
      return {
        did,
        didId,
        diddestinationId: null,
        destination: null,
        voipCall: null,
        sipId: null,
        dialTimeout: null,
        conflictingDestinationRows: err.rowCount,
      };
    }
    throw err;
  }
  if (!diddest) {
    return { did, didId, diddestinationId: null, destination: null, voipCall: null, sipId: null, dialTimeout: null };
  }
  if (!diddest.id_sip) {
    return {
      did,
      didId,
      diddestinationId: diddest.id,
      destination: diddest.destination,
      voipCall: diddest.voip_call,
      sipId: null,
      dialTimeout: null,
    };
  }
  const sip = await readSipAccount(config, diddest.id_sip);
  return {
    did,
    didId,
    diddestinationId: diddest.id,
    destination: diddest.destination,
    voipCall: diddest.voip_call,
    sipId: diddest.id_sip,
    dialTimeout: sip ? sip.dial_timeout : null,
  };
}

// ── Section 6: forward-target validation ────────────────────────────────────

const PROTECTED_OPERATIONAL_DIDS = new Set([
  '17678183742',
  '17678189525',
  '17678180001',
  '17678188326',
  '17678180000',
  '17678189043',
  '17678187536',
]);

export interface ForwardTargetValidationCtx {
  /** The VoiceLine's own DID (bare digits, e.g. '1767818xxxx'). */
  ownDid: string;
  /** Raw candidate forward number to validate. */
  candidate: string;
  /** Every DID currently managed by ANY Foundation VoiceLine (any
   *  tenant/consumer) — resolved by the caller via Prisma before calling, so
   *  this function stays pure/DB-free and unit-testable. Loop prevention:
   *  routing one managed VoiceLine's DID to another's is rejected. */
  managedDids: string[];
  /** Additional explicitly-protected operational numbers, layered on TOP of
   *  the built-in static list and the dynamic managedDids check — never a
   *  replacement for either. */
  extraProtectedDids?: Iterable<string>;
}

export interface ForwardTargetValidationResult {
  ok: boolean;
  /** Present only when ok=false. Deliberately generic — never discloses
   *  which specific number in the protected/managed inventory matched. */
  error?: string;
  /** Present only when ok=true — the exact bare-digit string to write. */
  normalized?: string;
}

/**
 * Pure, DB-free. Rejection must happen before any Magnus mutation is
 * attempted — callers must call this and check `.ok` before invoking
 * planRouteMutation/applyRouteMutation for app_then_cell/cell.
 */
export function validateForwardTarget(ctx: ForwardTargetValidationCtx): ForwardTargetValidationResult {
  const candidateDigits = normalizeForwardNumber(ctx.candidate);

  if (!candidateDigits) {
    return { ok: false, error: 'a forward number is required for this mode' };
  }
  // Acceptable E.164 form: 10-15 digits (10 = local without country code,
  // 11 = this deployment's DIDs / most US-format numbers, up to 15 per the
  // ITU E.164 ceiling for international numbers).
  if (!/^\d{10,15}$/.test(candidateDigits)) {
    return { ok: false, error: 'forward number is not a valid phone number' };
  }

  const ownDidDigits = normalizeForwardNumber(ctx.ownDid);
  const ownDid10 = tenDigitEquivalent(ownDidDigits);
  const candidate10 = tenDigitEquivalent(candidateDigits);

  if (candidateDigits === ownDidDigits || candidate10 === ownDid10) {
    return { ok: false, error: 'forward number cannot be the same DID that is being routed (self-forward loop)' };
  }

  const protectedSet = new Set([...PROTECTED_OPERATIONAL_DIDS, ...(ctx.extraProtectedDids ?? [])]);
  if (protectedSet.has(candidateDigits) || protectedSet.has(candidate10) || protectedSet.has(`1${candidate10}`)) {
    return { ok: false, error: 'forward number is a protected operational number' };
  }

  const managedSet = new Set(ctx.managedDids.map(normalizeForwardNumber));
  if (managedSet.has(candidateDigits) || managedSet.has(candidate10) || managedSet.has(`1${candidate10}`)) {
    return { ok: false, error: 'forward number is another Foundation-managed voice line — routing to it would create a loop' };
  }

  return { ok: true, normalized: candidateDigits };
}

// ── Section 3: safe route mutation (planning + apply) ───────────────────────

export interface RouteMutationPlan {
  targetMode: VoiceRoutingMode;
  /** null when the diddestination row already matches the desired shape —
   *  minimal-mutation principle: never write a field that's already correct. */
  diddestinationWrite: { destination: string; context: string; voip_call: string; id_ivr: string; id_queue: string } | null;
  /** null when the current dial_timeout already matches what this mode needs. */
  dialTimeoutWrite: string | null;
  forwardToCellNumber: string | null;
}

/**
 * Pure function — no I/O. Computes the minimal Magnus write needed to reach
 * `targetMode` from `snapshot`. `forwardNumber` must already be
 * validateForwardTarget()-approved and normalized by the caller for
 * app_then_cell/cell. Never repoints `id_sip` — the SIP extension backing a
 * DID's route is preserved/restored in every mode, never reassigned, and
 * `voip_call` is always written as '1' (SIP-first-safe structure in all three
 * modes — no mode may collapse to a bare-PSTN diddestination shape).
 */
export function planRouteMutation(
  targetMode: VoiceRoutingMode,
  snapshot: VoiceRoutingSnapshot,
  forwardNumber?: string,
  configuredRingTimeoutSeconds?: string | null,
): RouteMutationPlan {
  if (snapshot.conflictingDestinationRows && snapshot.conflictingDestinationRows > 1) {
    throw new Error(
      `cannot plan a route mutation: conflicting_did_destinations — ${snapshot.conflictingDestinationRows} diddestination rows exist for this DID, routing truth is ambiguous`,
    );
  }
  if (!snapshot.sipId) {
    throw new Error('cannot plan a route mutation: this DID has no SIP account wired — provisioning is incomplete');
  }

  let destination = '';
  if (targetMode !== 'app') {
    if (!forwardNumber) {
      throw new Error(`a forward number is required to set mode "${targetMode}"`);
    }
    destination = normalizeForwardNumber(forwardNumber);
  }

  const desiredDiddestination = { destination, context: '', voip_call: '1', id_ivr: '', id_queue: '' };
  const currentDestination = snapshot.destination ?? '';
  const currentVoipCall = snapshot.voipCall ?? '';
  const diddestinationChanged = currentDestination !== desiredDiddestination.destination || currentVoipCall !== '1';

  let dialTimeoutWrite: string | null = null;
  const currentDialTimeout = snapshot.dialTimeout ?? '';
  if (targetMode === 'cell') {
    if (currentDialTimeout !== CELL_ONLY_DIAL_TIMEOUT_SENTINEL) {
      dialTimeoutWrite = CELL_ONLY_DIAL_TIMEOUT_SENTINEL;
    }
  } else {
    // app / app_then_cell both need a sane ring timeout — SIP must actually
    // ring in both. Preserve whatever is already configured (minimal
    // mutation — never overwrite a legitimately-configured value). Only when
    // the current value is the cell sentinel, missing, or otherwise not a
    // usable positive timeout do we need a replacement — and there is no
    // verified universal default for that: use the deployment-configured
    // VOICE_ROUTING_RING_TIMEOUT_SECONDS value if it's valid, otherwise fail
    // closed BEFORE any Magnus mutation rather than guess one.
    if (!isPositiveTimeout(currentDialTimeout)) {
      if (configuredRingTimeoutSeconds && isValidRingTimeoutSeconds(configuredRingTimeoutSeconds)) {
        dialTimeoutWrite = configuredRingTimeoutSeconds;
      } else {
        throw new Error(
          'cannot plan a route mutation: no existing valid dial_timeout is present for this DID, and VOICE_ROUTING_RING_TIMEOUT_SECONDS is not configured (or is invalid) — refusing to guess a ring timeout before any Magnus mutation',
        );
      }
    }
  }

  return {
    targetMode,
    diddestinationWrite: diddestinationChanged ? desiredDiddestination : null,
    dialTimeoutWrite,
    forwardToCellNumber: targetMode === 'app' ? null : destination,
  };
}

type DiddestinationWrite = { destination: string; context: string; voip_call: string; id_ivr: string; id_queue: string };

async function writeDiddestinationAndTimeout(
  config: MagnusConfig,
  snapshot: VoiceRoutingSnapshot,
  diddestinationWrite: DiddestinationWrite | null,
  dialTimeoutWrite: string | null,
): Promise<void> {
  if (diddestinationWrite && snapshot.diddestinationId) {
    await magnusRequest(config, 'diddestination', 'save', {
      id: snapshot.diddestinationId,
      ...diddestinationWrite,
    });
  }
  if (dialTimeoutWrite !== null && snapshot.sipId) {
    await patchSipDialTimeout(config, snapshot.sipId, dialTimeoutWrite);
  }
}

/** Impure: executes a plan against Magnus. Issues only the writes the plan
 *  actually calls for (both can be no-ops — see planRouteMutation). */
export async function applyRouteMutation(
  config: MagnusConfig,
  snapshot: VoiceRoutingSnapshot,
  plan: RouteMutationPlan,
): Promise<void> {
  await writeDiddestinationAndTimeout(config, snapshot, plan.diddestinationWrite, plan.dialTimeoutWrite);
}

// ── Section 4: bounded compensating rollback ────────────────────────────────

export interface RouteRestorePlan {
  diddestinationWrite: DiddestinationWrite | null;
  dialTimeoutWrite: string | null;
}

/**
 * Pure function — no I/O. Builds an UNCONDITIONAL write plan that restores a
 * diddestination/sip pair to exactly the raw field values captured in
 * `capturedSnapshot` — typically the before-state read prior to a mutation
 * attempt whose outcome could not be confirmed (it threw, the after-read
 * failed, or the after-state didn't match the requested mode).
 *
 * Unlike planRouteMutation, this never diffs against a "current" reading
 * (which may itself be unreadable after a failed/ambiguous write) — it always
 * re-issues both writes so the DID's Magnus row is driven back to the
 * captured shape regardless of what state the failed mutation left it in.
 * This is a distinct, lower-level operation from planRouteMutation/
 * applyRouteMutation on purpose: those are keyed on a target VoiceRoutingMode,
 * but the snapshot being restored to may itself have been degraded/unknown
 * and have no such mode to re-derive from.
 *
 * Always forces voip_call='1' (SIP-first-safe, matching every other write
 * this file makes) — never restores a bare-PSTN voip_call='0' shape even if
 * that happened to be what the legacy before-state carried. Never repoints
 * id_sip. Never guesses a dial_timeout the captured snapshot didn't actually
 * have (e.g. an `unknown`-mode before-state whose timeout was unreadable).
 * Returns a no-op plan only when the DID had no diddestination row before the
 * mutation was attempted — rollback never fabricates one.
 */
export function planRestoreMutation(capturedSnapshot: VoiceRoutingSnapshot): RouteRestorePlan {
  if (capturedSnapshot.diddestinationId === null) {
    return { diddestinationWrite: null, dialTimeoutWrite: null };
  }

  const diddestinationWrite: DiddestinationWrite = {
    destination: capturedSnapshot.destination ?? '',
    context: '',
    voip_call: '1',
    id_ivr: '',
    id_queue: '',
  };

  const dialTimeoutWrite =
    capturedSnapshot.sipId && capturedSnapshot.dialTimeout !== null ? capturedSnapshot.dialTimeout : null;

  return { diddestinationWrite, dialTimeoutWrite };
}

/** Impure: executes a restore plan against Magnus, targeting the row
 *  identified by `capturedSnapshot`'s own ids (the row being restored is
 *  identified by primary key — it doesn't move even though its field values
 *  do). Issues only the writes the plan actually calls for. */
export async function applyRestoreMutation(
  config: MagnusConfig,
  capturedSnapshot: VoiceRoutingSnapshot,
  plan: RouteRestorePlan,
): Promise<void> {
  await writeDiddestinationAndTimeout(config, capturedSnapshot, plan.diddestinationWrite, plan.dialTimeoutWrite);
}
