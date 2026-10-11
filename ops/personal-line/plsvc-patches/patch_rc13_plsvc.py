#!/usr/bin/env python3
# rc13 plsvc: /account/journey carries consent from the ESTATE suppression stores the send gate already uses
# (Contact.doNotContact, WhatsappOptIn revoked - wa-send-gate.ts Step 3), so the proactive path honours a Meta STOP too
# (PM coord-pm-rc12-...-stop-unification 2026-10-10). A read failure is known:false (hold), never "allowed".
import sys, os, shutil
p = os.path.join(sys.argv[1], 'app/lib/pl-concierge/service.ts')
s = open(p, encoding='utf-8').read()
old = "  return { code: 'journey', accountHash: ls.accountHash, data: { ...j, has_line: true, facts, payment } }\n}"
new = """  // rc13: consent from the estate stores the send gate reads (STOP outranks everything). Unreadable -> known:false (callers hold).
  let consent: { estate_suppressed: boolean; known: boolean } = { estate_suppressed: false, known: false }
  try {
    const acct = (b as any).account
    const phones = [ctx.a.wa_id, `+${ctx.a.wa_id}`]
    const [dnc, revoked] = await Promise.all([
      prisma.contact.findFirst({ where: { userId: acct.userId, phone: { in: phones }, doNotContact: true }, select: { id: true } }),
      prisma.whatsappOptIn.findFirst({ where: { userId: acct.userId, phone: { in: phones }, status: 'revoked' }, select: { id: true } }),
    ])
    consent = { estate_suppressed: !!(dnc || revoked), known: true }
  } catch { /* known:false - the proactive path holds */ }
  return { code: 'journey', accountHash: ls.accountHash, data: { ...j, has_line: true, facts, payment, consent } }
}"""
assert s.count(old) == 1, s.count(old)
s = s.replace(old, new)
if not os.path.exists(p + '.pre-rc13'): shutil.copy2(p, p + '.pre-rc13')
open(p, 'w', encoding='utf-8', newline='').write(s)
print('patched service.ts journey consent (rc13)')
