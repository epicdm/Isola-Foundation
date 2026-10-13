// validator_read.mjs - STAGING Uplink DB, READ-ONLY: the latest assistant turns whose validators failed (names + details, truncated),
// with the tool names called. For diagnosing validator_failed handoffs in the expert suite. No message bodies beyond 160 chars.
import fs from 'node:fs'
import { createRequire } from 'node:module'
const pgm = createRequire('/app/package.json')('pg')
const t = fs.readFileSync('/run/' + 'secrets/uplink_env', 'utf8')
const db = new pgm.Pool({ connectionString: (t.match(/^DATABASE_URL=(.+)$/m) || [])[1] })
const r = await db.query(`SELECT created_at, role, left(content, 160) AS content, validators_passed, (SELECT array_agg(x->>'name') FROM jsonb_array_elements(coalesce(tool_calls,'[]'::jsonb)) x) AS tools
  FROM agent_turns WHERE role='assistant' AND created_at > now() - interval '30 minutes' ORDER BY created_at DESC LIMIT 12`)
for (const row of r.rows) {
  const v = row.validators_passed
  const failed = Array.isArray(v) ? v.filter((x) => x && x.passed === false) : (v && typeof v === 'object' ? Object.entries(v).filter(([, x]) => x === false || x?.passed === false) : [])
  console.log(JSON.stringify({ at: row.created_at, tools: row.tools, failed, content: row.content }))
}
await db.end()
