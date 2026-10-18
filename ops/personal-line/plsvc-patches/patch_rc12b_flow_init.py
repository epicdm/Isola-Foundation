#!/usr/bin/env python3
# rc12b: Meta's client REFUSES an INIT response whose first screen has incoming routing edges ("Unexpected screen: the first screen
# [CONNECTED] ... already has incoming nodes in the routing model", preview 2026-10-10 22:3xZ). A line holder must open on WELCOME;
# WELCOME now shows THEIR live status + the three balance facts instead of jumping screens. Run on the isolated src-rc12 copy.
import sys, os
p = os.path.join(sys.argv[1], 'app/lib/pl-concierge/signup-flow.ts')
s = open(p, encoding='utf-8').read()
old = """    if (held) {
      // rc12: never walk a line holder through signup again - open on the step the next-step engine reads now
      // (CONNECTED with balance for a working line). Any failure falls back to the existing-line welcome.
      const s = await stepScreen(claims, 'status', '', 'line').catch(() => null)
      if (s && s.screen && s.screen !== 'ERROR') return s
      return { screen: 'WELCOME', data: { offer_text: `You already have your Isola line ${formatDidDisplay(held)}.\\n\\nTap Continue to check your line and finish setting it up in the free Cloud Softphone app. Nothing new will be created.` } }
    }
"""
new = """    if (held) {
      // rc12b: a line holder opens on WELCOME (Meta refuses a first screen that has incoming routing edges), and WELCOME shows
      // THEIR line: live status from the read-only line-status engine + the three balance facts. Never signup copy.
      let status = 'Tap Continue to check your connection and setup.'
      try {
        const { lineStatusForFlow } = await import('@/app/lib/pl-concierge/service')
        const st: any = await lineStatusForFlow({ waId: claims.wa, rid: claims.cw, mid: `flow:${claims.n}:init` })
        const d = st?.code === 'line_status' ? (st.data ?? {}) : null
        if (d) status = d.first_call_done === true ? 'Your line is working - your first call went through.'
          : ['registered', 'reachable', 'lagged'].includes(d.registration) ? 'Your phone is connected. Next step: make your first call from Cloud Softphone.'
          : d.softphone_activated === true ? "Your line is in Cloud Softphone, but your phone isn't connected right now. Tap Continue to check it."
          : 'Next step: set your line up in the free Cloud Softphone app - tap Continue.'
      } catch { /* the line and balance below still stand */ }
      const b = await balanceFacts(claims)
      return { screen: 'WELCOME', data: { offer_text: `Your Isola line ${formatDidDisplay(held)}\\n\\n${status}\\n\\n${b.minutes_text}\\n${b.expiry_text}\\n${b.wallet_text}\\n\\nNothing new will be created.` } }
    }
"""
assert s.count(old) == 1, s.count(old)
s = s.replace(old, new)
open(p, 'w', encoding='utf-8', newline='').write(s)
print('patched signup-flow INIT (rc12b)')
