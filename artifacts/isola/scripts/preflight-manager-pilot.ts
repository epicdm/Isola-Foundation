/**
 * READ-ONLY manager-pilot preflight against the authoritative Odoo instance.
 *
 * Resolves the tenant's Odoo config through the ONE shared implementation
 * (lib/engine-bindings.resolveOdooConfigForTenant) so credentials are decrypted
 * in-process and never printed. Every call below is search_read. No writes.
 *
 *   npx tsx scripts/preflight-manager-pilot.ts
 */
import { resolveOdooConfigForTenant } from '../lib/engine-bindings'
import { json2Call } from '../engines/odoo'

const TENANT  = '43b006e4-33e0-42a8-bec7-4422ba290d79'
const PROJECT = 46
const PILOT_TAG = 'ISOLA-PILOT'

;(async () => {
  const cfg = await resolveOdooConfigForTenant(TENANT)

  const q = async (
    label: string, model: string, params: Record<string, unknown>,
  ): Promise<unknown> => {
    try {
      const r = await json2Call(cfg, model, 'search_read', params)
      console.log(`${label} ${JSON.stringify(r)}`)
      return r
    } catch (e: any) {
      console.log(`${label} ERROR ${e?.message ?? e}`)
      return null
    }
  }

  await q('PROJECT46', 'project.project', {
    domain: [['id', '=', PROJECT]],
    fields: ['id', 'name', 'active', 'company_id', 'user_id', 'type_ids'],
    limit: 1,
  })

  const stages = await q('STAGES_BY_PROJECT', 'project.task.type', {
    domain: [['project_ids', 'in', [PROJECT]]],
    fields: ['id', 'name', 'sequence', 'fold'],
    limit: 40,
  })
  if (!stages || (Array.isArray(stages) && stages.length === 0)) {
    await q('STAGES_ALL', 'project.task.type', {
      domain: [], fields: ['id', 'name', 'sequence', 'fold', 'project_ids'], limit: 60,
    })
  }

  await q('IRMODEL_PROJECT_TASK', 'ir.model', {
    domain: [['model', '=', 'project.task']], fields: ['id', 'model', 'name'], limit: 1,
  })

  await q('ACTIVITY_TYPES', 'mail.activity.type', {
    domain: [], fields: ['id', 'name', 'res_model', 'delay_count', 'delay_unit', 'category'], limit: 40,
  })

  await q('USERS_5_8_2', 'res.users', {
    domain: [['id', 'in', [2, 5, 8]]], fields: ['id', 'login', 'name', 'active', 'share'], limit: 5,
  })

  await q('PILOT_DUPES', 'project.task', {
    domain: [['project_id', '=', PROJECT], ['name', 'ilike', PILOT_TAG]],
    fields: ['id', 'name', 'stage_id'], limit: 20,
  })

  await q('TASK_2588', 'project.task', {
    domain: [['id', '=', 2588]],
    fields: ['id', 'name', 'project_id', 'stage_id', 'user_ids', 'active'], limit: 1,
  })

  await q('OPEN_ACTIVITIES_ON_2588', 'mail.activity', {
    domain: [['res_model', '=', 'project.task'], ['res_id', '=', 2588]],
    fields: ['id', 'summary', 'user_id', 'activity_type_id', 'date_deadline'], limit: 10,
  })

  process.exit(0)
})().catch((e: any) => { console.error('ERR ' + (e?.message ?? e)); process.exit(1) })
