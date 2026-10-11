import re
root = '/home/epicdm/zz-lanea-plsvc-20261009/src-rc10/'
p = root + 'app/lib/wa-send-gate.ts'
s = open(p, encoding='utf-8').read()
# purpose must not be proactive
m = re.search(r"const PROACTIVE_PURPOSES = new Set\(\[(.*?)\]\)", s, re.S)
assert m and "'lite_onboarding'" not in m.group(1), 'lite_onboarding must not be a proactive purpose'
HELPER = """
/**
 * NARROW, AUDITED CARVE-OUT (2026-10-10, owner hard cutover). The PL service's Flow/interactive reply to a customer message whose arrival
 * was PROVEN by a fresh relay-signed PL assertion (verifyAssertion in pl-concierge/service.ts runs before the send; sourceEventId = that
 * inbound wamid, 120 s freshness). Since the 0001 cutover the inbound message lives in Chatwoot, not WhatsAppMessage, so the stored-row
 * check below cannot see it - the signed assertion is the proof that this is a direct reply inside the service window. Meta permits
 * interactive Flow messages in the customer-service window. Only the 'pl:' sender path, only flow/interactive, never a proactive purpose;
 * suppression (STOP / doNotContact) still applies whenever a userId is supplied, and every decision is audited with this sourceEventType.
 */
export function isPlVerifiedInboundReply(ctx: WaSendContext): boolean {
  return ctx.sourceEventType === 'pl_verified_inbound' && !!ctx.sourceEventId && String(ctx.senderPath ?? '').startsWith('pl:')
    && (ctx.kind === 'flow' || ctx.kind === 'interactive') && !PROACTIVE_PURPOSES.has(ctx.purpose)
}

"""
anchor = "export function deriveMessageClass(ctx: WaSendContext): MessageClass {\n"
assert s.count(anchor) == 1
s = s.replace(anchor, HELPER.lstrip('\n') + anchor + "  if (isPlVerifiedInboundReply(ctx)) return 'conversation_reply'\n", 1)
old_ref = "): Promise<{ ok: boolean; reason?: string }> {\n  if (!ctx.sourceEventId || (ctx.sourceEventType !== 'wa_inbound' && ctx.sourceEventType !== 'wa_inbound_conversation')) {"
assert s.count(old_ref) == 1
s = s.replace(old_ref, "): Promise<{ ok: boolean; reason?: string }> {\n  if (isPlVerifiedInboundReply(ctx)) return { ok: true }   // proven by the verified PL assertion (see isPlVerifiedInboundReply)\n  if (!ctx.sourceEventId || (ctx.sourceEventType !== 'wa_inbound' && ctx.sourceEventType !== 'wa_inbound_conversation')) {", 1)
old_pt = "        (ctx.kind === 'interactive' || ctx.kind === 'media' || ctx.kind === 'freeform')\n      if (!isPreTenantReply) {"
assert s.count(old_pt) == 1
s = s.replace(old_pt, "        (ctx.kind === 'interactive' || ctx.kind === 'media' || ctx.kind === 'freeform' || (ctx.kind === 'flow' && isPlVerifiedInboundReply(ctx)))\n      if (!isPreTenantReply) {", 1)
# the Step-1 hard block for flow without userId must not fire for the proven reply (pre-tenant new customer)
old_s1 = "    if (isProactiveKind && !ctx.userId) {"
assert s.count(old_s1) == 1
s = s.replace(old_s1, "    if (isProactiveKind && !ctx.userId && !isPlVerifiedInboundReply(ctx)) {", 1)
open(p, 'w', encoding='utf-8', newline='').write(s)

p = root + 'app/lib/pl-concierge/service.ts'
s = open(p, encoding='utf-8').read()
old = "  try { decision = await sendPlSignupFlow(ctx.a.wa_id, token, body, { senderPath: 'pl:flows/launch' }) }"
assert old in s
s = s.replace(old, "  try { decision = await sendPlSignupFlow(ctx.a.wa_id, token, body, { senderPath: 'pl:flows/launch', userId: existing?.userId, sourceEventType: 'pl_verified_inbound', sourceEventId: ctx.a.mid }) }", 1)
open(p, 'w', encoding='utf-8', newline='').write(s)
print('patched rc10h')
