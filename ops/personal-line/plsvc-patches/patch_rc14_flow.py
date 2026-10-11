#!/usr/bin/env python3
# rc14 (owner walk 2026-10-11): Flow v7 server side for app/lib/pl-concierge/signup-flow.ts, in the ISOLATED copy src-rc14.
#  1. CONFIRM answers within Meta's data_exchange limit: provisionLine is raced against 6.5 s; if it has not finished, the answer is
#     the new PROVISIONING screen while the SAME single provisioning keeps running (its own lock/idempotency unchanged). Measured
#     2026-10-11 04:25:17Z: CONFIRM took 10.92 s -> the client showed an error although the line was created.
#  2. PROVISIONING "Continue": the existing line -> LINE_READY; still running -> PROVISIONING again; failed -> ERROR. Never starts a line.
#  3. INSTALL is a chooser (iPhone / Android / already have it); INSTALL_STORE shows the official store badge + numbered steps + link.
import sys, re
p = sys.argv[1]
t = open(p, encoding='utf-8').read()
orig = t

def sub(old, new, count=1):
    global t
    assert t.count(old) == count, f'expected {count}x: {old[:90]!r} (found {t.count(old)})'
    t = t.replace(old, new)

# --- imports: badges module
sub("import type { FlowTokenClaims } from '@/app/lib/pl-concierge/flow-token'\n",
    "import type { FlowTokenClaims } from '@/app/lib/pl-concierge/flow-token'\nimport { STORE_BADGE_IOS_B64, STORE_BADGE_ANDROID_B64 } from '@/app/lib/pl-concierge/flow-store-badges'\n")

# --- INSTALL screen: chooser (no data), store screen builder
sub("""    return { screen: 'INSTALL', data: {
      install_text: `${lead}\\n\\nWhen it's on your phone (or if you already have it), tap "I've installed it". Please don't tap it before - the setup link only does its job once the app is installed.`,
      ios_url: String(links.ios || 'https://apps.apple.com/us/app/cloud-softphone/id567475545'),
      android_url: String(links.android || 'https://play.google.com/store/apps/details?id=cz.acrobits.softphone.cloudphone'),
    } }""",
"""    void lead // rc14: the INSTALL screen is a phone-type chooser; the copy moved to INSTALL_STORE (storeScreen)
    return { screen: 'INSTALL', data: {} }""")

sub("function activateScreen(url: string, text: string) {",
"""/** rc14: the per-phone store screen - official badge, numbered steps, the store link marked with 👉. */
export function storeScreen(os: 'ios' | 'android', links: { ios?: string; android?: string } = {}) {
  const ios = os === 'ios'
  const url = ios ? String(links.ios || 'https://apps.apple.com/us/app/cloud-softphone/id567475545') : String(links.android || 'https://play.google.com/store/apps/details?id=cz.acrobits.softphone.cloudphone')
  const label = ios ? '👉 Open the App Store' : '👉 Open Google Play'
  return { screen: 'INSTALL_STORE', data: {
    badge_img: ios ? STORE_BADGE_IOS_B64 : STORE_BADGE_ANDROID_B64,
    store_url: url,
    store_label: label,
    install_md: `**1.** Tap **${label.replace('👉 ', '')}** below\\n\\n**2.** Install **Cloud Softphone** - it's free\\n\\n**3.** Come back to WhatsApp and tap **I've installed it**\\n\\nPlease don't tap it before the app is installed - your setup link only works once the app is on your phone.`,
  } }
}
function activateScreen(url: string, text: string) {""")

# --- CONFIRM: race provisioning against the Meta answer window
sub("""    console.log(`${tag} CONFIRM -> provisioning (single attempt, idempotent per user)`)
    const result: any = await provisionLine(identity.userId, wa, 'flow', undefined, false, undefined, { trialGrant: 'background' })
    if (result?.pending) {""",
"""    console.log(`${tag} CONFIRM -> provisioning (single attempt, idempotent per user)`)
    const running = provisionLine(identity.userId, wa, 'flow', undefined, false, undefined, { trialGrant: 'background' })
    provisioningRuns.set(wa, { state: 'running', at: Date.now() })
    running.then((r: any) => provisioningRuns.set(wa, r?.status === 200 && r?.did ? { state: 'done', at: Date.now() } : { state: 'failed', at: Date.now(), message: r?.pending ? 'pending' : String(r?.body?.message ?? '') }),
      () => provisioningRuns.set(wa, { state: 'failed', at: Date.now(), message: '' }))
    const raced: any = await Promise.race([running.then((r: any) => ({ r }), () => ({ r: null })), new Promise((res) => setTimeout(() => res(null), PROVISION_ANSWER_MS))])
    if (raced === null) {
      console.log(`${tag} provisioning still running after ${PROVISION_ANSWER_MS} ms -> PROVISIONING screen (the same single attempt continues)`)
      return { screen: 'PROVISIONING', data: { provisioning_text: "We're creating your number right now - it takes a few more seconds. Tap Continue in a moment." } }
    }
    const result: any = raced.r
    if (result?.pending) {""")

# --- PROVISIONING / INSTALL / INSTALL_STORE handlers
sub("""  if (action === 'data_exchange' && screen === 'INSTALL') return stepScreen(claims, 'installed', '', 'install')""",
"""  if (action === 'data_exchange' && screen === 'PROVISIONING') {
    // READ-ONLY: never starts a line. The line exists -> show it; the single attempt is still running -> wait; it failed -> say so.
    const did = await existingLine(wa)
    if (did) return { screen: 'LINE_READY', data: { did_display: formatDidDisplay(did), line_text: 'Your Isola line has been created. Next you install the free Cloud Softphone app and set your line up in it - tap Continue.' } }
    const run = provisioningRuns.get(wa)
    if (run?.state === 'running' && Date.now() - run.at < 120_000) return { screen: 'PROVISIONING', data: { provisioning_text: 'Almost there - your number is still being set up. Tap Continue again in a few seconds.' } }
    if (run?.state === 'failed' && run.message === 'pending') return err('We are still confirming your line. Please do not start again - reply in the chat and we will update you.')
    return err('We could not finish setting up your line. Please reply in the chat and a person will help - nothing was charged.')
  }
  if (action === 'data_exchange' && screen === 'INSTALL') {
    if (data?.step === 'store' && (data?.os === 'ios' || data?.os === 'android')) {
      const { nextStepForFlow } = await import('@/app/lib/pl-concierge/service')
      let links: any = {}
      try { const o: any = await nextStepForFlow({ waId: claims.wa, rid: claims.cw, mid: `flow:${claims.n}`, event: 'status' }); links = o?.data?.store_links ?? {} } catch { /* fallback store URLs */ }
      return storeScreen(data.os, links)
    }
    return stepScreen(claims, 'installed', '', 'install')
  }
  if (action === 'data_exchange' && screen === 'INSTALL_STORE') return stepScreen(claims, 'installed', '', 'install')""")

# --- module-level state + constant (after the PAUSED constant)
sub("const PAUSED = ",
"""// rc14: Meta's data_exchange answer window is ~10 s end to end; answer CONFIRM within 6.5 s and let the single attempt continue.
export const PROVISION_ANSWER_MS = Number(process.env.PL_FLOW_PROVISION_ANSWER_MS || 6500)
// Outcome of the one in-flight provisioning per WhatsApp sender (this process; plsvc runs one replica). Read by PROVISIONING only.
const provisioningRuns = new Map<string, { state: 'running' | 'done' | 'failed'; at: number; message?: string }>()
const PAUSED = """)

assert t != orig
open(p, 'w', encoding='utf-8').write(t)
print('patched', p)
