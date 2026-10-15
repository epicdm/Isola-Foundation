// zz-flow-v8-publish: publish the reviewed Option B signup Flow draft (owner decision dec-owner-pl-signup-option-b-chat-buttons-2026-10-14;
// owner 2026-10-14 "Launch after the flow changes are done" / "Move to launch"). Runs INSIDE the relay container (token read in-process,
// never printed): node - < zz-flow-v8-publish.js   with env FLOW_ID and EXPECT_SHA (sha256 of the reviewed flow-v8.json) and MODE=check|publish.
// Refuses unless: status DRAFT, 0 validation errors, endpoint host go.uplink.epic.dm, and the draft's stored flow.json == EXPECT_SHA.
// A published Flow cannot be edited or unpublished (only deprecated); the rollback is env PL_SIGNUP_FLOW_ID_V8 removal (new customers -> v7.1).
const fs = require('fs'); const crypto = require('crypto')
let T = ''; try { T = fs.readFileSync(process.env.WA_PRESENCE_TOKEN_FILE, 'utf8').trim() } catch {}
const G = 'https://graph.facebook.com/v21.0', ID = process.env.FLOW_ID || '', WANT = process.env.EXPECT_SHA || '', MODE = process.env.MODE || 'check'
const H = { Authorization: 'Bearer ' + T }
const err = (j) => (j && j.error ? `code ${j.error.code}/${j.error.error_subcode || '-'}: ${String(j.error.message).slice(0, 160)}` : '-')
async function call(method, url, body) {
  const r = await fetch(url, { method, headers: { ...H, ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) }, body, signal: AbortSignal.timeout(30000) })
  const j = await r.json().catch(() => ({})); return { status: r.status, j }
}
;(async () => {
  if (!T || !/^\d{10,20}$/.test(ID) || !/^[0-9a-f]{64}$/.test(WANT)) { console.log('REFUSE: token/FLOW_ID/EXPECT_SHA missing'); process.exit(2) }
  const g = await call('GET', `${G}/${ID}?fields=id,name,status,json_version,validation_errors,endpoint_uri`)
  const host = (() => { try { return new URL(g.j?.endpoint_uri).host } catch { return '' } })()
  console.log('READ HTTP', g.status, '| name:', g.j?.name, '| status:', g.j?.status, '| json_version:', g.j?.json_version, '| validation_errors:', (g.j?.validation_errors || []).length, '| endpoint host:', host, '| err:', err(g.j))
  const as = await call('GET', `${G}/${ID}/assets`)
  const asset = (as.j?.data || []).find((x) => x.name === 'flow.json')
  let sha = ''
  if (asset?.download_url) { const r = await fetch(asset.download_url, { signal: AbortSignal.timeout(30000) }); sha = crypto.createHash('sha256').update(Buffer.from(await r.arrayBuffer())).digest('hex') }
  console.log('flow.json sha256:', sha ? sha.slice(0, 16) : '(unreadable)', '| expected:', WANT.slice(0, 16), '| match:', sha === WANT)
  const ok = g.status === 200 && g.j?.status === 'DRAFT' && (g.j?.validation_errors || []).length === 0 && host === 'go.uplink.epic.dm' && sha === WANT
  if (!ok) { console.log(g.j?.status === 'PUBLISHED' ? 'ALREADY PUBLISHED - nothing to do' : 'REFUSE: preconditions not met'); process.exit(g.j?.status === 'PUBLISHED' ? 0 : 3) }
  if (MODE !== 'publish') { console.log('CHECK OK (MODE=check, nothing published)'); return }
  const p = await call('POST', `${G}/${ID}/publish`, '')
  console.log('PUBLISH HTTP', p.status, '| success:', p.j?.success, '| err:', err(p.j))
  const after = await call('GET', `${G}/${ID}?fields=id,status,validation_errors`)
  console.log('READ after publish HTTP', after.status, '| status:', after.j?.status, '| validation_errors:', (after.j?.validation_errors || []).length)
  process.exit(after.j?.status === 'PUBLISHED' ? 0 : 4)
})().catch((e) => { console.log('ERR', e.message); process.exit(5) })
