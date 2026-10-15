#!/usr/bin/env python3
"""Build DRAFT Flow JSON 'v8-A' = the CONFIG-ONLY redesign: it works with the EXISTING plsvc endpoint contract (same screen ids, same data keys, same payload step values) so it needs NO code to ship.
Changes vs published v7.1 (never edited): INSTALL and INSTALL_STORE merged into ONE INSTALL screen (two honest store links 'Get it on ...' + one big footer button that serves both 'I just installed it' and 'I already have the app', payload step=installed which the endpoint already handles);
INSTALL_STORE removed (the endpoint only returns it for step=store, which no longer exists); the dead badge image removed; shorter headings/copy; CONNECTED no longer prints the server's unconditional trial sentence (customers on another plan see only their OWN balance lines).
NOT changed (needs code, see the bounded package): the server-written offer text on WELCOME (contains the overage line), the Continue hops after CONFIRM/LINE_READY, the small size of EmbeddedLink (platform limit).
usage: python mk-flow-v8a.py <v7.1.json> <out.json>"""
import json, sys, io, copy
src, out = sys.argv[1], sys.argv[2]
v = json.load(io.open(src, encoding='utf-8'))
S = {s['id']: s for s in v['screens']}
def kids(sid): return S[sid]['layout']['children']
def find(sid, t, i=0): return [c for c in kids(sid) if c.get('type') == t][i]
IOS = 'https://apps.apple.com/us/app/cloud-softphone/id567475545'
AND = 'https://play.google.com/store/apps/details?id=cz.acrobits.softphone.cloudphone'
flag = find('WELCOME', 'Image')
# WELCOME: neutral heading (the same screen serves customers who already have a line), server text unchanged
S['WELCOME']['title'] = 'Your EPIC number'
find('WELCOME', 'TextHeading')['text'] = '🇩🇲 Your EPIC Dominica number'
find('WELCOME', 'TextInput')['label'] = 'Your first name'; find('WELCOME', 'TextInput')['helper-text'] = 'Optional'
find('WELCOME', 'Footer')['label'] = 'Continue'
# CONFIRM
S['CONFIRM']['title'] = 'Ready?'
find('CONFIRM', 'TextHeading')['text'] = '🚀 Ready to start?'
# PROVISIONING
find('PROVISIONING', 'TextHeading')['text'] = '⏳ Creating your number…'
# LINE_READY
S['LINE_READY']['title'] = 'Your number'
ch = kids('LINE_READY'); ch[1]['text'] = '🎉 Your number is ready'
# INSTALL (merged with INSTALL_STORE)
S['INSTALL']['title'] = 'Get the app'
S['INSTALL']['layout']['children'] = [
  {'type': 'TextHeading', 'text': '📲 Step 1: get the free app'},
  {'type': 'TextBody', 'markdown': True, 'text': 'Your line works inside **Cloud Softphone**.\n\n**New to it?** Tap your store below, install, then come back here.\n\n**Already installed?** Skip straight to the green button.'},
  {'type': 'EmbeddedLink', 'text': '🤖 Get it on Google Play', 'on-click-action': {'name': 'open_url', 'url': AND}},
  {'type': 'EmbeddedLink', 'text': '🍎 Get it on the App Store', 'on-click-action': {'name': 'open_url', 'url': IOS}},
  {'type': 'TextCaption', 'text': 'These open the store only. Your line is set up in the next step.'},
  {'type': 'Footer', 'label': "✅ I have the app - next", 'on-click-action': {'name': 'data_exchange', 'payload': {'step': 'installed'}}},
]
# ACTIVATE
S['ACTIVATE']['title'] = 'Set up your line'
find('ACTIVATE', 'TextHeading')['text'] = '✅ Last step: set up your line'
# CONNECTED: drop the unconditional server trial sentence, keep the customer's OWN balance lines
S['CONNECTED']['title'] = 'Connected'
find('CONNECTED', 'TextHeading')['text'] = "🎉 You're connected"
cn = kids('CONNECTED')
idx = next(i for i, c in enumerate(cn) if c.get('text') == '${data.connected_text}')
cn[idx] = {'type': 'TextBody', 'text': 'Cloud Softphone is connected. You can make calls now.'}
# CONNECTED 'Making calls': drop the wallet-credit/signup-rates sentence (top-ups are not available; plan terms differ per customer)
mk = next(c for c in cn if str(c.get('text','')).startswith('Open Cloud Softphone and dial'))
mk['text'] = 'Open Cloud Softphone and dial the full number you want to call.'
# ERROR
find('ERROR', 'TextHeading')['text'] = '😕 We hit a snag'
# realistic example data = the REAL strings the current endpoint sends, so the preview shows what customers will actually read
def ex(sid, key, text): S[sid]['data'][key]['__example__'] = text
ex('WELCOME', 'offer_text', 'Free trial: 7 days with 60 minutes of Dominica calls, EC$0.\n\nAfter your included minutes: Dominica EC$0.135/min, US/Canada EC$1.49/min, from your credit.\n\nMake calls from the free Cloud Softphone app. This launch offer covers outgoing calling.\n\nVoice calling service only. SMS and emergency calling are not supported.')
ex('CONFIRM', 'confirm_text', 'Tap below to set up your free EPIC line on this WhatsApp number. The trial costs nothing.')
ex('PROVISIONING', 'provisioning_text', "We're creating your number right now - it takes a few more seconds. Tap Continue in a moment.")
ex('LINE_READY', 'did_display', '+1 (767) 818-5102'); ex('LINE_READY', 'line_text', 'Your EPIC line has been created. Next you install the free Cloud Softphone app and set your line up in it - tap Continue.')
ex('ACTIVATE', 'activate_text', 'Tap "Open my setup link" on this phone. Cloud Softphone will open and your line goes in by itself - no code needed, you are already verified in WhatsApp. The link works for 15 minutes, on the first phone that opens it.')
ex('CONNECTED', 'minutes_text', 'Included minutes: 59 of 60 left'); ex('CONNECTED', 'expiry_text', 'Plan: Free Trial - ends October 21, 2026'); ex('CONNECTED', 'wallet_text', 'Wallet credit: EC$0.00')
ex('ERROR', 'error_text', 'We could not set up your line right now. Please try again shortly.')
# SCREEN-SPACE FIXES (measured in Meta's preview: on ACTIVATE the setup link fell BELOW THE FOLD under the flag image and the 5-line server paragraph): primary action FIRST, no flag on the long screens, smaller flag elsewhere
for sid in ['WELCOME', 'CONFIRM', 'PROVISIONING', 'LINE_READY']:
    im = find(sid, 'Image'); im['width'] = 220; im['height'] = 110
S['ACTIVATE']['layout']['children'] = [c for c in S['ACTIVATE']['layout']['children'] if c.get('type') != 'Image']
ac = S['ACTIVATE']['layout']['children']
iff = next(i for i, c in enumerate(ac) if c.get('type') == 'If'); body = next(i for i, c in enumerate(ac) if c.get('text') == '${data.activate_text}')
ac[iff], ac[body] = ac[body], ac[iff]            # If(link) now before the long text
ac.insert(iff + 1, {'type': 'TextCaption', 'text': 'Tap the green link above, on this phone.'}) if False else None
S['CONNECTED']['layout']['children'] = [c for c in S['CONNECTED']['layout']['children'] if c.get('type') != 'Image']
del S['INSTALL_STORE']
v['screens'] = [S[k] for k in ['WELCOME', 'CONFIRM', 'PROVISIONING', 'LINE_READY', 'INSTALL', 'ACTIVATE', 'CONNECTED', 'ERROR']]
v['routing_model'] = {'WELCOME': ['CONFIRM', 'ERROR'], 'CONFIRM': ['LINE_READY', 'PROVISIONING', 'ERROR'], 'PROVISIONING': ['LINE_READY', 'ERROR'], 'LINE_READY': ['INSTALL', 'ACTIVATE', 'CONNECTED', 'ERROR'], 'INSTALL': ['ACTIVATE', 'CONNECTED', 'ERROR'], 'ACTIVATE': ['CONNECTED', 'ERROR'], 'CONNECTED': [], 'ERROR': []}
io.open(out, 'w', encoding='utf-8', newline='\n').write(json.dumps(v, ensure_ascii=False, indent=1))
print('screens:', [s['id'] for s in v['screens']], '| bytes', len(json.dumps(v, ensure_ascii=False).encode()))
