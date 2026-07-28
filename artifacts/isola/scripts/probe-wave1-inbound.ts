/**
 * probe-wave1-inbound.ts — READ-ONLY shadow probe for the Wave 1 inbound path.
 *
 * Runs real inbound messages through resolveInboundStaffMessage against the
 * real Odoo and prints the decision Foundation WOULD take. It applies nothing,
 * sends nothing and writes nothing: every Odoo call on this path is a
 * search_read, and applying an action is a separate explicit call the probe
 * never makes.
 *
 * This is the shadow half of the step-12 parity test. Compare its output
 * against what the live BFF processor does for the same inbound, with outbound
 * effects suppressed on both sides.
 *
 * Usage:  npx tsx scripts/probe-wave1-inbound.ts [tenant_id]
 */

import { resolveInboundStaffMessage } from '../lib/staff-ops/service'
import { prisma } from '../lib/prisma'

const TENANT_ID = process.argv[2] || 'epic-dev-pilot'

interface Case {
  label: string
  waId: string
  text: string
  expect: string
}

/** The messages that matter: the bare ACK, the prose that must not match, a stranger. */
const CASES: Case[] = [
  { label: 'bare ACK from the dual-role owner', waId: '17672958382', text: 'ACK', expect: 'staff_action or staff_disambiguation' },
  { label: 'owner business question', waId: '17672958382', text: 'What is our outstanding A/R this week?', expect: 'staff_help (non_command)' },
  { label: 'prose containing done (the near-miss)', waId: '17672958382', text: 'I think we are done with the migration, what next?', expect: 'staff_help (non_command)' },
  { label: 'BLOCKED with a note from the manager', waId: '17672351274', text: 'BLOCKED waiting on the client', expect: 'staff_action or staff_disambiguation' },
  { label: 'HELP from a staff member', waId: '17676126416', text: 'HELP', expect: 'staff_help (explicit_help)' },
  { label: 'stranger', waId: '15555550123', text: 'ACK', expect: 'exception (unknown_sender)' },
  { label: 'inactive test identity', waId: '14158408440', text: 'ACK', expect: 'exception (unknown_sender or inactive_binding)' },
]

function describeRoute(r: Awaited<ReturnType<typeof resolveInboundStaffMessage>>): string {
  const route = r.route
  switch (route.route) {
    case 'staff_action':
      return `staff_action ${route.action} -> ${route.target.odooModel}#${route.target.odooId} (${route.grammar}/${route.resolution}) note=${route.note ?? '-'}`
    case 'staff_disambiguation':
      return `staff_disambiguation ${route.action} across ${route.candidates.length} open items`
    case 'staff_help':
      return `staff_help why=${route.why} attempted=${route.attemptedAction ?? '-'}`
    case 'exception':
      return `exception why=${route.why}`
  }
}

async function main(): Promise<void> {
  console.log(`[shadow] tenant=${TENANT_ID}  READ-ONLY: no writes, no sends, no Odoo mutations\n`)
  const summary: { case: string; decision: string; openWork: number; expected: string }[] = []

  for (const c of CASES) {
    const started = Date.now()
    const resolved = await resolveInboundStaffMessage({
      waId: c.waId,
      text: c.text,
      channelTenantId: TENANT_ID,
    })
    const decision = describeRoute(resolved)
    console.log(`--- ${c.label}`)
    console.log(`    from ${c.waId}: ${JSON.stringify(c.text)}`)
    console.log(`    -> ${decision}   (openWork=${resolved.openWork.length}, ${Date.now() - started}ms)`)
    if (resolved.route.route === 'staff_disambiguation') {
      for (const cand of resolved.route.candidates.slice(0, 5)) {
        console.log(`         candidate ${cand.odooModel}#${cand.odooId} ${cand.label ?? ''}`)
      }
    }
    console.log('')
    summary.push({ case: c.label, decision, openWork: resolved.openWork.length, expected: c.expect })
  }

  console.log('[shadow] summary')
  console.table(summary)
  console.log(
    '\n[shadow] Nothing above was applied. A staff action only lands when apply_action is called explicitly.',
  )
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (err) => {
    console.error(err)
    await prisma.$disconnect()
    process.exit(1)
  })
