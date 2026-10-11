// gate_set.mjs - STAGING Uplink DB only: set the existing durable dollar gate's budget (and optionally expires_at) to the app env
// envelope without touching what was already spent/reserved/uncertain, and print the row. The envelope must equal the app env EXACTLY:
// budget_micro_usd = PUBLIC_PILOT_BUDGET_CENTS * 10000, expires_at = PUBLIC_PILOT_EXPIRES_AT (the app refuses every turn on mismatch).
// Current envelope: dec-owner-staging-pilot-budget-60c-window-plus-7d-2026-10-11 = 60 cents, expires 2026-10-19T05:25:00.000Z.
// usage: node gate_set.mjs [cents=60] [apply] [expiresIso]
import fs from 'node:fs'
import { createRequire } from 'node:module'
const pgm = createRequire('/app/package.json')('pg')
const t = fs.readFileSync('/run/' + 'secrets/uplink_env', 'utf8')
const db = new pgm.Pool({ connectionString: (t.match(/^DATABASE_URL=(.+)$/m) || [])[1] })
const cents = Number(process.argv[2] || 60)
const expires = process.argv[4] || null
const before = (await db.query(`SELECT id, budget_micro_usd, spent_micro_usd, reserved_micro_usd, uncertain_micro_usd, enabled, starts_at, expires_at FROM public_turn_spend_gates ORDER BY id`)).rows
console.log('BEFORE', JSON.stringify(before))
if (process.argv[3] === 'apply') {
  const r = await db.query(
    `UPDATE public_turn_spend_gates SET budget_micro_usd=$1, expires_at=COALESCE($2::timestamptz, expires_at), updated_at=now()
      WHERE id='uplink-personal-line-public-14d' RETURNING id, budget_micro_usd, spent_micro_usd, expires_at`,
    [cents * 10000, expires])
  console.log('AFTER', JSON.stringify(r.rows))
}
await db.end()
