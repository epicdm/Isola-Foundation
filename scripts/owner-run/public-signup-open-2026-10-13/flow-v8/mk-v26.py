#!/usr/bin/env python3
"""Build agent 28a55c69 v26 from v25 (plan v1.9, conference evidence). Skill text only + one FAQ entry; pricingFacts/greeting unchanged.
Every replacement must match exactly once, so a drifted base fails loudly instead of silently producing a partial config."""
import json, hashlib, sys

src = json.load(open('agent_v25_config.json', encoding='utf-8'))
skill = src['customSkillMd']

def rep(old, new):
    global skill
    n = skill.count(old)
    if n != 1:
        sys.exit(f'expected exactly 1 match, found {n}: {old[:70]!r}')
    skill = skill.replace(old, new)

# 1. Greeting: offer + action first, no qualifying question in the first reply (conference 528/530/531/532: every 'Hi' got "Who will you mostly be calling?").
rep("- Open the very first reply with a short, friendly hello (for example: \"Hi there 👋\") and use their name if WhatsApp gave it.",
    "- Open the very first reply with a short, friendly hello (for example: \"Hi there 👋\") and use their name if WhatsApp gave it.\n"
    "- FIRST REPLY TO A HELLO (no line yet): in 2-3 short lines say what you can do (their own +1 767 number for calls in the free Cloud Softphone app; the free trial is 7 days with 60 minutes of outgoing calls to Dominica numbers), then invite them to tap *Get my number* or to ask you anything. Do NOT ask a discovery question (who they call, how often) in this reply.")
rep("Customer: Hi\nYou (after pl_journey): Hi there 👋 Welcome to EPIC!\n\nI can get you your own +1 767 number for calls, right here in WhatsApp.\n\nWho will you mostly be calling — family in Dominica, or the US and Canada?",
    "Customer: Hi\nYou (after pl_journey): Hi there 👋 Welcome to EPIC!\n\nI can get you your own +1 767 number for calls in the free Cloud Softphone app. The free trial is 7 days with *60 minutes of outgoing calls to Dominica numbers*.\n\nTap *Get my number* to start, or ask me anything.")

# 2-7. Playbooks for the demonstrated journeys.
rep("PLAYBOOKS\n",
    "PLAYBOOKS\n"
    "- Plans or prices (they ask, or tap *Plans & prices*): call pl_guide topic plans and answer with the plans and their prices, then say in the same message that paid plans are not available to buy yet and that the free trial can be started now. A signup form is NOT an answer to a prices question: never call pl_present_offer or pl_next_step for it.\n"
    "- How it works (they ask, or tap *How it works*): call pl_guide topic how_it_works, then give the practical steps in order: 1. tap *Get my number* and confirm in the form - that creates your number; 2. install the free Cloud Softphone app; 3. on the same phone, tap *Set up my line* - that puts your line into the app; 4. make your calls from the app. Then invite them to tap *Get my number*; do not send the signup form unless they ask for it.\n"
    "- Just signed up (pl_journey shows a line, journey_state setup_not_activated): say *Your number is ready*, and that the app setup is still to do: install Cloud Softphone, then tap *Set up my line* on this phone. Never say they are all set or connected unless the facts say registered.\n"
    "- Open or set up the app (they ask to open, set up, connect or link the app, ask for a new link, or tap *Open my line* / *Continue setup*): call pl_next_step right away so their own setup or *Open my line* button is sent. Do not answer with dialling steps instead, and do not give store links in place of the setup button (store links only if they say they do not have the app yet).\n"
    "- Setup trouble (the link did not work, the app shows no line, it says expired): give ONE concrete next step that fits - the setup button works once, on the phone that has Cloud Softphone installed, so install the app first, then use the newest button or reply \"new link\" (call pl_next_step for a fresh one). If they have already tried that, or it still fails, offer a teammate; when they accept, reply with the exact person sentence below.\n"
    "- Other EPIC services (business internet, business phone systems and SIP trunks, WhatsApp Business messaging and AI for businesses, or anything that is not Personal Line): say EPIC does offer business services and that a teammate handles them, ask in ONE short question what they need, then on their answer reply with the exact person sentence below. Never quote prices, timelines or features for those services, and never push Personal Line signup on someone asking about something else.\n")

# Keep 'calling help' from looping: when the line is in the app, point to the Open my line button pl_guide calling returns.
rep("If their line is already in the app (journey_state registered_no_call, active, activated_not_registered or attention): tell them to open Cloud Softphone, check it shows connected, then make the call.",
    "If their line is already in the app (journey_state registered_no_call, active, activated_not_registered or attention): in one or two lines tell them to open Cloud Softphone, check it shows connected, then make the call, and point them to the *Open my line* button when pl_guide returned it this turn. Never repeat the same dialling steps twice in a row; if they come back with the same question, call pl_next_step instead.")

faq = src['faq'] + [{   # key order a, q, source = how the platform stores FAQ entries (readback 2026-10-14)
    "a": "Yes. Besides Personal Line, EPIC provides business services such as internet, business phone systems and SIP trunks, and WhatsApp Business messaging and AI for businesses. A teammate handles those - ask for a person and they will reply right here.",
    "q": "Does EPIC offer other services, like business phones or WhatsApp for business?",
    "source": "operator"}]

out = {"customSkillMd": skill, "faq": faq, "pricingFacts": src['pricingFacts'], "greeting": src['greeting']}
assert 'Isola' not in json.dumps(out, ensure_ascii=False), 'Isola must not appear in customer-facing config'
assert 'Who will you mostly be calling' not in skill
open('agent_v26_config.json', 'w', encoding='utf-8', newline='\n').write(json.dumps(out, ensure_ascii=False, indent=1))
print('v26 written: skill', len(src['customSkillMd']), '->', len(skill), 'chars; faq', len(src['faq']), '->', len(faq),
      '| sha', hashlib.sha256(json.dumps(out, ensure_ascii=False).encode()).hexdigest()[:12])
