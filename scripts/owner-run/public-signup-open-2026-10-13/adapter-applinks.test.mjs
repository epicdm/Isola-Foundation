import * as OLD from './pl-action-adapter.deployed.mjs'; import * as NEW from './pl-action-adapter.applinks.mjs'
const o = { overage_dominica_xcd: '0.135', overage_uscan_xcd: '1.49' }, bal = { known: true, minutes_remaining: 59, wallet_xcd: '0.00', pool: 'dominica' }
let pass = 0, fail = 0; const t = (n, c) => { c ? pass++ : fail++; console.log(c ? 'PASS' : 'FAIL', n) }
const IOS = NEW.IOS_URL, AND = NEW.ANDROID_URL
// A. installed-states: NO links, text byte-identical to the deployed output (control: old === new)
for (const st of ['registered_no_call', 'active', 'activated_not_registered', 'attention']) for (const d of ['dominica', 'uscan', 'first']) {
  const a = OLD.composeCallGuide(d, o, bal), b = NEW.composeCallGuide(d, o, bal, st)
  t(`guide ${d} state=${st}: identical to deployed, no link`, a === b && !b.includes('apps.apple') && !b.includes('play.google'))
}
// B. needs-install states + unknown: links appended exactly once, original text preserved as a prefix
for (const st of ['no_line', 'setup_not_activated', undefined]) for (const d of ['dominica', 'uscan', 'first']) {
  const a = OLD.composeCallGuide(d, o, bal), b = NEW.composeCallGuide(d, o, bal, st)
  t(`guide ${d} state=${st}: links present once, deployed text is the prefix`, b.startsWith(a) && b.split(IOS).length === 2 && b.split(AND).length === 2)
}
// C. failed-call not-connected branches
const fxNC = { registration: 'unregistered', first_call_done: false }, fxUnk = { registration: 'unknown' }, fxConn = { registration: 'registered' }
for (const [nm, fx] of [['not_connected', fxNC], ['unknown', fxUnk]]) {
  const a = OLD.composeCallFailed(fx, bal).text, ins = NEW.composeCallFailed(fx, bal, 'registered_no_call').text, need = NEW.composeCallFailed(fx, bal, 'setup_not_activated').text
  t(`failed ${nm} installed: identical, no link`, a === ins && !ins.includes('apps.apple'))
  t(`failed ${nm} needs install: links once`, need.startsWith(a) && need.split(IOS).length === 2)
}
t('failed connected: no links regardless of state', !NEW.composeCallFailed(fxConn, bal, 'no_line').text.includes('apps.apple'))
// D. positive control that links ARE the verified constants
t('IOS_URL constant', IOS === 'https://apps.apple.com/us/app/cloud-softphone/id567475545')
t('ANDROID_URL constant', AND === 'https://play.google.com/store/apps/details?id=cz.acrobits.softphone.cloudphone')
t('needsInstall matrix', NEW.needsInstall('no_line') && NEW.needsInstall('setup_not_activated') && NEW.needsInstall(undefined) && !NEW.needsInstall('active') && !NEW.needsInstall('registered_no_call') && !NEW.needsInstall('activated_not_registered') && !NEW.needsInstall('attention'))
console.log(`\n${pass} pass, ${fail} fail`); process.exit(fail ? 1 : 0)
