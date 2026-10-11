// gate_set.mjs - STAGING Uplink DB only: set the existing durable dollar gate's budget to the app env envelope (35 cents) without touching
// what was already spent/reserved, and print the row. The envelope (dates) must equal the app env; budget = PUBLIC_PILOT_BUDGET_CENTS * 10000.
import fs from 'node:fs'
import { createRequire } from 'node:module'
const pgm = createRequire('/app/package.json')('pg')
const t = fs.readFileSync('/run/' + 'secrets/uplink_env', 'utf8')
const db = new pgm.Pool({ connectionString: (t.match(/^DATABASE_URL=(.+)$/m) || [])[1] })
const cents = Number(process.argv[2] || 35)
const before = (await db.query(`SELECT id, budget_micro_usd, spent_micro_usd, reserved_micro_usd, uncertain_micro_usd, enabled, starts_at, expires_at FROM public_turn_spend_gates ORDER BY id`)).rows
console.log('BEFORE', JSON.stringify(before))
if (process.argv[3] === 'apply') {
  const r = await db.query(`UPDATE public_turn_spend_gates SET budget_micro_usd=$1 WHERE id='uplink-personal-line-public-14d' RETURNING id, budget_micro_usd, spent_micro_usd`, [cents * 10000])
  console.log('AFTER', JSON.stringify(r.rows))
}
await db.end()
