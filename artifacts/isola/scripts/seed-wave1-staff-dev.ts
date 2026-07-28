/**
 * seed-wave1-staff-dev.ts — DEV-ONLY seed for the Wave 1 internal staff pilot.
 *
 * Creates the minimum Foundation state the Wave 1 proof cycle needs:
 *   1. an EPIC pilot Tenant
 *   2. an OdooBinding pointing at the real EPIC Odoo (credential from env,
 *      stored encrypted via the existing tenant-secrets envelope)
 *   3. five StaffBindings for the pilot cohort
 *
 * SAFETY: refuses to run unless DATABASE_URL names the helium dev database.
 * Set ALLOW_NON_DEV_SEED=1 to override, deliberately and knowingly.
 *
 * IDEMPOTENT: every write is an upsert keyed on a natural unique constraint, so
 * re-running converges rather than duplicating.
 *
 * WHY res.users AND hr.employee ARE SEPARATE HERE: `project.task.user_ids`
 * holds res.users ids. The legacy column `odooUserOrEmployeeId` was ambiguous
 * enough that three live rows were seeded with hr.employee ids into a field
 * consumed as a res.users id — one person's acknowledgement would have read
 * back against another person's user. `odoo_res_user_id` is the join key;
 * `odoo_employee_id` is for roster reads only and is never an assignment key.
 *
 * NOTHING IS INVENTED: every wa_id below comes from an existing
 * epic_staff_channels row on the migration source, and every res.users id was
 * verified live against Odoo (open task counts: Eric 289, Phillip 109,
 * Kimberly 13, Joann 77, Desmond 40).
 */

import { prisma } from '../lib/prisma'
import { encryptSecret } from '../lib/tenant-secrets'

const TENANT_ID = 'epic-dev-pilot'
const TENANT_NAME = 'EPIC Communications (Wave 1 dev pilot)'

const ODOO_URL = process.env.ODOO_URL || 'https://epic-communications-inc.odoo.com'
const ODOO_DB = process.env.ODOO_DB || 'epic-communications-inc'

interface SeedStaff {
  odooResUserId: number
  odooEmployeeId: number | null
  displayName: string
  workEmail: string
  waId: string
  role: 'owner' | 'manager' | 'staff'
  managerOdooResUserId: number | null
}

/** res.users ids verified live against Odoo; wa_ids taken from the migration source. */
const COHORT: SeedStaff[] = [
  {
    odooResUserId: 2,
    odooEmployeeId: 1,
    displayName: 'Eric Giraud',
    workEmail: 'eric.giraud@epic.dm',
    waId: '17672958382',
    role: 'owner',
    managerOdooResUserId: null,
  },
  {
    odooResUserId: 5,
    odooEmployeeId: null,
    displayName: 'Phillip Alleyne',
    workEmail: 'phillip@epic.dm',
    waId: '17672351274',
    role: 'manager',
    managerOdooResUserId: 2,
  },
  {
    odooResUserId: 6,
    odooEmployeeId: null,
    displayName: 'Kimberly Alleyne',
    workEmail: 'kim@epic.dm',
    waId: '17676126416',
    role: 'staff',
    managerOdooResUserId: 2,
  },
  {
    odooResUserId: 9,
    odooEmployeeId: null,
    displayName: 'Joann Polydore',
    workEmail: 'joann.polydore@epic.dm',
    waId: '17672850380',
    role: 'staff',
    managerOdooResUserId: 2,
  },
  {
    odooResUserId: 10,
    odooEmployeeId: null,
    displayName: 'Desmond Trotter',
    workEmail: 'desmond@epic.dm',
    waId: '17673164982',
    role: 'staff',
    managerOdooResUserId: 2,
  },
]

function assertDevDatabase(): void {
  const url = process.env.DATABASE_URL ?? ''
  const isDev = url.includes('helium')
  if (isDev) return
  if (process.env.ALLOW_NON_DEV_SEED === '1') {
    console.warn('[seed] DATABASE_URL is not the helium dev database, but ALLOW_NON_DEV_SEED=1 is set — continuing.')
    return
  }
  throw new Error(
    '[seed] REFUSING TO RUN: DATABASE_URL does not name the helium dev database. ' +
      'This script seeds pilot data and must not touch production. ' +
      'Set ALLOW_NON_DEV_SEED=1 only if you mean it.',
  )
}

async function main(): Promise<void> {
  assertDevDatabase()

  // 1. Tenant
  const tenant = await prisma.tenant.upsert({
    where: { id: TENANT_ID },
    update: { business_name: TENANT_NAME, tenant_kind: 'test', status: 'active' },
    create: {
      id: TENANT_ID,
      business_name: TENANT_NAME,
      tenant_kind: 'test',
      status: 'active',
      plan: 'pro',
      odoo_url: ODOO_URL,
      odoo_db: ODOO_DB,
      odoo_instance_type: 'hosted_saas',
    },
  })
  console.log(`[seed] tenant ${tenant.id} (${tenant.business_name})`)

  // 2. OdooBinding — the governed per-tenant credential the connector resolves.
  const apiKey = process.env.ODOO_API_KEY
  if (!apiKey) {
    console.warn('[seed] ODOO_API_KEY is not set — skipping OdooBinding. The Odoo connector will have no credential.')
  } else {
    await prisma.odooBinding.upsert({
      where: { tenant_id: TENANT_ID },
      update: { url: ODOO_URL, db: ODOO_DB, api_key_enc: encryptSecret(apiKey), instance_type: 'hosted_saas' },
      create: {
        tenant_id: TENANT_ID,
        url: ODOO_URL,
        db: ODOO_DB,
        api_key_enc: encryptSecret(apiKey),
        instance_type: 'hosted_saas',
      },
    })
    console.log(`[seed] odoo binding -> ${ODOO_URL} db=${ODOO_DB} (key encrypted, never logged)`)
  }

  // 3. StaffBindings
  for (const s of COHORT) {
    const row = await prisma.staffBinding.upsert({
      where: { tenant_id_odoo_res_user_id: { tenant_id: TENANT_ID, odoo_res_user_id: s.odooResUserId } },
      update: {
        display_name: s.displayName,
        work_email: s.workEmail,
        wa_id: s.waId,
        role: s.role,
        active: true,
        odoo_employee_id: s.odooEmployeeId,
        manager_odoo_res_user_id: s.managerOdooResUserId,
      },
      create: {
        tenant_id: TENANT_ID,
        odoo_res_user_id: s.odooResUserId,
        odoo_employee_id: s.odooEmployeeId,
        display_name: s.displayName,
        work_email: s.workEmail,
        wa_id: s.waId,
        role: s.role,
        active: true,
        manager_odoo_res_user_id: s.managerOdooResUserId,
        // verified_at deliberately left NULL: no one has acknowledged onboarding
        // on their own channel yet. An unverified binding may be read but must
        // not be treated as a proven delivery target.
      },
    })
    console.log(
      `[seed] staff ${row.display_name} res.users=${row.odoo_res_user_id} wa=${row.wa_id} role=${row.role} verified=${row.verified_at ? 'yes' : 'NO'}`,
    )
  }

  // 4. Readback
  const all = await prisma.staffBinding.findMany({
    where: { tenant_id: TENANT_ID },
    orderBy: { odoo_res_user_id: 'asc' },
    select: { display_name: true, odoo_res_user_id: true, wa_id: true, role: true, active: true, verified_at: true },
  })
  console.log(`[seed] readback: ${all.length} staff bindings on ${TENANT_ID}`)
  console.table(all)
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (err) => {
    console.error(err)
    await prisma.$disconnect()
    process.exit(1)
  })
