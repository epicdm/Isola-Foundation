// Build Flow v8 from the committed v7.1 JSON. Only presentation changes; screen ids, routing, data fields and every
// data_exchange payload are unchanged (same plsvc endpoint contract). Prints a structural diff summary and the checks.
// usage: node flow_build_v8.mjs <v7_1.json> <out v8.json>
import fs from 'node:fs'
const src = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
const f = structuredClone(src)
const S = (id) => f.screens.find((s) => s.id === id)
const kids = (id) => S(id).layout.children

f.version = '7.3' // Meta-recommended Flow JSON (changelog 2025-09-10); data_api_version stays 3.0 (endpoint contract unchanged)

// progress in titles (Meta best practice: "Question 1 of 3")
S('CONFIRM').title = 'Step 1 of 4: Confirm'
S('LINE_READY').title = 'Step 2 of 4: Your number'
S('INSTALL').title = 'Step 3 of 4: Get the app'
S('INSTALL_STORE').title = 'Step 3 of 4: Install'
S('ACTIVATE').title = 'Step 4 of 4: Set up'

// EPIC presentation in static copy
kids('LINE_READY').find((c) => c.type === 'TextHeading' && c.text === 'Your Isola number').text = 'Your EPIC number'
for (const it of kids('INSTALL')[0]['list-items']) {
  const m = it['main-content']
  if (/Isola line/.test(m.metadata)) m.metadata = 'Install Cloud Softphone, the free app your EPIC line works in.'
}

// INSTALL_STORE: badge + store link together at the top (the prominent, supported store action), then the return path,
// then a separate continuation action. install_md is still declared (endpoint sends it) but no longer rendered: its last
// step names the old footer label.
const st = S('INSTALL_STORE')
const badge = st.layout.children.find((c) => c.type === 'Image')
const link = st.layout.children.find((c) => c.type === 'EmbeddedLink')
st.layout.children = [
  { type: 'TextHeading', text: 'Get Cloud Softphone' },
  { type: 'TextBody', text: 'Your EPIC line works in Cloud Softphone, a free calling app. It takes about a minute.' },
  { ...badge, height: 90 },
  link,
  { type: 'TextSubheading', text: 'Then come back here' },
  { type: 'TextBody', markdown: true, text: '**1.** Install **Cloud Softphone** - it\'s free\n\n**2.** Come back to WhatsApp: on iPhone tap **◀ WhatsApp** at the top left; on Android press **Back**\n\n**3.** Tap **Continue setup** below' },
  { type: 'TextCaption', text: 'Install the app first - your setup link only works once Cloud Softphone is on this phone.' },
  { type: 'Footer', label: 'Continue setup', 'on-click-action': st.layout.children.find((c) => c.type === 'Footer')['on-click-action'] },
]

// CONNECTED: point to the WhatsApp menu (rc13f) and keep the direct human path
const help = kids('CONNECTED').find((c) => c.type === 'TextBody' && /talk to a person/.test(c.text))
help.text = 'Tap Done. Any time, send "menu" in this chat to manage your line, or "talk to a person" and our team will reply here.'

fs.writeFileSync(process.argv[3], JSON.stringify(f))

// ---- checks: contract preserved + Meta limits from the components guide
const fails = []
const ck = (n, ok) => { if (!ok) fails.push(n); console.log((ok ? 'PASS ' : 'FAIL ') + n) }
const actions = (x) => JSON.stringify(x, (k, v) => (k === 'src' || k === '__example__' ? undefined : v)).match(/"on-click-action":\{[^}]*\{?[^}]*\}?[^}]*\}/g) || []
ck('routing_model unchanged', JSON.stringify(f.routing_model) === JSON.stringify(src.routing_model))
ck('screen ids/order unchanged', f.screens.map((s) => s.id).join() === src.screens.map((s) => s.id).join())
ck('declared data fields unchanged on every screen', f.screens.every((s, i) => JSON.stringify(Object.keys(s.data || {})) === JSON.stringify(Object.keys(src.screens[i].data || {}))))
ck('every on-click action identical (multiset)', JSON.stringify(actions(f.screens).sort()) === JSON.stringify(actions(src.screens).sort()))
ck('untouched screens byte-identical (WELCOME, PROVISIONING, ERROR)', ['WELCOME', 'PROVISIONING', 'ERROR'].every((id) => JSON.stringify(S(id)) === JSON.stringify(src.screens.find((s) => s.id === id))))
ck('CONFIRM/ACTIVATE layout unchanged (title only)', ['CONFIRM', 'ACTIVATE'].every((id) => JSON.stringify(S(id).layout) === JSON.stringify(src.screens.find((s) => s.id === id).layout)))
const foot = st.layout.children.filter((c) => c.type === 'Footer')
ck('INSTALL_STORE: one Footer, label <= 35, payload {step:installed}', foot.length === 1 && foot[0].label.length <= 35 && foot[0]['on-click-action'].payload.step === 'installed')
ck('INSTALL_STORE: EmbeddedLink open_url ${data.store_url} directly after badge', st.layout.children[2].type === 'Image' && st.layout.children[3].type === 'EmbeddedLink' && st.layout.children[3]['on-click-action'].name === 'open_url' && st.layout.children[3]['on-click-action'].url === '${data.store_url}')
ck('EmbeddedLinks per screen <= 2', f.screens.every((s) => JSON.stringify(s.layout).split('"EmbeddedLink"').length - 1 <= 2))
ck('Images per screen <= 3', f.screens.every((s) => JSON.stringify(s.layout).split('"type":"Image"').length - 1 <= 3))
ck('NavigationList alone on INSTALL, descriptions <= 20, titles <= 30, metadata <= 80', kids('INSTALL').length === 1 && kids('INSTALL')[0]['list-items'].every((i) => i['main-content'].description.length <= 20 && i['main-content'].title.length <= 30 && i['main-content'].metadata.length <= 80))
ck('headings/subheadings <= 80', JSON.stringify(f.screens).match(/"type":"Text(Sub)?[Hh]eading","text":"[^"]*"/g).every((m) => JSON.parse('{' + m + '}').text.length <= 80))
ck('no "Isola" left in static INSTALL/INSTALL_STORE/LINE_READY copy', !/Isola/.test(JSON.stringify([S('INSTALL').layout, st.layout, S('LINE_READY').layout])))
console.log(fails.length ? `${fails.length} FAILED` : 'ALL PASSED', '| bytes', fs.statSync(process.argv[3]).size)
