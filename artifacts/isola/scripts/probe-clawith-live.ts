import { prisma } from '../lib/prisma'
import { runStaffRuntimeTurn } from '../lib/staff-ops/staff-runtime-bridge'

async function main() {
  const u = new URL(String(process.env.DATABASE_URL))
  console.log(`=== DB === host ${u.hostname} name ${u.pathname}`)
  const total = await prisma.staffBinding.count()
  const active = await prisma.staffBinding.count({ where: { active: true } })
  console.log(`staffBinding total ${total} active ${active}`)
  if (total > 0) {
    const g = await prisma.staffBinding.groupBy({
      by: ['active', 'role'],
      _count: { _all: true },
    })
    console.log(JSON.stringify(g))
  }

  // Synthetic binding: proves the WIRE CONTRACT against the live runtime
  // without depending on any real staff row. The phone is deliberately a
  // reserved test number so nothing real is touched.
  const synthetic: any = {
    tenantId: 'acceptance-probe',
    domain: 'internal',
    bindingId: 'probe',
    waId: '15550000000',
    odooResUserId: 0,
    displayName: 'Acceptance Probe',
    role: 'staff',
    managerOdooResUserId: null,
    clawithWorkspaceId: String(process.env.CLAWITH_INTERNAL_WORKSPACE_ID),
    clawithAgentId: String(process.env.CLAWITH_INTERNAL_STAFF_AGENT_ID),
    phoneNumberId: String(process.env.STAFF_NOTIFICATION_PHONE_NUMBER_ID),
    permittedTools: [],
  }
  console.log(`\n=== live bridge turn (synthetic sender, real agent) ===`)
  const t0 = Date.now()
  const out: any = await runStaffRuntimeTurn({
    binding: synthetic,
    text: 'Foundation live-acceptance probe. Reply with exactly the word ONLINE.',
    correlationId: `accept-${t0}`,
  })
  console.log(`elapsed ${Date.now() - t0}ms`)
  console.log(JSON.stringify(out).slice(0, 900))
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('SCRIPT FAILED:', e?.message ?? e)
    process.exit(1)
  })
