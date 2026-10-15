#!/usr/bin/env python3
"""Build the DRAFT Flow JSON 'Isola Personal Line Onboarding v8' (owner-approved scope 2026-10-14: simpler, more appealing signup).
v8 is NEW-CUSTOMER ONLY and has THREE screens (WELCOME, PROVISIONING, ERROR). Everything that needs a URL (get the app, set up my line) moves OUT of the Flow into large WhatsApp cta_url button messages sent by plsvc (see the Codex package), because the only URL-opening element inside a Flow is the small EmbeddedLink (Meta: Image has no on-click-action; Footer actions are data_exchange/navigate/complete; open_url exists only on EmbeddedLink and OptIn, Flow JSON 6.1+).
The Flow is closed by the endpoint answering the RESERVED screen id SUCCESS (not a screen in this JSON), so there is no 'Done' tap.
Base: the published v7.1 JSON (same version 6.3, data_api_version 3.0, flag image reused). Usage: python mk-flow-v8.py <v7.1.json> <out v8.json>"""
import json, sys, io
src, out = sys.argv[1], sys.argv[2]
v71 = json.load(io.open(src, encoding='utf-8'))
flag = next(c for c in next(s for s in v71['screens'] if s['id'] == 'WELCOME')['layout']['children'] if c.get('type') == 'Image')  # the existing Dominica flag image (jpeg/png base64)
def img():
    d = dict(flag); d['width'] = 220; d['height'] = 110; return d
welcome = {
  'id': 'WELCOME', 'title': 'Your free number',
  'data': {
    'trial_line': {'type': 'string', '__example__': 'Free for 7 days - 60 minutes to Dominica'},
    'scope_text': {'type': 'string', '__example__': "Outgoing calls to Dominica are free for your 7-day trial, up to 60 minutes. Incoming calls work too. Paid plans and top-ups aren't available yet."},
    'fine_print': {'type': 'string', '__example__': 'Voice calling only - no SMS or emergency calls. Tapping the button starts your free trial on this WhatsApp number.'},
  },
  'layout': {'type': 'SingleColumnLayout', 'children': [
    img(),
    {'type': 'TextHeading', 'text': '🇩🇲 Your free Dominica number'},
    {'type': 'TextSubheading', 'text': '${data.trial_line}'},
    {'type': 'TextBody', 'markdown': True, 'text': '✅ A real **+1 767** number\n\n✅ Calls to Dominica - **free**\n\n✅ Set up in about a minute\n\n✅ Uses the free **Cloud Softphone** app'},
    {'type': 'TextBody', 'text': '${data.scope_text}'},
    {'type': 'TextInput', 'name': 'first_name', 'label': 'Your first name', 'helper-text': 'Optional', 'required': False, 'input-type': 'text'},
    {'type': 'TextCaption', 'text': '${data.fine_print}'},
    {'type': 'Footer', 'label': 'Get my free number', 'on-click-action': {'name': 'data_exchange', 'payload': {'first_name': '${form.first_name}', 'confirm': 'yes'}}},
  ]},
}
provisioning = {
  'id': 'PROVISIONING', 'title': 'Creating your number',
  'data': {'provisioning_text': {'type': 'string', '__example__': 'Almost there - this takes a few seconds. Tap Check again.'}},
  'layout': {'type': 'SingleColumnLayout', 'children': [
    img(),
    {'type': 'TextHeading', 'text': '⏳ Creating your number…'},
    {'type': 'TextBody', 'text': '${data.provisioning_text}'},
    {'type': 'Footer', 'label': 'Check again', 'on-click-action': {'name': 'data_exchange', 'payload': {'step': 'check'}}},
  ]},
}
error = {
  'id': 'ERROR', 'title': 'Something went wrong', 'terminal': True, 'success': False,
  'data': {'error_text': {'type': 'string', '__example__': 'We could not set up your line right now. Please reply in the chat and a person will help.'}},
  'layout': {'type': 'SingleColumnLayout', 'children': [
    {'type': 'TextHeading', 'text': '😕 We hit a snag'},
    {'type': 'TextBody', 'text': '${data.error_text}'},
    {'type': 'Footer', 'label': 'Close', 'on-click-action': {'name': 'complete', 'payload': {'status': 'error'}}},
  ]},
}
v8 = {'version': v71['version'], 'data_api_version': v71['data_api_version'],
      'routing_model': {'WELCOME': ['PROVISIONING', 'ERROR'], 'PROVISIONING': ['ERROR'], 'ERROR': []},
      'screens': [welcome, provisioning, error]}
io.open(out, 'w', encoding='utf-8', newline='\n').write(json.dumps(v8, ensure_ascii=False, indent=1))
print('screens:', [s['id'] for s in v8['screens']], '| bytes:', len(json.dumps(v8, ensure_ascii=False).encode()))
