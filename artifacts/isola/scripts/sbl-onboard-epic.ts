// scripts/sbl-onboard-epic.ts - SBL cell-forward step for EPIC tenant, reuse-first:
// sets voice_forward_to_cell + voice_cell_number via Prisma (the only two
// owner-routing columns that actually exist on Tenant), then re-runs the
// proven provisionTenantVoice() so its own Step 3b reconciliation logic
// issues the setDidDestinationRoute cell-mode write (never called directly).
import { prisma } from '../lib/prisma'
import { provisionTenantVoice } from '../lib/voice-provisioning'
import { getMagnusConfig } from '../lib/engines'
import { readDidDestination } from '../lib/magnus-voice'
import { getBalance, addCredit } from '../engines/magnus'

const tenantId = process.argv[2]
const cell = process.argv[3]
if (!tenantId || !cell) { console.error('need tenantId cellNumber'); process.exit(2) }

;(async () => {
  const before = await prisma.tenant.findUnique({ where: { id: tenantId } })
  console.log('BEFORE ' + JSON.stringify({ voice_forward_to_cell: before?.voice_forward_to_cell, voice_cell_number: before?.voice_cell_number, magnus_diddestination_id: before?.magnus_diddestination_id, magnus_user_id: before?.magnus_user_id }))

  await prisma.tenant.update({
    where: { id: tenantId },
    data: { voice_forward_to_cell: true, voice_cell_number: cell },
  })

  const result = await provisionTenantVoice(tenantId)
  console.log('PROVISION_RESULT ' + JSON.stringify(result))

  const cfg = getMagnusConfig()
  if (result.magnus_diddestination_id) {
    const route = await readDidDestination(cfg, result.magnus_diddestination_id)
    console.log('ROUTE ' + JSON.stringify(route))
  }

  if (result.magnus_user_id) {
    const bal = await getBalance(cfg, result.magnus_user_id)
    console.log('BALANCE_BEFORE_CREDIT ' + JSON.stringify(bal))
    if (!bal || (bal.balance ?? 0) < 5) {
      const credited = await addCredit(cfg, result.magnus_user_id, 20, 'SBL onboarding EPIC tenant forward-leg credit')
      console.log('CREDIT_RESULT ' + JSON.stringify(credited))
      const balAfter = await getBalance(cfg, result.magnus_user_id)
      console.log('BALANCE_AFTER_CREDIT ' + JSON.stringify(balAfter))
    } else {
      console.log('CREDIT_SKIPPED balance already >= 5')
    }
  }

  process.exit(0)
})().catch(e => { console.error('ERR ' + (e?.message || e)); process.exit(1) })
