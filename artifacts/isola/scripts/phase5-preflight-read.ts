/**
 * S5 Phase 5 preflight — STRICTLY READ-ONLY.
 * Reads live Magnus state for Demo Diner (DID 17678182219) to capture a
 * rollback snapshot and confirm safety preconditions before any live
 * acceptance testing. Never calls a Magnus write action (save/refill).
 */
import { PrismaClient } from '@prisma/client'
import { getMagnusConfig, isMagnusConfigured, getVoiceRoutingRingTimeoutSeconds } from '../lib/engines'
import { findDidByNumber, readSipAccount } from '../lib/magnus-voice'
import { readVoiceRoutingSnapshot, deriveVoiceRoutingMode } from '../lib/voice-routing'
import { voiceRoutingRead } from '../lib/voice-routing-connector'
import { getBalance, getCalls, magnusRequest } from '../engines/magnus'

const prisma = new PrismaClient()

const DEMO_DID = '17678182219'
const FALLBACK_CELL = '17672859610'

function mask(s: string | null | undefined): string {
  if (!s) return '(none)'
  return s.length <= 4 ? '*'.repeat(s.length) : s.slice(0, 3) + '*'.repeat(s.length - 6) + s.slice(-3)
}

;(async () => {
  console.log('=== S5 Phase 5 preflight (read-only) ===')
  console.log('isMagnusConfigured:', isMagnusConfigured())
  console.log('configured ring timeout env:', getVoiceRoutingRingTimeoutSeconds() ?? '(unset)')

  const cfg = getMagnusConfig()

  const did = await findDidByNumber(cfg, DEMO_DID)
  console.log('\n--- DID lookup ---')
  console.log('DID:', DEMO_DID, '-> Magnus did.id:', did?.id ?? '(NOT FOUND)')
  if (!did) {
    console.log('BLOCKER: DID not found in Magnus — cannot proceed with Phase 5.')
    process.exit(1)
  }

  console.log('\n--- Routing snapshot ---')
  const snapshot = await readVoiceRoutingSnapshot(cfg, did.id, did.did)
  console.log(JSON.stringify(snapshot, null, 2))

  const state = deriveVoiceRoutingMode(snapshot)
  console.log('\n--- Derived state ---')
  console.log('mode:', state.mode)
  console.log('forwardToCellNumber:', mask(state.forwardToCellNumber))
  if (state.reason) console.log('reason:', state.reason)

  console.log('\n--- SIP dial_timeout validity ---')
  console.log('dialTimeout raw:', snapshot.dialTimeout)

  console.log('\n--- SIP forward (pkg_sip.forward — gates SipCallAgi.php callForward()) ---')
  console.log('sipForward raw:', snapshot.sipForward)

  console.log('\n--- Fallback cell number check ---')
  console.log('Configured fallback (from directive):', mask(FALLBACK_CELL))
  console.log('Matches live forwardToCellNumber:', state.forwardToCellNumber === FALLBACK_CELL)

  console.log('\n--- SIP account (caller-ID reconciliation, no secret) ---')
  const sip = await readSipAccount(cfg, snapshot.sipId!)
  console.log('callerid:', sip?.callerid, ' cid_number:', sip?.cid_number, ' name:', sip?.name)

  console.log('\n--- Balance + CDR baseline ---')
  // sip module read (action='read', read-only) to find the owning Magnus user id.
  const sipRowRes = await magnusRequest(cfg, 'sip', 'read', {
    page: '1', start: '0', limit: '1',
    filter: JSON.stringify([{ type: 'numeric', field: 'id', value: snapshot.sipId!, comparison: 'eq' }]),
  })
  const magnusUserId: string | null = sipRowRes?.rows?.[0]?.id_user ? String(sipRowRes.rows[0].id_user) : null
  console.log('resolved Magnus user id:', magnusUserId ?? '(not found)')
  if (magnusUserId) {
    const balance = await getBalance(cfg, magnusUserId)
    console.log('balance:', balance ? `${balance.balance} ${balance.currency}` : '(unreadable)')
    const calls = await getCalls(cfg, magnusUserId, 10)
    console.log('recent CDR count (baseline, last 10):', calls.length)
    calls.slice(0, 5).forEach((c) => console.log(`  ${c.time} ${c.dir} ${mask(c.number)} ${c.dur}`))
  }

  console.log('\n--- Foundation VoiceLine (Neon, read-only) ---')
  const voiceLine = await prisma.voiceLine.findFirst({ where: { magnus_did_number: DEMO_DID } })
  let governedReadOk = false
  let governedMode: string | null = null
  if (!voiceLine) {
    console.log('No VoiceLine row found for this DID in Neon.')
  } else {
    console.log('VoiceLine id:', voiceLine.id)
    console.log('owner_kind:', voiceLine.owner_kind)
    console.log('tenant_id:', mask(voiceLine.tenant_id))
    console.log('identity_id:', mask(voiceLine.identity_id))
    console.log('provisioning_state:', voiceLine.provisioning_state)
    console.log('magnus_did_id (Neon):', voiceLine.magnus_did_id, ' vs live Magnus did.id:', did.id, ' match:', voiceLine.magnus_did_id === did.id)
    console.log('magnus_diddestination_id (Neon):', voiceLine.magnus_diddestination_id, ' vs live:', snapshot.diddestinationId, ' match:', voiceLine.magnus_diddestination_id === snapshot.diddestinationId)
    console.log('magnus_sip_id (Neon):', voiceLine.magnus_sip_id, ' vs live:', snapshot.sipId, ' match:', voiceLine.magnus_sip_id === snapshot.sipId)

    console.log('\n--- Governed read path cross-check (voiceRoutingRead, same code GET /api/voice/routing uses) ---')
    try {
      if (!voiceLine.tenant_id) {
        throw new Error('VoiceLine has no tenant_id — not a business-tenant scope, skipping governed cross-check')
      }
      const governed = await voiceRoutingRead({ tenantId: voiceLine.tenant_id }, { didId: did.id, did: did.did })
      governedReadOk = true
      governedMode = governed.mode
      console.log('governed mode:', governed.mode, ' matches direct-snapshot mode:', governed.mode === state.mode)
    } catch (e: any) {
      console.log('governed read FAILED:', e?.message || e)
    }
  }

  console.log('\n--- Preconditions summary ---')
  const preconditions: Array<[string, boolean]> = [
    ['DID found in Magnus', !!did],
    ['Routing snapshot readable (no exception)', true],
    ['No conflicting diddestination rows', !snapshot.conflictingDestinationRows],
    ['SIP account wired (sipId present)', !!snapshot.sipId],
    ['Mode is a healthy (non-degraded/unknown) state', state.mode === 'app' || state.mode === 'app_then_cell' || state.mode === 'cell'],
    ['Foundation VoiceLine row exists for this DID', !!voiceLine],
    ['Governed read path (voiceRoutingRead) succeeds and agrees with direct read', governedReadOk && governedMode === state.mode],
  ]
  for (const [label, ok] of preconditions) {
    console.log(`${ok ? 'PASS' : 'FAIL'} — ${label}`)
  }
  const allPass = preconditions.every(([, ok]) => ok)
  console.log('\nOVERALL:', allPass ? 'SAFE TO PROCEED' : 'BLOCKED')
  await prisma.$disconnect()
})().catch(async (e: any) => {
  console.error('ERR', e?.message || e)
  await prisma.$disconnect()
  process.exit(1)
})
