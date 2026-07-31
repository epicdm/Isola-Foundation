import { prisma } from '../lib/prisma'
import { resolveInternalDomainBinding } from '../lib/staff-ops/internal-domain'
import { runStaffRuntimeTurn } from '../lib/staff-ops/staff-runtime-bridge'

const mask = (s?: string | null) => (s ? `***${String(s).slice(-4)}` : 'none')

async function main() {
  const phoneNumberId = process.env.STAFF_NOTIFICATION_PHONE_NUMBER_ID || ''
  const rows: any[] = await prisma.staffBinding.findMany({ where: { active: true }, take: 25 })
  console.log(`internal phone_number_id ${mask(phoneNumberId)} | active bindings ${rows.length}`)
  let probe: any = null
  for (const r of rows) {
    const b = {
      id: r.id,
      tenantId: r.tenant_id,
      odooResUserId: r.odoo_res_user_id,
      displayName: r.display_name,
      waId: r.wa_id,
      role: r.role,
      active: r.active,
      managerOdooResUserId: r.manager_odoo_res_user_id,
    }
    const res: any = resolveInternalDomainBinding({
      tenantId: r.tenant_id,
      binding: b as any,
      phoneNumberId,
    })
    if (res.ok) {
      console.log(
        `OK      ${String(r.role).padEnd(8)} ${mask(r.wa_id)} agent=${String(res.binding.clawithAgentId).slice(0, 8)} tools=${res.binding.permittedTools.length}`,
      )
      if (!probe) probe = { row: r, binding: res.binding }
    } else {
      console.log(`REFUSE  ${String(r.role).padEnd(8)} ${mask(r.wa_id)} ${res.refusal}: ${res.detail}`)
    }
  }
  if (!probe) {
    console.log('NO RESOLVABLE BINDING - cannot probe the live bridge')
    return
  }
  console.log(`\n--- live bridge turn as ${probe.row.role} ${mask(probe.row.wa_id)} ---`)
  const t0 = Date.now()
  const out: any = await runStaffRuntimeTurn({
    binding: probe.binding,
    text: 'Foundation live-acceptance probe. Reply with exactly the word ONLINE.',
    correlationId: `accept-${t0}`,
  })
  console.log(`elapsed ${Date.now() - t0}ms`)
  console.log(JSON.stringify(out).slice(0, 800))
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('SCRIPT FAILED:', e?.message ?? e)
    process.exit(1)
  })
