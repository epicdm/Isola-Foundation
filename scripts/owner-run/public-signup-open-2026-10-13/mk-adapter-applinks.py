#!/usr/bin/env python3
# Adapter delta (v2, rule of 2026-10-13 PM): point the customer to the calling app with the RELEVANT next action; show the store links ONLY when the customer needs to
# install (journey state no_line / setup_not_activated / unknown) - never on every reply. Base = the DEPLOYED file (sha12 5c441a26cb4e). Every edit is anchor-asserted (exactly once).
#   - APP_LINKS_LINE + needsInstall(state): links line returned only when the app still has to be installed
#   - composeCallGuide(dest,o,bal,state) / composeCallFailed(fx,bal,state): optional 4th/3rd arg; with no state the old output is byte-identical except links are appended (unknown => needs install)
#   - calling_help_menu text names the app; links only when install is needed
#   - pl_guide facts gain out.app {name, open, ios_url, android_url, install_needed, next_action, note} so the AGENT decides from a fact (the skill promised one)
# usage: python3 mk-adapter-applinks.py <deployed.mjs> <out.mjs>
import io, sys, hashlib, difflib
src, out = sys.argv[1], sys.argv[2]
s = io.open(src, encoding='utf-8', newline='').read()
assert hashlib.sha256(s.encode('utf-8')).hexdigest()[:12] == '5c441a26cb4e', 'base is not the deployed adapter'
def rep(old, new, n=1):
    global s
    assert s.count(old) == n, f'anchor count {s.count(old)} != {n}: {old[:70]}'
    s = s.replace(old, new)

rep("export const ANDROID_URL = 'https://play.google.com/store/apps/details?id=cz.acrobits.softphone.cloudphone'\n",
    "export const ANDROID_URL = 'https://play.google.com/store/apps/details?id=cz.acrobits.softphone.cloudphone'\n"
    "// Owner rule 2026-10-13: every calling answer points to the calling app with the relevant NEXT ACTION; store links only when the app still has to be installed.\n"
    "// The links open the app page (Open if installed, Install if not). Journey states where the app is already set up: activated_not_registered, registered_no_call, active, attention.\n"
    "export const APP_LINKS_LINE = `Get *Cloud Softphone* (free): iPhone: ${IOS_URL} · Android: ${ANDROID_URL}`\n"
    "const APP_INSTALLED_STATES = new Set(['activated_not_registered', 'registered_no_call', 'active', 'attention'])\n"
    "export const needsInstall = (state) => !APP_INSTALLED_STATES.has(state)\n"
    "const linksFor = (state) => (needsInstall(state) ? ['', APP_LINKS_LINE] : [])\n")

# composeCallGuide: new optional 4th arg, links only when install is needed
rep("export function composeCallGuide(dest, o, bal) {", "export function composeCallGuide(dest, o, bal, state) {")
rep("`Open Cloud Softphone, dial +1 767 and the 7-digit number, then tap call.`, ``, dm + walletLine].join('\\n')",
    "`Open Cloud Softphone, dial +1 767 and the 7-digit number, then tap call.`, ``, dm + walletLine, ...linksFor(state)].join('\\n')")
rep("`Open Cloud Softphone, dial +1 and the 10-digit number, then tap call.`, ``, cover].join('\\n')",
    "`Open Cloud Softphone, dial +1 and the 10-digit number, then tap call.`, ``, cover, ...linksFor(state)].join('\\n')")
rep("`3. Tap call.`, ``, dm + walletLine].join('\\n')", "`3. Tap call.`, ``, dm + walletLine, ...linksFor(state)].join('\\n')")
rep("text: composeCallGuide(dest, o, bal), choices", "text: composeCallGuide(dest, o, bal, j.state), choices")

# calling help menu
rep("text: `Happy to help with calling. What do you need?`",
    "text: `Happy to help with calling. Calls go out from the free Cloud Softphone app on your phone.${needsInstall(j.state) ? `\\n\\n${APP_LINKS_LINE}` : ''}\\n\\nWhat do you need?`")

# composeCallFailed: only the not-connected branches mention the app; add links only if install is needed
rep("export function composeCallFailed(fx, bal) {", "export function composeCallFailed(fx, bal, state) {")
rep("`Then tap *Check connection*. If it still fails, tap *Talk to a person*.`].join('\\n') }",
    "`Then tap *Check connection*. If it still fails, tap *Talk to a person*.`, ...linksFor(state)].join('\\n') }")
rep("`Then tap *Check connection*.`].join('\\n')\n    : [`Your phone isn't connected to your line yet, so calls can't go out.`",
    "`Then tap *Check connection*.`, ...linksFor(state)].join('\\n')\n    : [`Your phone isn't connected to your line yet, so calls can't go out.`")
rep("tap *Continue setup* for a fresh link.`].join('\\n') }\n  const known = bal?.known === true",
    "tap *Continue setup* for a fresh link.`, ...linksFor(state)].join('\\n') }\n  const known = bal?.known === true")
rep("const d = composeCallFailed(fx, bal)\n        return say(", "const d = composeCallFailed(fx, bal, j.state)\n        return say(")
rep("const d = composeCallFailed(fx, bal)\n        out.diagnosis", "const d = composeCallFailed(fx, bal, j.state)\n        out.diagnosis")

# pl_guide facts
rep("out.dialing = { dominica: '+1 767 then the 7-digit number', us_canada: '+1 then the 10-digit number', app: 'Cloud Softphone on this phone' }",
    "out.dialing = { dominica: '+1 767 then the 7-digit number', us_canada: '+1 then the 10-digit number', app: 'Cloud Softphone on this phone' }\n"
    "      out.app = { name: 'Cloud Softphone', ios_url: IOS_URL, android_url: ANDROID_URL, install_needed: needsInstall(j.state),\n"
    "        next_action: needsInstall(j.state) ? 'install Cloud Softphone, then open it' : 'open Cloud Softphone, check it shows connected, then make the call',\n"
    "        note: 'Give the store links ONLY when install_needed is true or the customer says they do not have or cannot find the app; otherwise give just the next action. Each link opens the app page: Open if installed, Install if not.' }")

io.open(out, 'w', encoding='utf-8', newline='').write(s)
o = io.open(src, encoding='utf-8', newline='').read()
print('base sha12', hashlib.sha256(o.encode()).hexdigest()[:12], 'new sha12', hashlib.sha256(s.encode()).hexdigest()[:12])
d = [l for l in difflib.unified_diff(o.split('\n'), s.split('\n'), 'deployed', 'applinks', lineterm='', n=0) if not l.startswith('@@')]
print('changed lines:', sum(1 for l in d if l[:1] in '+-' and not l.startswith(('+++', '---'))))
