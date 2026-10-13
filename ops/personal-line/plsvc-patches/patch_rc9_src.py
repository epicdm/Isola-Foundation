import re, sys
root = '/home/epicdm/zz-lanea-plsvc-20261009/src-rc9/'
def rw(path, fn):
    p = root + path
    s = open(p, encoding='utf-8').read()
    n = fn(s)
    assert n != s, 'no change: ' + path
    open(p, 'w', encoding='utf-8', newline='').write(n)

# 1. magnus.ts: strict reader (throws; an unreadable CDR must never look like "no calls")
STRICT = '''
/** Last N calls for a Magnus user, STRICT: a Magnus/network error THROWS (the enriched reader above swallows it into []).
 *  Used by the PL concierge recent-calls op so "could not read" is never reported as "no calls". Numbers are returned raw; the caller masks them. */
export async function getMagnusUserCallsStrict(magnusUserId: string, limit = 5): Promise<Array<{ dir: 'in' | 'out'; number: string; durationSec: number; startRaw: string }>> {
  const filter = JSON.stringify([{ type: 'numeric', field: 'id_user', value: magnusUserId, comparison: 'eq' }])
  const res = await magnusRequest('call', 'read', { page: '1', start: '0', limit: String(limit), sort: 'starttime', dir: 'DESC', filter })
  if (!res || !Array.isArray(res.rows)) throw new Error('magnus_call_read_unexpected_shape')
  return res.rows.map((r: any) => {
    const callerStr = String(r.callerid ?? ''), calledStr = String(r.calledstation ?? '')
    const dir: 'in' | 'out' = calledStr.length < 8 ? 'in' : 'out'
    return { dir, number: dir === 'out' ? calledStr : callerStr, durationSec: parseInt(String(r.real_sessiontime ?? r.sessiontime ?? '0'), 10) || 0, startRaw: String(r.starttime ?? '') }
  })
}
'''
def p_magnus(s):
    marker = "console.warn('[Magnus] getMagnusUserCallsEnriched error:', e.message)\n    return []\n  }\n}\n"
    assert marker in s
    return s.replace(marker, marker + STRICT, 1)
rw('app/lib/magnus.ts', p_magnus)

# 2. http-map: code
def p_map(s):
    return s.replace("  balance:            { http: 200, status: 'ok' },\n", "  balance:            { http: 200, status: 'ok' },\n  recent_calls:       { http: 200, status: 'ok' },\n", 1)
rw('app/lib/pl-concierge/http-map.ts', p_map)

# 3. service.ts
OP = '''// ── /account/recent-calls ────────────────────────────────────────────────────
// Data only (the adapter owns wording). Numbers are masked here, so no raw counterpart number ever leaves the service. A CDR that cannot be READ is known:false, never an empty list.
const maskNum = (n: string): string => { const d = n.replace(/\\D/g, ''); return d.length >= 4 ? `***${d.slice(-4)}` : '***' }
async function recentCalls(ctx: Ctx): Promise<Outcome> {
  const b = await boundAccount(ctx)
  if (b.kind === 'ambiguous') return b.out
  if (b.kind === 'none') return { code: 'no_account' }
  const acc = b.account
  const accountHash = store.idHash(ctx.hashKey, acc.id)
  if (!acc.magnusUserId) return { code: 'recent_calls', detail: 'no_magnus_user', accountHash, data: { known: false, calls: [] } }
  let rows: Awaited<ReturnType<typeof getMagnusUserCallsStrict>> | null = null
  try { rows = await withTimeout(getMagnusUserCallsStrict(acc.magnusUserId, 5), 6000, null) } catch (e: any) { return { code: 'recent_calls', detail: 'cdr_read_failed', accountHash, data: { known: false, calls: [] } } }
  if (rows === null) return { code: 'recent_calls', detail: 'cdr_read_timeout', accountHash, data: { known: false, calls: [] } }
  return { code: 'recent_calls', accountHash, data: { known: true, calls: rows.map(r => ({ dir: r.dir, number_masked: maskNum(r.number), duration_s: r.durationSec, started_raw: r.startRaw })) } }
}

'''
def p_service(s):
    s = s.replace("import { getMagnusUserById, getMagnusOfferIncludedMinutes, requirePlPlusPlanId } from '@/app/lib/magnus'", "import { getMagnusUserById, getMagnusUserCallsStrict, getMagnusOfferIncludedMinutes, requirePlPlusPlanId } from '@/app/lib/magnus'", 1)
    s = s.replace("'account/balance' | 'account/next-step'", "'account/balance' | 'account/recent-calls' | 'account/next-step'", 1)
    s = s.replace("export const READ_ENDPOINTS: Endpoint[] = ['offer', 'account/line-status', 'account/balance', 'lines/status']", "export const READ_ENDPOINTS: Endpoint[] = ['offer', 'account/line-status', 'account/balance', 'account/recent-calls', 'lines/status']", 1)
    s = s.replace("'account/balance': [], 'lines/status': [],", "'account/balance': [], 'account/recent-calls': [], 'lines/status': [],", 1)
    s = s.replace("// ── /lines/status ───", OP + "// ── /lines/status ───", 1)
    s = s.replace("  'account/balance': balance,\n", "  'account/balance': balance,\n  'account/recent-calls': recentCalls,\n", 1)
    return s
rw('app/lib/pl-concierge/service.ts', p_service)
print('patched')
