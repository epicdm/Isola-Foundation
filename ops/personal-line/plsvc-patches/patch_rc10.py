import sys
root = '/home/epicdm/zz-lanea-plsvc-20261009/src-rc10/'
def rw(path, fn):
    p = root + path
    s = open(p, encoding='utf-8').read()
    n = fn(s)
    assert n != s, 'no change: ' + path
    open(p, 'w', encoding='utf-8', newline='').write(n)

# ── 1. Flow route: raw body + Meta signature (log|enforce), signed-token signup branch ──
def p_route(s):
    imp = "import { digitsOnly, ownerPhoneWhere, OWNER_PHONE_NEWEST_FIRST } from '@/app/lib/lite-owner-phone'\n"
    assert imp in s
    s = s.replace(imp, imp + "import { isSignedFlowToken, verifyFlowToken, checkMetaSignature } from '@/app/lib/pl-concierge/flow-token'\nimport { handleSignupFlow } from '@/app/lib/pl-concierge/signup-flow'\n", 1)
    old = """  let body: any
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }
"""
    new = """  let body: any
  let rawBody = ''
  try {
    rawBody = await req.text()
    body = JSON.parse(rawBody)
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  // META REQUEST SIGNATURE (X-Hub-Signature-256, app secret). FLOW_SIGNATURE_MODE=enforce refuses anything not signed by
  // Meta with 432 (Meta's documented status for a failed signature); any other value only LOGS the result, so the secret
  // can be proven against real Meta traffic before it is enforced (a wrong secret would otherwise take every Flow down).
  const sig = checkMetaSignature(rawBody, req.headers.get('x-hub-signature-256'), process.env.META_APP_SECRET)
  if (process.env.FLOW_SIGNATURE_MODE === 'enforce' && sig !== 'valid' && !(body?.action === 'ping' && !body?.encrypted_flow_data)) {
    console.warn('[flows] signature %s - refused (enforce)', sig)
    return new NextResponse('Signature verification failed', { status: 432 })
  }
"""
    assert old in s
    s = s.replace(old, new, 1)
    old2 = "  console.log('[flows] action=%s screen=%s token=%s', action, screen, flow_token ? String(flow_token).slice(0, 12) : 'none')\n"
    assert old2 in s
    s = s.replace(old2, "  console.log('[flows] action=%s screen=%s token=%s sig=%s', action, screen, flow_token ? String(flow_token).slice(0, 12) : 'none', sig)\n", 1)
    old3 = "    if (isOdooTaskFlow) {\n"
    assert s.count(old3) == 1
    new3 = """    if (isSignedFlowToken(flow_token)) {
      // Personal Line signup Flow v3 (signed token; identity = the wa_id the SERVER sent the Flow to).
      const chk = verifyFlowToken(flow_token, 'signup')
      if (!chk.ok) {
        console.warn('[flows/signup] token refused: %s', chk.why)
        response = { screen: 'ERROR', data: { error_message: chk.why === 'expired' ? 'This signup form has expired. Send us a message and we will send a new one.' : 'We could not verify this form. Please start again from the chat.' } }
      } else {
        response = await handleSignupFlow({ action, screen, data, claims: chk.claims })
      }

    } else if (isOdooTaskFlow) {
"""
    s = s.replace(old3, new3, 1)
    return s
rw('app/api/whatsapp/flows/route.ts', p_route)

# ── 2. whatsapp.ts: sendPlSignupFlow (same gate + dispatch as sendLiteOnboardingFlow; explicit sender, no fallback to 3742) ──
SENDER = """
// ── WhatsApp Flows: Personal Line signup v3 (signed flow_token) ───────────────
// Same gate/dispatch as sendLiteOnboardingFlow. Differences: the flow_token is a SIGNED token minted by the PL service for the
// Meta-verified sender (pl-concierge/flow-token.ts), the Flow id comes from PL_SIGNUP_FLOW_ID, and the sender phone is
// PL_FLOW_SENDER_PHONE_ID with NO fallback (the legacy fallback is 3742, the protected public front door - a Personal Line
// Flow must come from the number the customer is talking to).
export async function sendPlSignupFlow(toPhone: string, flowToken: string, bodyText: string, ctx?: Partial<WaSendContext>): Promise<GateDecision> {
  const flowId = process.env.PL_SIGNUP_FLOW_ID || ''
  const phoneId = process.env.PL_FLOW_SENDER_PHONE_ID || ''
  if (!flowId || !phoneId) throw new Error('PL_SIGNUP_FLOW_ID / PL_FLOW_SENDER_PHONE_ID not configured')
  const sendCtx: WaSendContext = {
    purpose: ctx?.purpose ?? 'lite_onboarding',
    senderPath: ctx?.senderPath ?? 'pl:sendPlSignupFlow',
    kind: 'flow',
    recipientPhone: toPhone,
    userId: ctx?.userId,
    agentId: ctx?.agentId,
    sourceEventType: ctx?.sourceEventType,
    sourceEventId: ctx?.sourceEventId,
  }
  const payload = {
    messaging_product: 'whatsapp',
    to: toPhone,
    type: 'interactive',
    interactive: {
      type: 'flow',
      header: { type: 'text', text: 'Get your free number' },
      body: { text: bodyText.slice(0, 1024) },
      footer: { text: 'Isola Personal Line' },
      action: { name: 'flow', parameters: { flow_message_version: '3', flow_id: flowId, flow_cta: 'Start signup', flow_token: flowToken, mode: 'published' } },
    },
  }
  const decision = await dispatchToMeta(payload, phoneId, sendCtx)
  if (!decision.code.startsWith('allow_')) console.warn(`[whatsapp][gate] ${decision.code} - sendPlSignupFlow suppressed: ${decision.reason}`)
  else if (decision.dispatchFailed) console.error('[whatsapp] sendPlSignupFlow dispatch failed')
  else console.log('[whatsapp] PL signup Flow sent via', phoneId)
  return decision
}
"""
def p_wa(s):
    anchor = "// ── WhatsApp Flows: Lite Top-Up ───"
    assert anchor in s
    return s.replace(anchor, SENDER.lstrip('\n') + "\n" + anchor, 1)
rw('app/lib/whatsapp.ts', p_wa)

# ── 3. PL service: flows/launch (assertion-bound; the agent tool calls this) ──
OP = """// ── /flows/launch ────────────────────────────────────────────────────────────
// Sends the Personal Line SIGNUP Meta Flow to the assertion's verified wa_id. A customer who already holds a line is not sent a
// signup form (line_exists). The flow_token is signed and carries the wa_id + the conversation rid, so the Flow endpoint never
// trusts a phone from the request. Data only back to the caller; the Flow's own screens and the interactive body are the copy.
async function flowLaunch(ctx: Ctx): Promise<Outcome> {
  if (ctx.body.flow !== 'signup') return { code: 'invalid_body' }
  const b = await boundAccount(ctx)
  if (b.kind === 'ambiguous') return b.out
  if (b.kind === 'existing') return { code: 'line_exists', accountHash: store.idHash(ctx.hashKey, b.account.id), data: { did_masked: didMasked(b.account.did) } }
  const sent = await store.countRecent(ctx.waIdHash, ['flows/launch'], 3600, ['flow_sent'])
  if (sent >= 3) return { code: 'rate_limited', data: { retry_after_s: 900 } }
  if (!(await store.consumeNonce({ nonce: ctx.a.nonce, op: 'flows/launch', waIdHash: ctx.waIdHash, mid: ctx.a.mid }))) return { code: 'replay', op: 'flows/launch' }
  const offer = await buildOffer()
  const o: any = offer.data ?? {}
  if (offer.code !== 'offer' || !o.trial_days || !o.trial_minutes || o.trial_price_xcd === undefined) return { code: 'offer_unavailable', detail: offer.detail }
  const { mintFlowToken } = await import('@/app/lib/pl-concierge/flow-token')
  const { sendPlSignupFlow } = await import('@/app/lib/whatsapp')
  const token = mintFlowToken({ purpose: 'signup', waId: ctx.a.wa_id, rid: ctx.a.rid })
  const body = `Free trial: ${o.trial_days} days with ${o.trial_minutes} minutes of Dominica calls, EC$${o.trial_price_xcd}. ${PL_OVERAGE_TEXT} Calls are made and received in the free Cloud Softphone app. ${VOICE_ONLY_DISCLOSURE}`
  let decision: any
  try { decision = await sendPlSignupFlow(ctx.a.wa_id, token, body, { senderPath: 'pl:flows/launch' }) } catch (e: any) { return { code: 'flow_unavailable', op: 'flows/launch', detail: String(e?.message ?? e).slice(0, 120) } }
  if (!String(decision?.code ?? '').startsWith('allow_') || decision?.dispatchFailed) return { code: 'flow_unavailable', op: 'flows/launch', detail: `${decision?.code ?? 'no_decision'}${decision?.dispatchFailed ? ':dispatch_failed' : ''}` }
  return { code: 'flow_sent', op: 'flows/launch', data: { flow: 'signup', expires_in_min: 60 } }
}

"""
def p_service(s):
    s = s.replace("'account/recent-calls' | 'account/next-step'", "'account/recent-calls' | 'account/next-step' | 'flows/launch'", 1)
    s = s.replace("  'account/next-step': ['event'],\n", "  'account/next-step': ['event'],\n  'flows/launch': ['flow'],\n", 1)
    s = s.replace("  'account/next-step': nextStepGuidance,\n", "  'account/next-step': nextStepGuidance,\n  'flows/launch': flowLaunch,\n", 1)
    s = s.replace("// ── The pipeline ───", OP + "// ── The pipeline ───", 1)
    if 'PL_OVERAGE_TEXT' not in s.split('async function flowLaunch')[0]:
        s = s.replace("import { PL_FAIR_USE_MINUTES_BY_TIER, isPlTierCode, PL_OVERAGE_RATES_XCD, VOICE_ONLY_DISCLOSURE } from '@/app/lib/lite-offer-text'",
                      "import { PL_FAIR_USE_MINUTES_BY_TIER, isPlTierCode, PL_OVERAGE_RATES_XCD, PL_OVERAGE_TEXT, VOICE_ONLY_DISCLOSURE } from '@/app/lib/lite-offer-text'", 1)
    assert 'flowLaunch,' in s and "'flows/launch': ['flow']" in s and 'PL_OVERAGE_TEXT,' in s
    return s
rw('app/lib/pl-concierge/service.ts', p_service)

def p_map(s):
    a = "  recent_calls:       { http: 200, status: 'ok' },\n"
    assert a in s
    return s.replace(a, a + "  flow_sent:          { http: 200, status: 'ok' },\n  flow_unavailable:   { http: 200, status: 'error' },\n", 1)
rw('app/lib/pl-concierge/http-map.ts', p_map)
print('patched rc10')
