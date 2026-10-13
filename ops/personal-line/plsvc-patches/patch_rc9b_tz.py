p = '/home/epicdm/zz-lanea-plsvc-20261009/src-rc9/app/lib/pl-concierge/service.ts'
s = open(p, encoding='utf-8').read()
old = "calls: rows.map(r => ({ dir: r.dir, number_masked: maskNum(r.number), duration_s: r.durationSec, started_raw: r.startRaw })) } }"
new = "calls: rows.map(r => ({ dir: r.dir, number_masked: maskNum(r.number), duration_s: r.durationSec, started_at: magnusTimeToIso(r.startRaw) })) } }"
assert old in s
s = s.replace(old, new, 1)
helper = """// Magnus (voice03) stores call start times as naive local wall-clock in America/Jamaica (UTC-5, no DST) - measured 2026-10-10:
// voice03 `timedatectl` = America/Jamaica, MySQL time_zone = SYSTEM (EST). Shown raw, every call would read an hour early in Dominica (UTC-4).
const MAGNUS_UTC_OFFSET = '-05:00'
const magnusTimeToIso = (raw: string): string | null => {
  const m = /^(\\d{4}-\\d{2}-\\d{2})[ T](\\d{2}:\\d{2})(:\\d{2})?/.exec(raw)
  if (!m) return null
  const d = new Date(`${m[1]}T${m[2]}${m[3] ?? ':00'}${MAGNUS_UTC_OFFSET}`)
  return Number.isFinite(d.getTime()) ? d.toISOString() : null
}
"""
anchor = "async function recentCalls(ctx: Ctx): Promise<Outcome> {"
assert anchor in s
s = s.replace(anchor, helper + anchor, 1)
open(p, 'w', encoding='utf-8', newline='').write(s)
print('patched tz')
