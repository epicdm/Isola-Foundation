p = '/home/epicdm/zz-lanea-plsvc-20261009/src-rc9/app/lib/pl-concierge/service.ts'
s = open(p, encoding='utf-8').read()
old_c = """// Magnus (voice03) stores call start times as naive local wall-clock in America/Jamaica (UTC-5, no DST) - measured 2026-10-10:
// voice03 `timedatectl` = America/Jamaica, MySQL time_zone = SYSTEM (EST). Shown raw, every call would read an hour early in Dominica (UTC-4).
const MAGNUS_UTC_OFFSET = '-05:00'"""
new_c = """// Magnus CDR start times are naive UTC, although voice03's OS and MySQL clocks are America/Jamaica (EST). Measured 2026-10-10 16:27Z:
// newest pkg_cdr.starttime 16:22:45 vs UTC_TIMESTAMP() 16:27:47 and NOW() 11:27:47 - a local reading would put the call 5 h in the future.
// (A first version assumed Jamaica time and placed the owner's calls in the future; caught by checking the result against the clock.)
const MAGNUS_UTC_OFFSET = 'Z'"""
assert old_c in s
s = s.replace(old_c, new_c, 1)
open(p, 'w', encoding='utf-8', newline='').write(s)
print('patched tz -> UTC')
