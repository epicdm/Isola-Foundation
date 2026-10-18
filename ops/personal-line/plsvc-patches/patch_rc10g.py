root = '/home/epicdm/zz-lanea-plsvc-20261009/src-rc10/'
# 1. flows/launch: a customer who already holds a line gets the SAME onboarding Flow (it continues their setup; nothing new is created).
p = root + 'app/lib/pl-concierge/service.ts'
s = open(p, encoding='utf-8').read()
old = "  if (b.kind === 'existing') return { code: 'line_exists', accountHash: store.idHash(ctx.hashKey, b.account.id), data: { did_masked: didMasked(b.account.did) } }\n"
assert old in s
s = s.replace(old, "  const existing = b.kind === 'existing' ? b.account : null   // a line holder gets the same Flow: it continues setup, creates nothing\n", 1)
old2 = "  const body = `Free trial: ${o.trial_days} days with ${o.trial_minutes} minutes of Dominica calls, EC$${o.trial_price_xcd}. ${PL_OVERAGE_TEXT} Calls are made and received in the free Cloud Softphone app. ${VOICE_ONLY_DISCLOSURE}`"
assert old2 in s
s = s.replace(old2, "  const body = existing\n    ? `You already have your Isola line ${didPretty(existing.did) ?? ''}. Open this to check your line and finish setting it up in the free Cloud Softphone app - nothing new will be created.`\n    : `Free trial: ${o.trial_days} days with ${o.trial_minutes} minutes of Dominica calls, EC$${o.trial_price_xcd}. ${PL_OVERAGE_TEXT} Calls are made and received in the free Cloud Softphone app. ${VOICE_ONLY_DISCLOSURE}`", 1)
old3 = "  return { code: 'flow_sent', op: 'flows/launch', data: { flow: 'signup', expires_in_min: 60 } }"
assert old3 in s
s = s.replace(old3, "  return { code: 'flow_sent', op: 'flows/launch', accountHash: existing ? store.idHash(ctx.hashKey, existing.id) : undefined, data: { flow: 'signup', expires_in_min: 60, existing_line: !!existing, did_masked: existing ? didMasked(existing.did) : null } }", 1)
open(p, 'w', encoding='utf-8', newline='').write(s)

# 2. Flow INIT / WELCOME for a line holder: greet with THEIR number, never the trial offer.
p = root + 'app/lib/pl-concierge/signup-flow.ts'
s = open(p, encoding='utf-8').read()
old4 = "  if (action === 'INIT') {\n"
assert s.count(old4) == 1
s = s.replace(old4, """  if (action === 'INIT') {
    const held = await existingLine(wa)
    if (held) return { screen: 'WELCOME', data: { offer_text: `You already have your Isola line ${formatDidDisplay(held)}.\\n\\nTap Continue to check your line and finish setting it up in the free Cloud Softphone app. Nothing new will be created.` } }
""", 1)
old5 = "    const name = cleanName(data?.first_name)\n"
assert old5 in s
s = s.replace(old5, """    const name = cleanName(data?.first_name)
    const held = await existingLine(wa)
    if (held) return { screen: 'CONFIRM', data: { first_name: name || 'there', confirm_text: `${name ? name + ', tap' : 'Tap'} below to continue with your line ${formatDidDisplay(held)}.` } }
""", 1)
helper = """/** The DID of the line this wa_id already holds (read-only binding resolution), or null. */
async function existingLine(wa: string): Promise<string | null> {
  const { resolveExistingBinding } = await import('@/app/lib/lite-signup-identity')
  const b: any = await resolveExistingBinding(wa)
  if (b?.kind !== 'existing' || !b.userId) return null
  const acct = await prisma.liteAccount.findUnique({ where: { userId: b.userId }, select: { did: true } })
  return acct?.did ?? null
}

export async function handleSignupFlow("""
assert s.count("export async function handleSignupFlow(") == 1
s = s.replace("export async function handleSignupFlow(", helper, 1)
open(p, 'w', encoding='utf-8', newline='').write(s)
print('patched rc10g')
