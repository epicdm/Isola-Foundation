root = '/home/epicdm/zz-lanea-plsvc-20261009/src-rc10/'
p = root + 'app/lib/pl-concierge/service.ts'
s = open(p, encoding='utf-8').read()
OP = """// ── Flow sessions: the SAME next-step engine for the onboarding WhatsApp Flow ──
// The Flow endpoint has no PL assertion; its identity is the wa_id inside a flow_token the SERVER signed for the verified sender
// (flow-token.ts). This runs nextStepGuidance with that wa_id and writes the SAME audit row the chat path writes, so the per-hour
// activation-link limit (countRecent over 'account/next-step' audit rows) and every other rule apply to Flow users unchanged.
export async function nextStepForFlow(args: { waId: string; rid: string; mid: string; event: 'status' | 'installed' | 'resend' }): Promise<Outcome> {
  const t0 = Date.now()
  const cfg = readConfig(process.env)
  const hashKey = auditHashKey(cfg)
  if (cfg.misconfig.length > 0 || !hashKey) return { code: 'service_disabled' }
  const { randomBytes } = await import('crypto')
  const a: AssertionPayload = { kid: 'flow', wa_id: args.waId, pnid: 'flow', rid: args.rid, mid: args.mid, iat: Math.floor(Date.now() / 1000), nonce: randomBytes(16).toString('base64url') }
  const waIdHash = store.idHash(hashKey, a.wa_id)
  let o: Outcome
  try { o = await nextStepGuidance({ a, waIdHash, hashKey, body: { event: args.event } }) } catch (e: any) { console.error(`[pl-concierge] flow next-step internal_error: ${e?.message ?? e}`); o = { code: 'internal_error' } }
  await store.writeAudit({
    endpoint: 'account/next-step', op: o.op ?? null, httpStatus: envelope(o.code, o.data ?? {}, null).http, code: o.code, detail: o.detail ?? null,
    kid: 'flow', pnid: null, rid: a.rid, mid: a.mid, waIdHash, waLast4: a.wa_id.slice(-4), accountHash: o.accountHash ?? null, already: o.already ?? null, latencyMs: Date.now() - t0,
  }).catch((e: any) => console.error(`[pl-concierge] flow audit write failed: ${e?.message}`))
  return o
}

"""
anchor = "// ── The pipeline ───"
assert anchor in s and 'nextStepForFlow' not in s
s = s.replace(anchor, OP + anchor, 1)
open(p, 'w', encoding='utf-8', newline='').write(s)
print('patched service nextStepForFlow')
