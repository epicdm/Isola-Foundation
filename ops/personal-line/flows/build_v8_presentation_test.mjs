// Build a PRESENTATION-ONLY test Flow from v8: no endpoint, no data_exchange, static test data. Opens on INSTALL and lets a
// tester walk INSTALL -> INSTALL_STORE (real store badge + real store link) -> a terminal "test only" screen. It cannot reach
// plsvc, cannot read or change any subscriber, line or journey state. Rendering/navigation evidence only.
// usage: node flow_build_v8_presentation.mjs <v8.json> <flow-store-badges.ts> <out.json>
import fs from 'node:fs'
const v8 = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
const ts = fs.readFileSync(process.argv[3], 'utf8')
const badge = (n) => ts.match(new RegExp(`export const STORE_BADGE_${n}_B64\\s*=\\s*['"\`]([A-Za-z0-9+/=]+)['"\`]`))[1]
const IOS = badge('IOS'), AND = badge('ANDROID')
const S = (id) => structuredClone(v8.screens.find((s) => s.id === id))
const STORE = { ios: 'https://apps.apple.com/us/app/cloud-softphone/id567475545', android: 'https://play.google.com/store/apps/details?id=cz.acrobits.softphone.cloudphone' }

const install = S('INSTALL')
const items = install.layout.children[0]['list-items']
const storeData = (os) => ({ badge_img: os === 'ios' ? IOS : AND, store_url: STORE[os], store_label: os === 'ios' ? '👉 Open the App Store' : '👉 Open Google Play', install_md: '' })
for (const it of items) {
  const a = it['on-click-action']
  if (a.payload?.step === 'store') it['on-click-action'] = { name: 'navigate', next: { type: 'screen', name: 'INSTALL_STORE' }, payload: storeData(a.payload.os) }
  else it['on-click-action'] = { name: 'navigate', next: { type: 'screen', name: 'TEST_DONE' }, payload: {} }
}
install.title = 'TEST: ' + install.title.replace(/^Step 3 of 4: /, '')

const store = S('INSTALL_STORE')
for (const k of Object.keys(store.data)) delete store.data[k].__example__
store.data.badge_img.__example__ = IOS; store.data.store_url.__example__ = STORE.ios; store.data.store_label.__example__ = '👉 Open the App Store'; store.data.install_md.__example__ = ''
const foot = store.layout.children.find((c) => c.type === 'Footer')
foot['on-click-action'] = { name: 'navigate', next: { type: 'screen', name: 'TEST_DONE' }, payload: {} }

const done = { id: 'TEST_DONE', title: 'Test only', terminal: true, data: {}, layout: { type: 'SingleColumnLayout', children: [
  { type: 'TextHeading', text: 'Presentation test complete' },
  { type: 'TextBody', text: 'This was a design preview of the EPIC install screen. Nothing on your line or account was changed, and no setup step was recorded.' },
  { type: 'Footer', label: 'Close test', 'on-click-action': { name: 'complete', payload: { test: 'presentation_only' } } } ] } }

const out = { version: v8.version, screens: [install, store, done] }
fs.writeFileSync(process.argv[4], JSON.stringify(out))
const j = JSON.stringify(out)
const ok = (n, c) => console.log((c ? 'PASS ' : 'FAIL ') + n)
ok('no data_exchange anywhere', !j.includes('data_exchange'))
ok('no endpoint fields (data_api_version/routing_model)', !('data_api_version' in out) && !('routing_model' in out))
ok('INSTALL_STORE layout identical to v8 except footer action', JSON.stringify(store.layout.children.filter((c) => c.type !== 'Footer')) === JSON.stringify(v8.screens.find((s) => s.id === 'INSTALL_STORE').layout.children.filter((c) => c.type !== 'Footer')))
ok('footer label still "Continue setup"', foot.label === 'Continue setup')
ok('both badges present, distinct', IOS.length > 1000 && AND.length > 1000 && IOS !== AND)
console.log('bytes', fs.statSync(process.argv[4]).size)
