/**
 * Create the two controlled manager-pilot tasks in project 46, then read them
 * back from Odoo as the authority on what was actually stored.
 *
 * Guarded three ways:
 *   1. a collision read (archived rows included) before any create;
 *   2. a per-pilot stable operation reference embedded in the task description,
 *      so a second run recognises its own prior work instead of duplicating it;
 *   3. an unconditional readback - a create that reports an id but stored
 *      something else is not a success.
 *
 * Task 2588 is never referenced, read for mutation, or written.
 *
 *   DATABASE_URL="$NEON_PROD_URL" npx tsx scripts/create-manager-pilot-tasks.ts
 *
 * The production DATABASE_URL is required because the OdooBinding naming the
 * authoritative instance lives in the production database; dev heliumdb has no
 * staff-ops rows at all.
 */
import { resolveOdooConfigForTenant } from '../lib/engine-bindings'
import { json2Call } from '../engines/odoo'
import { prisma } from '../lib/prisma'
import type { OdooConfig } from '../engines/odoo'

const TENANT = '43b006e4-33e0-42a8-bec7-4422ba290d79'
const PROJECT = 46
const STAGE_NEW = 87
const HAKEEM_ODOO_USER = 8
const EXPECTED_MANAGER_ODOO_USER = 5
const PILOT_TAG = 'ISOLA-PILOT'

interface Pilot {
  ref: string
  verdict: string
  operationId: string
  name: string
}

const PILOTS: Pilot[] = [
  {
    ref: 'ISOLA-PILOT-MGR-APPROVE-20260730',
    verdict: 'Approve',
    operationId: 'op-pilot-mgr-approve-20260730',
    name: 'ISOLA-PILOT-MGR-APPROVE-20260730 - CONTROLLED INTERNAL TEST - manager verification approve path',
  },
  {
    ref: 'ISOLA-PILOT-MGR-RETURN-20260730',
    verdict: 'Return',
    operationId: 'op-pilot-mgr-return-20260730',
    name: 'ISOLA-PILOT-MGR-RETURN-20260730 - CONTROLLED INTERNAL TEST - manager verification return path',
  },
]

function describe(p: Pilot): string {
  return [
    '<p><b>CONTROLLED INTERNAL TEST - NOT CUSTOMER WORK, NOT COMMERCIAL WORK.</b></p>',
    `<p>Pilot reference: <code>${p.ref}</code><br/>`,
    `Foundation operation reference: <code>${p.operationId}</code><br/>`,
    `Expected manager verdict: <b>${p.verdict}</b></p>`,
    '<p>Purpose: first live exercise of the corrected manager-verification activity path ',
    '(res_model_id + res_id written as resolved ids) in production. The assigned staff ',
    'member taps Acknowledge, then Start work, then Mark as done on WhatsApp; the ',
    'verification activity is then resolved by the manager.</p>',
    '<p>No customer dependency. No commercial dependency. Safe to archive once the ',
    'manager-verification evidence has been captured.</p>',
  ].join('')
}

type Row = Record<string, unknown>

async function searchTasks(cfg: OdooConfig, domain: unknown[], withArchived: boolean): Promise<Row[]> {
  const params: Record<string, unknown> = {
    domain,
    fields: ['id', 'name', 'project_id', 'stage_id', 'user_ids', 'active', 'description', 'create_date'],
    limit: 50,
  }
  if (withArchived) params.context = { active_test: false }
  return (await json2Call(cfg, 'project.task', 'search_read', params, 20000)) as Row[]
}

function mask(v: string | null | undefined): string {
  if (!v) return String(v)
  return v.length <= 4 ? '*'.repeat(v.length) : '*'.repeat(v.length - 4) + v.slice(-4)
}

;(async () => {
  const cfg = await resolveOdooConfigForTenant(TENANT)

  // ---- 1. The verifier resolves from the StaffBinding, never from a task field.
  const hakeem = await prisma.staffBinding.findFirst({
    where: { tenant_id: TENANT, odoo_res_user_id: HAKEEM_ODOO_USER },
    select: {
      id: true, tenant_id: true, display_name: true, odoo_res_user_id: true,
      manager_odoo_res_user_id: true, wa_id: true, role: true, active: true,
      identity_id: true,
    },
  })
  console.log('STAFFBINDING_HAKEEM ' + JSON.stringify(
    hakeem ? { ...hakeem, wa_id: mask(hakeem.wa_id) } : null,
  ))
  if (!hakeem) throw new Error('no StaffBinding for Hakeem (odoo_res_user_id 8) - cannot resolve a verifier')
  if (hakeem.manager_odoo_res_user_id !== EXPECTED_MANAGER_ODOO_USER) {
    throw new Error(
      `StaffBinding manager_odoo_res_user_id is ${hakeem.manager_odoo_res_user_id}, expected ${EXPECTED_MANAGER_ODOO_USER}`,
    )
  }

  const manager = await prisma.staffBinding.findFirst({
    where: { tenant_id: TENANT, odoo_res_user_id: EXPECTED_MANAGER_ODOO_USER },
    select: {
      id: true, display_name: true, odoo_res_user_id: true, wa_id: true,
      role: true, active: true, manager_odoo_res_user_id: true,
    },
  })
  console.log('STAFFBINDING_MANAGER ' + JSON.stringify(
    manager ? { ...manager, wa_id: mask(manager.wa_id) } : null,
  ))

  const odooUsers = await json2Call(cfg, 'res.users', 'search_read', {
    domain: [['id', 'in', [HAKEEM_ODOO_USER, EXPECTED_MANAGER_ODOO_USER]]],
    fields: ['id', 'login', 'name', 'active', 'share'],
    limit: 5,
  }, 20000)
  console.log('ODOO_USERS ' + JSON.stringify(odooUsers))

  // ---- 2. Collision read, archived rows included.
  let existing: Row[]
  try {
    existing = await searchTasks(cfg, [['project_id', '=', PROJECT], ['name', 'ilike', PILOT_TAG]], true)
    console.log('COLLISION_SCAN_MODE with_archived')
  } catch (e: any) {
    console.log('COLLISION_SCAN_CONTEXT_UNSUPPORTED ' + (e?.message ?? e))
    existing = await searchTasks(cfg, [['project_id', '=', PROJECT], ['name', 'ilike', PILOT_TAG]], false)
    console.log('COLLISION_SCAN_MODE active_only')
  }
  console.log('EXISTING_PILOT_TASKS ' + JSON.stringify(existing.map((r) => ({
    id: r.id, name: r.name, stage_id: r.stage_id, active: r.active,
  }))))

  // ---- 3. Create only what is missing.
  const results: Record<string, unknown>[] = []
  for (const p of PILOTS) {
    const already = existing.find((r) => typeof r.name === 'string' && (r.name as string).startsWith(p.ref))
    let taskId: number

    if (already) {
      taskId = already.id as number
      console.log(`REUSE ${p.ref} existing task ${taskId} - no create issued`)
    } else {
      const vals = {
        name: p.name,
        project_id: PROJECT,
        stage_id: STAGE_NEW,
        user_ids: [[6, 0, [HAKEEM_ODOO_USER]]],
        description: describe(p),
      }
      console.log(`INTENDED ${p.ref} ` + JSON.stringify({ ...vals, description: '<omitted>' }))
      const created = (await json2Call(cfg, 'project.task', 'create', { vals_list: [vals] }, 25000)) as number[] | number
      const id = Array.isArray(created) ? created[0] : created
      if (typeof id !== 'number' || !Number.isInteger(id) || id <= 0) {
        throw new Error(`create returned no usable id for ${p.ref}: ${JSON.stringify(created)}`)
      }
      taskId = id
      console.log(`CREATED ${p.ref} id=${taskId} operation=${p.operationId}`)
    }

    // ---- 4. Authoritative readback.
    const back = await searchTasks(cfg, [['id', '=', taskId]], true)
    const row = back[0]
    if (!row) throw new Error(`readback returned nothing for ${p.ref} id ${taskId}`)

    const projectId = Array.isArray(row.project_id) ? (row.project_id as any[])[0] : row.project_id
    const stageId = Array.isArray(row.stage_id) ? (row.stage_id as any[])[0] : row.stage_id
    const userIds = (row.user_ids as number[]) ?? []

    const checks = {
      id_is_int: Number.isInteger(row.id),
      name_carries_ref: typeof row.name === 'string' && (row.name as string).startsWith(p.ref),
      project_is_46: projectId === PROJECT,
      stage_is_87_new: stageId === STAGE_NEW,
      hakeem_assigned: userIds.length === 1 && userIds[0] === HAKEEM_ODOO_USER,
      active_true: row.active === true,
      operation_ref_present:
        typeof row.description === 'string' && (row.description as string).includes(p.operationId),
      verifier_resolves_from_staffbinding: hakeem.manager_odoo_res_user_id === EXPECTED_MANAGER_ODOO_USER,
    }
    console.log(`READBACK ${p.ref} ` + JSON.stringify({
      id: row.id, name: row.name, project_id: row.project_id, stage_id: row.stage_id,
      user_ids: row.user_ids, active: row.active, create_date: row.create_date,
    }))
    console.log(`CHECKS ${p.ref} ` + JSON.stringify(checks))
    const failed = Object.entries(checks).filter(([, v]) => v !== true).map(([k]) => k)
    if (failed.length) throw new Error(`readback checks FAILED for ${p.ref}: ${failed.join(', ')}`)

    results.push({ ref: p.ref, taskId, verdict: p.verdict, operationId: p.operationId })
  }

  // ---- 5. Duplicate sweep: exactly one row per reference.
  const after = await searchTasks(cfg, [['project_id', '=', PROJECT], ['name', 'ilike', PILOT_TAG]], true)
  const perRef = PILOTS.map((p) => ({
    ref: p.ref,
    matches: after.filter((r) => typeof r.name === 'string' && (r.name as string).startsWith(p.ref)).map((r) => r.id),
  }))
  console.log('DUPLICATE_SWEEP ' + JSON.stringify(perRef))
  for (const r of perRef) {
    if (r.matches.length !== 1) {
      throw new Error(`duplicate or missing pilot task for ${r.ref}: ${JSON.stringify(r.matches)}`)
    }
  }

  console.log('PILOT_TASKS ' + JSON.stringify(results))
  console.log('TASK_2588_UNTOUCHED true')
  await prisma.$disconnect()
  process.exit(0)
})().catch(async (e: any) => {
  console.error('ERR ' + (e?.message ?? e))
  try { await prisma.$disconnect() } catch {}
  process.exit(1)
})
