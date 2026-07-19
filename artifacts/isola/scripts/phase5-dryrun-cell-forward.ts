/**
 * S5 Phase 5 dry-run — bounded, reversible live write against Demo Diner
 * (DID 17678182219) through the same governed path production traffic uses:
 * lib/voice-routing-connector.ts's voiceRoutingRead/voiceRoutingSet (which in
 * turn drives lib/voice-routing.ts's plan/apply/verify/rollback pipeline).
 * No raw SQL, no bypass of the mutation-planning or verification code.
 *
 * Cycle: read before-state -> set app_then_cell (fallback 17672859610) ->
 * read/verify -> restore to app (baseline) -> read/verify restore.
 *
 * Every step prints actual field values (not just verified:true/false) so
 * the evidence is directly inspectable, per explicit request.
 */
import { PrismaClient } from '@prisma/client'
import { getMagnusConfig, getVoiceRoutingRingTimeoutSeconds } from '../lib/engines'
import { findDidByNumber } from '../lib/magnus-voice'
import { formatSipForward, isValidRingTimeoutSeconds } from '../lib/voice-routing'
import { voiceRoutingRead, voiceRoutingSet } from '../lib/voice-routing-connector'
import type { VoiceRoutingState } from '../lib/voice-routing'

const prisma = new PrismaClient()

const DEMO_DID = '17678182219'
const FALLBACK_CELL = '17672859610'

function mask(s: string | null | undefined): string {
  if (!s) return '(none)'
  return s.length <= 4 ? '*'.repeat(s.length) : s.slice(0, 3) + '*'.repeat(s.length - 6) + s.slice(-3)
}

function printState(label: string, state: VoiceRoutingState) {
  console.log(`\n--- ${label} ---`)
  console.log('mode:', state.mode)
  if (state.reason) console.log('reason:', state.reason)
  console.log('forwardToCellNumber:', mask(state.forwardToCellNumber))
  console.log('snapshot.destination:', JSON.stringify(state.snapshot.destination))
  console.log('snapshot.voipCall:', JSON.stringify(state.snapshot.voipCall))
  console.log('snapshot.dialTimeout:', JSON.stringify(state.snapshot.dialTimeout))
  console.log('snapshot.sipForward:', JSON.stringify(state.snapshot.sipForward))
  console.log('snapshot.sipId:', state.snapshot.sipId)
  console.log('snapshot.diddestinationId:', state.snapshot.diddestinationId)
}

function check(label: string, ok: boolean) {
  console.log(`${ok ? 'PASS' : 'FAIL'} — ${label}`)
  return ok
}

;(async () => {
  console.log('=== S5 Phase 5 dry-run: app_then_cell set + restore, governed path ===')

  const cfg = getMagnusConfig()
  const did = await findDidByNumber(cfg, DEMO_DID)
  if (!did) {
    console.log('BLOCKER: DID not found in Magnus.')
    process.exit(1)
  }

  const voiceLine = await prisma.voiceLine.findFirst({ where: { magnus_did_number: DEMO_DID } })
  if (!voiceLine || !voiceLine.tenant_id) {
    console.log('BLOCKER: no VoiceLine/tenant_id found for this DID — cannot form a governed tenant scope.')
    await prisma.$disconnect()
    process.exit(1)
  }
  const tenant = { tenantId: voiceLine.tenant_id }
  const params = { didId: did.id, did: did.did }

  // ── 1. Before-state ────────────────────────────────────────────────────────
  const before = await voiceRoutingRead(tenant, params)
  printState('BEFORE (captured pre-test state)', before)

  // Hard-block only on structural ambiguity that planRouteMutation itself
  // cannot safely resolve (conflicting rows, no SIP account at all) — these
  // are refused before any write regardless. A degraded read caused by a
  // stale/mismatched sip.forward (exactly today's defect) is NOT a hard
  // block: planRouteMutation computes its write purely from the raw snapshot
  // fields, not from this derived label, and confirmed-live in preflight
  // that this is precisely the state the fix is meant to correct.
  if (before.snapshot.conflictingDestinationRows || !before.snapshot.sipId) {
    console.log('\nBLOCKER: before-state has no safely-resolvable SIP wiring (conflicting rows or no SIP account) — refusing to proceed.')
    await prisma.$disconnect()
    process.exit(1)
  }
  if (before.mode === 'degraded' || before.mode === 'unknown') {
    console.log(`\nNOTE: before-state is ${before.mode} (${before.reason}) — proceeding anyway per explicit instruction; this is the live defect the fix targets, not a structural blocker.`)
  }

  // ── 2. Set app_then_cell ────────────────────────────────────────────────────
  console.log('\n=== Applying: app_then_cell, fallback', mask(FALLBACK_CELL), '===')
  const setResult = await voiceRoutingSet(tenant, { ...params, targetMode: 'app_then_cell', forwardNumber: FALLBACK_CELL })
  console.log('outcome:', setResult.outcome, ' verified:', setResult.verified, ' rollbackAttempted:', setResult.rollbackAttempted, ' rollbackVerified:', setResult.rollbackVerified)
  printState('AFTER set (app_then_cell)', setResult.after)

  let setChecksPassed = true
  if (setResult.outcome !== 'success') {
    console.log('\nRESULT: set did NOT succeed (outcome != success). Per design, the connector already attempted its own bounded rollback above — see AFTER state.')
    setChecksPassed = false
  } else {
    const expectedForward = formatSipForward(FALLBACK_CELL)
    setChecksPassed = [
      check('after.mode === app_then_cell', setResult.after.mode === 'app_then_cell'),
      check('after.forwardToCellNumber === fallback number', setResult.after.forwardToCellNumber === FALLBACK_CELL),
      check(`after.snapshot.sipForward === ${JSON.stringify(expectedForward)}`, setResult.after.snapshot.sipForward === expectedForward),
    ].every(Boolean)
  }

  // ── 3. Restore to baseline (app, no destination, forward cleared) ──────────
  console.log('\n=== Restoring: app (baseline) ===')
  const restoreResult = await voiceRoutingSet(tenant, { ...params, targetMode: 'app' })
  console.log('outcome:', restoreResult.outcome, ' verified:', restoreResult.verified, ' rollbackAttempted:', restoreResult.rollbackAttempted, ' rollbackVerified:', restoreResult.rollbackVerified)
  printState('AFTER restore (app)', restoreResult.after)

  // Minimal-mutation planning only rewrites dial_timeout when the current
  // value isn't already a valid ring duration. If before-state already had a
  // valid timeout, restore should preserve it unchanged; if before-state was
  // the invalid cell sentinel (as seen live), restore should land on the
  // configured VOICE_ROUTING_RING_TIMEOUT_SECONDS value instead.
  const ringTimeoutEnv = getVoiceRoutingRingTimeoutSeconds()
  const expectedRestoredDialTimeout =
    before.snapshot.dialTimeout !== null && isValidRingTimeoutSeconds(before.snapshot.dialTimeout)
      ? before.snapshot.dialTimeout
      : ringTimeoutEnv

  const restoreChecksPassed = [
    check('restore outcome === success', restoreResult.outcome === 'success'),
    check('restored mode === app', restoreResult.after.mode === 'app'),
    check('restored destination === ""', restoreResult.after.snapshot.destination === ''),
    check('restored sipForward === ""', restoreResult.after.snapshot.sipForward === ''),
    check(
      `restored dialTimeout is a valid ring value (${JSON.stringify(expectedRestoredDialTimeout)})`,
      restoreResult.after.snapshot.dialTimeout === expectedRestoredDialTimeout,
    ),
  ].every(Boolean)

  console.log('\n=== SUMMARY ===')
  console.log('set-to-app_then_cell checks:', setChecksPassed ? 'ALL PASS' : 'FAILED — see above')
  console.log('restore-to-app checks:', restoreChecksPassed ? 'ALL PASS' : 'FAILED — see above')
  console.log('OVERALL:', setChecksPassed && restoreChecksPassed ? 'CLEAN — line restored to baseline' : 'ATTENTION NEEDED — see FAIL lines above')

  await prisma.$disconnect()
  process.exit(setChecksPassed && restoreChecksPassed ? 0 : 1)
})().catch(async (e: any) => {
  console.error('ERR', e?.message || e)
  await prisma.$disconnect()
  process.exit(1)
})
