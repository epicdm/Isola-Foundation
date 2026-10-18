// deepseek: ONE-OFF send of the PRESENTATION-ONLY test Flow (draft 3134714280060947, no endpoint) in DRAFT mode to the owner's
// authorized test identity ONLY (17672859610), from 0001 (phone id 1023804347491554). Token in-process, never printed.
// Payload per Meta docs (whatsapp-flows-tools types.md section 8): flow_message_version "3", flow_action "navigate",
// flow_action_payload {screen}, mode "draft". Prints the wamid prefix only. Refuses to run twice (marker file).
import fs from 'node:fs'
import crypto from 'node:crypto'
const MARK = '/tmp/zz_pl_v8_presentation_sent.marker'
if (fs.existsSync(MARK)) { console.log('refused: already sent once (' + fs.readFileSync(MARK, 'utf8').trim() + ')'); process.exit(2) }
const to = String(process.argv[2] || '').replace(/\D/g, '')
if (to !== '17672859610') { console.log('refused: only the owner test identity'); process.exit(2) }
const env = {}; for (const l of fs.readFileSync('/opt/bff-v2/.env', 'utf8').split('\n')) { const m = l.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/); if (m) env[m[1]] = m[2].replace(/\r$/, '').replace(/^["']|["']$/g, '') }
const payload = { messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'interactive', interactive: { type: 'flow',
  header: { type: 'text', text: 'TEST: new install screen' },
  body: { text: 'Design test only. This opens a preview of the new EPIC install screen so you can check how it looks and that the store link and "Continue setup" work on your phone. Nothing on your line or account changes.' },
  footer: { text: 'EPIC Personal Line - test' },
  action: { name: 'flow', parameters: { flow_message_version: '3', flow_id: '3134714280060947', flow_token: 'presentation-test-' + crypto.randomUUID(), flow_cta: 'Open test', mode: 'draft', flow_action: 'navigate', flow_action_payload: { screen: 'INSTALL' } } } } }
const r = await fetch('https://graph.facebook.com/v23.0/1023804347491554/messages', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + env.META_SYSTEM_TOKEN }, body: JSON.stringify(payload) }).then((x) => x.json())
const id = r.messages?.[0]?.id
if (id) fs.writeFileSync(MARK, new Date().toISOString() + ' ' + id.slice(0, 28))
console.log(id ? 'SENT wamid=' + id.slice(0, 28) + '... at ' + new Date().toISOString() : 'FAILED: ' + JSON.stringify(r.error?.error_user_msg || r.error?.message || r).slice(0, 300))
