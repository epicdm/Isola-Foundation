root = '/home/epicdm/zz-lanea-plsvc-20261009/src-rc10/'
# 1. service.ts: read-only line status for a Flow session (no link minting, same audit row shape)
p = root + 'app/lib/pl-concierge/service.ts'
s = open(p, encoding='utf-8').read()
OP = """// Read-only registration/status for a Flow session (the ACTIVATE screen's "Check my connection"): lineStatus never mints a link,
// so repeated checks cannot spend the customer's activation-link budget (nextStepGuidance mints/reuses at stage link_ready).
export async function lineStatusForFlow(args: { waId: string; rid: string; mid: string }): Promise<Outcome> {
  const t0 = Date.now()
  const cfg = readConfig(process.env)
  const hashKey = auditHashKey(cfg)
  if (cfg.misconfig.length > 0 || !hashKey) return { code: 'service_disabled' }
  const { randomBytes } = await import('crypto')
  const a: AssertionPayload = { kid: 'flow', wa_id: args.waId, pnid: 'flow', rid: args.rid, mid: args.mid, iat: Math.floor(Date.now() / 1000), nonce: randomBytes(16).toString('base64url') }
  const waIdHash = store.idHash(hashKey, a.wa_id)
  let o: Outcome
  try { o = await lineStatus({ a, waIdHash, hashKey, body: {} }) } catch (e: any) { console.error(`[pl-concierge] flow line-status internal_error: ${e?.message ?? e}`); o = { code: 'internal_error' } }
  await store.writeAudit({
    endpoint: 'account/line-status', op: o.op ?? null, httpStatus: envelope(o.code, o.data ?? {}, null).http, code: o.code, detail: o.detail ?? null,
    kid: 'flow', pnid: null, rid: a.rid, mid: a.mid, waIdHash, waLast4: a.wa_id.slice(-4), accountHash: o.accountHash ?? null, already: o.already ?? null, latencyMs: Date.now() - t0,
  }).catch((e: any) => console.error(`[pl-concierge] flow audit write failed: ${e?.message}`))
  return o
}

"""
anchor = "// ── The pipeline ───"
assert anchor in s and 'lineStatusForFlow' not in s
s = s.replace(anchor, OP + anchor, 1)
open(p, 'w', encoding='utf-8', newline='').write(s)

# 2. signup-flow.ts: ACTIVATE "check" uses the read-only status; the engine (which may mint) runs only when registered (stage connected = no mint) or for an explicit fresh link
p = root + 'app/lib/pl-concierge/signup-flow.ts'
s = open(p, encoding='utf-8').read()
old = """  if (action === 'data_exchange' && screen === 'ACTIVATE') {
    const prev = ourLink(data?.activation_url)
    return stepScreen(claims, data?.fresh === 'yes' ? 'resend' : 'status', prev, 'activate')
  }"""
new = """  if (action === 'data_exchange' && screen === 'ACTIVATE') {
    const prev = ourLink(data?.activation_url)
    if (data?.fresh === 'yes') return stepScreen(claims, 'resend', prev, 'activate')
    // "Check my connection": READ-ONLY (no link minted, no budget spent). Registered -> the engine, whose connected stage mints nothing.
    const { lineStatusForFlow } = await import('@/app/lib/pl-concierge/service')
    const st: any = await lineStatusForFlow({ waId: claims.wa, rid: claims.cw, mid: `flow:${claims.n}` })
    const reg = st?.data?.registration
    if (st?.code === 'line_status' && (['registered', 'reachable', 'lagged'].includes(reg) || st?.data?.first_call_done === true)) return stepScreen(claims, 'status', prev, 'activate')
    if (st?.code !== 'line_status') return activateScreen(prev, "We couldn't check your connection just now. Open Cloud Softphone and try again in a moment.")
    const handed = st?.data?.softphone_activated === true
    return activateScreen(prev, handed
      ? `Your line has been handed to Cloud Softphone, but we haven't seen your phone connect yet. Open Cloud Softphone and call any Dominica number (767) to test it, then tap "Check my connection" again.`
      : `Your setup link hasn't been opened yet. Tap "Open my setup link" on this phone - Cloud Softphone will open and your line goes in by itself. Then tap "Check my connection".`)
  }"""
assert old in s
s = s.replace(old, new, 1)
open(p, 'w', encoding='utf-8', newline='').write(s)
print('patched rc10f')
