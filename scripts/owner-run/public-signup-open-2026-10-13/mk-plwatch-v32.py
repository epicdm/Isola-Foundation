#!/usr/bin/env python3
# pl-watch v3.1 -> v3.2: a probe ERROR is its own status (probe_error), never reported as a false-charge finding.
# Incident 2026-10-13 15:12-15:30Z: host04 egressed from the wrong IP, Magnus answered 'invalid IP', the false-charge probe printed CDR_CHECK_ERROR, and pl-watch showed
# 'FAIL no charge on a trial-covered call' for 10 minutes (the error was cached for 600 s). That was an instrument fault shown as a finding about the world.
# Changes (all anchor-asserted, exactly once):
#   1. the cdr probe cache is 600 s only for a GOOD answer; an error is cached 45 s
#   2. an unusable probe answer becomes PROBE_ERROR (printed, not counted as FAIL, never named 'no charge on a trial-covered call')
#   3. a probe_error that persists 3 consecutive runs (about 6 minutes) alerts ONCE under its own message 'PROBE ERROR (instrument, not a charge finding)', and recovers with the rest
#   4. self-test: PLW_CTRL=perr forces an error answer (positive control: the new status fires, and a real FAIL elsewhere is still FAIL)
# usage: python3 mk-plwatch-v32.py <pl-watch.v3.py> <out pl-watch.v3.2.py>
import io, sys, hashlib
src, out = sys.argv[1], sys.argv[2]
s = io.open(src, encoding='utf-8', newline='').read()
base12 = hashlib.sha256(s.encode('utf-8')).hexdigest()[:12]
def rep(old, new):
    global s
    assert s.count(old) == 1, f'anchor count {s.count(old)}: {old[:80]}'
    s = s.replace(old, new)

rep('''        if time.time() - c.get("t", 0) > 600:
            out = sh("docker exec -i %s sh -c 'cd /app && node -' < %s" % (P, CDR), 60)
            m = re.search(r"CDR_CHECK n=(\\d+) mode=(\\w+)", out); c = {"t": time.time(), "n": int(m.group(1)) if m else None, "raw": out[:80]}
            os.makedirs(os.path.dirname(CF), exist_ok=True); json.dump(c, open(CF, "w"))
        chk("no charge on a trial-covered call (bundle prefix, trial active, bundle minutes remaining)", c.get("n") == 0, "covered_calls_billed_24h=%s%s" % (c.get("n"), "" if c.get("n") is not None else " probe=" + str(c.get("raw"))))''',
'''        if time.time() - c.get("t", 0) > (600 if c.get("n") is not None else 45):   # v3.2: a GOOD answer is cached 600 s, an ERROR only 45 s
            out = sh("docker exec -i %s sh -c 'cd /app && node -' < %s" % (P, CDR), 60)
            if "perr" in CTRL: out = "CDR_CHECK_ERROR invalid IP (induced by PLW_CTRL=perr, self-test)"
            m = re.search(r"CDR_CHECK n=(\\d+) mode=(\\w+)", out); c = {"t": time.time(), "n": int(m.group(1)) if m else None, "raw": out[:80]}
            os.makedirs(os.path.dirname(CF), exist_ok=True); json.dump(c, open(CF, "w"))
        if c.get("n") is None: PERR.append("false-charge probe returned no usable answer: %s" % str(c.get("raw")))   # v3.2: probe_error is NOT a charge finding
        else: chk("no charge on a trial-covered call (bundle prefix, trial active, bundle minutes remaining)", c.get("n") == 0, "covered_calls_billed_24h=%s" % c.get("n"))''')

# PERR list declared next to checks
rep('def chk(name, ok, detail=""): checks.append((name, bool(ok), detail))',
    'PERR = []   # v3.2: instrument errors (probe_error), kept apart from findings\ndef chk(name, ok, detail=""): checks.append((name, bool(ok), detail))')

# print probe errors distinctly in the listing
rep('print("INFO " + info)\nif DRY:',
    'for e in PERR: print("PROBE_ERROR (instrument, not a charge finding) | " + e)\nprint("INFO " + info)\nif DRY:')

# persistence of the probe_error streak + distinct alert after 3 consecutive runs
rep('st = load_state(); now = time.time(); names = sorted(n for n, _ in fails)',
    'st = load_state(); now = time.time()\nperr_n = (int(st.get("perr", 0)) + 1) if PERR else 0\nif perr_n >= 3: fails.append(("PROBE ERROR (instrument, not a charge finding): false-charge probe has had no usable answer for %d runs" % perr_n, PERR[0]))\nnames = sorted(n for n, _ in fails)')
rep('    if sent or os.path.exists(RECIP): st.update({"failing": names, "last_mail": now}); json.dump(st, open(STATE, "w"))',
    '    if sent or os.path.exists(RECIP): st.update({"failing": names, "last_mail": now})\nst["perr"] = perr_n; json.dump(st, open(STATE, "w"))')
io.open(out, 'w', encoding='utf-8', newline='').write(s)
print('base sha12', base12, 'new sha12', hashlib.sha256(s.encode('utf-8')).hexdigest()[:12])
