root = '/home/epicdm/zz-lanea-plsvc-20261009/src-rc10/'
# 1. service.ts: balanceForFlow (same identity-bound balance() the chat tool uses; same audit row shape)
p = root + 'app/lib/pl-concierge/service.ts'
s = open(p, encoding='utf-8').read()
OP = """// Balance for a Flow session: the SAME balance() the chat tool uses (included minutes + plan end from the line's own entitlement,
// wallet credit from Magnus - three separate facts, each null when unread).
export async function balanceForFlow(args: { waId: string; rid: string; mid: string }): Promise<Outcome> {
  const t0 = Date.now()
  const cfg = readConfig(process.env)
  const hashKey = auditHashKey(cfg)
  if (cfg.misconfig.length > 0 || !hashKey) return { code: 'service_disabled' }
  const { randomBytes } = await import('crypto')
  const a: AssertionPayload = { kid: 'flow', wa_id: args.waId, pnid: 'flow', rid: args.rid, mid: args.mid, iat: Math.floor(Date.now() / 1000), nonce: randomBytes(16).toString('base64url') }
  const waIdHash = store.idHash(hashKey, a.wa_id)
  let o: Outcome
  try { o = await balance({ a, waIdHash, hashKey, body: {} }) } catch (e: any) { console.error(`[pl-concierge] flow balance internal_error: ${e?.message ?? e}`); o = { code: 'internal_error' } }
  await store.writeAudit({
    endpoint: 'account/balance', op: o.op ?? null, httpStatus: envelope(o.code, o.data ?? {}, null).http, code: o.code, detail: o.detail ?? null,
    kid: 'flow', pnid: null, rid: a.rid, mid: a.mid, waIdHash, waLast4: a.wa_id.slice(-4), accountHash: o.accountHash ?? null, already: o.already ?? null, latencyMs: Date.now() - t0,
  }).catch((e: any) => console.error(`[pl-concierge] flow audit write failed: ${e?.message}`))
  return o
}

"""
anchor = "// ── The pipeline ───"
assert anchor in s and 'balanceForFlow' not in s
s = s.replace(anchor, OP + anchor, 1)
open(p, 'w', encoding='utf-8', newline='').write(s)

# 2. signup-flow.ts: CONNECTED carries calling help + the three balance facts + support; ERROR uses error_text (error_message renders as a toast)
p = root + 'app/lib/pl-concierge/signup-flow.ts'
s = open(p, encoding='utf-8').read()
old_err = "const err = (message: string) => ({ screen: 'ERROR', data: { error_message: message } })"
assert old_err in s
s = s.replace(old_err, "// error_text, not error_message: Meta renders a data key named error_message as a toast and leaves the screen body empty.\nconst err = (message: string) => ({ screen: 'ERROR', data: { error_text: message } })", 1)
old_c = "    return { screen: 'CONNECTED', data: { connected_text: text } }\n  }\n  if (stage === 'install') {"
assert old_c in s
new_c = """    return { screen: 'CONNECTED', data: { connected_text: text, ...(await balanceFacts(claims)) } }
  }
  if (stage === 'install') {"""
s = s.replace(old_c, new_c, 1)
helper = """/** Three SEPARATE balance facts for the CONNECTED screen. Each is read, never inferred from another; unread = said plainly. */
async function balanceFacts(claims: FlowTokenClaims): Promise<{ minutes_text: string; expiry_text: string; wallet_text: string }> {
  const UNREAD = "Couldn't be read right now - ask in the chat or try again later."
  try {
    const { balanceForFlow } = await import('@/app/lib/pl-concierge/service')
    const o: any = await balanceForFlow({ waId: claims.wa, rid: claims.cw, mid: `flow:${claims.n}` })
    const d = o?.code === 'balance' ? (o.data ?? {}) : {}
    const minutes = d.known === true && d.kind === 'included' && d.minutes_remaining != null && d.minutes_included != null
      ? `${d.minutes_remaining} of ${d.minutes_included} included minutes left`
      : d.known === true && d.kind === 'legacy' && d.minutes_remaining != null ? `${d.minutes_remaining} Dominica minutes left` : UNREAD
    const expiry = d.known === true && d.kind === 'included' && d.expires_date_pretty ? `${d.plan_name ? d.plan_name + ' - ' : ''}ends ${d.expires_date_pretty}`
      : d.known === true && d.kind === 'legacy' ? 'No plan end date on this line' : UNREAD
    const wallet = typeof d.wallet_xcd === 'string' && d.wallet_xcd !== '' ? `EC$${d.wallet_xcd}` : UNREAD
    return { minutes_text: `Included minutes: ${minutes}`, expiry_text: `Plan: ${expiry}`, wallet_text: `Wallet credit: ${wallet}` }
  } catch {
    return { minutes_text: `Included minutes: ${UNREAD}`, expiry_text: `Plan: ${UNREAD}`, wallet_text: `Wallet credit: ${UNREAD}` }
  }
}

/** Map the next-step engine's outcome"""
assert s.count("/** Map the next-step engine's outcome") == 1
s = s.replace("/** Map the next-step engine's outcome", helper, 1)
open(p, 'w', encoding='utf-8', newline='').write(s)
print('patched rc10j')
