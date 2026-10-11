// deepseek (token from the live env, in-process, never printed). Creates "Isola Personal Line Onboarding v8" as a DRAFT on WABA
// 272252189309178 (or reuses the same-name draft), uploads /tmp/zz_pl_onboarding_v8.json, sets the same endpoint as v7.1,
// prints Meta validation errors. Does NOT publish. Does NOT touch Flow 1028745810223586 (v7.1, live) or PL_SIGNUP_FLOW_ID.
// Writes the preview URL to /tmp/zz_fp8_url.txt (0600), never prints it.
import fs from 'node:fs'
const env = {}; for (const l of fs.readFileSync('/opt/bff-v2/.env', 'utf8').split('\n')) { const m = l.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/); if (m) env[m[1]] = m[2].replace(/\r$/, '').replace(/^["']|["']$/g, '') }
const T = env.META_SYSTEM_TOKEN, WABA = '272252189309178', NAME = 'Isola Personal Line Onboarding v8', EP = 'https://go.uplink.epic.dm/api/whatsapp/flows'
const G = 'https://graph.facebook.com/v23.0/'
const get = (p) => fetch(`${G}${p}${p.includes('?') ? '&' : '?'}access_token=${T}`).then((r) => r.json())
const list = await get(`${WABA}/flows?fields=id,name,status&limit=100`)
let id = (list.data || []).find((f) => f.name === NAME && f.status === 'DRAFT')?.id
if (!id) {
  const r = await fetch(`${G}${WABA}/flows?access_token=${T}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: NAME, categories: ['SIGN_UP'], endpoint_uri: EP }) }).then((x) => x.json())
  if (!r.id) { console.log('create failed:', JSON.stringify(r.error?.error_user_msg || r.error?.message || r)); process.exit(1) }
  id = r.id; console.log('created draft', id)
} else console.log('reusing draft', id)
if (id === '1028745810223586') { console.log('REFUSING: that is the live v7.1 flow'); process.exit(1) }
const fd = new FormData()
fd.append('name', 'flow.json'); fd.append('asset_type', 'FLOW_JSON')
fd.append('file', new Blob([fs.readFileSync('/tmp/zz_pl_onboarding_v8.json')], { type: 'application/json' }), 'flow.json')
const up = await fetch(`${G}${id}/assets?access_token=${T}`, { method: 'POST', body: fd }).then((x) => x.json())
console.log('upload:', up.success === true ? 'ok' : JSON.stringify(up.error?.error_user_msg || up.error?.message || up), '| validation_errors:', JSON.stringify(up.validation_errors || []))
const m = await get(`${id}?fields=name,status,endpoint_uri,validation_errors,json_version,data_api_version,health_status,preview.invalidate(true)`)
fs.writeFileSync('/tmp/zz_fp8_url.txt', m.preview?.preview_url || '', { mode: 0o600 })
console.log('flow', id, '| name', m.name, '| status', m.status, '| json', m.json_version, '| data_api', m.data_api_version, '| endpoint', m.endpoint_uri, '| validation_errors', JSON.stringify(m.validation_errors || []), '| can_send', m.health_status?.can_send_message)
console.log('preview url present:', !!m.preview?.preview_url)
