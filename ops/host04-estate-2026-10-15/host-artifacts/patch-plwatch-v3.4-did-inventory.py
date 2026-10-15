#!/usr/bin/env python3
"""Patch /usr/local/lib/pl-watch/pl-watch.py: add the Magnus number-inventory check (v3.4). Idempotent. Backs up first. Run as root on host04."""
import shutil, time, sys
F = "/usr/local/lib/pl-watch/pl-watch.py"
t = open(F).read()
if "did_inventory" in t:
    print("already patched"); sys.exit(0)
shutil.copy2(F, F + ".v3.3-before-did-inventory-" + time.strftime("%Y%m%dT%H%MZ", time.gmtime()))
anchor = "if PGC: public_checks()\n"
assert t.count(anchor) == 1, "anchor not unique"
block = anchor + '''# v3.4 (2026-10-15, Lane A): Magnus number inventory. The Personal Line flow draws numbers directly from Magnus (1767818xxxx, activated, unassigned), so the real capacity ceiling is Magnus, not did_pool.
# Probe runs inside plsvc, result cached 600 s (an ERROR only 45 s); a probe error is NOT a finding. PLW_CTRL=did forces an impossible threshold so the instrument can be seen firing.
DIDJS = "/usr/local/lib/pl-watch/did-check.js"; DIDF = "/var/lib/pl-watch/did.json"
def did_inventory():
    mn = 10**6 if "did" in CTRL else int(os.environ.get("PLW_DID_MIN", "15"))
    try: c = json.load(open(DIDF))
    except Exception: c = {"t": 0}
    if time.time() - c.get("t", 0) > (600 if c.get("n") is not None else 45):
        out = sh("docker exec -i %s sh -c 'cd /app && node -' < %s" % (P, DIDJS), 90)
        m = re.search(r"DID_INVENTORY unassigned=(\\d+) assigned=(\\d+) total=(\\d+)", out)
        c = {"t": time.time(), "n": int(m.group(1)) if m else None, "a": int(m.group(2)) if m else None, "raw": out[:80]}
        os.makedirs(os.path.dirname(DIDF), exist_ok=True); json.dump(c, open(DIDF, "w"))
    if c.get("n") is None: PERR.append("number-inventory probe returned no usable answer: %s" % str(c.get("raw")))
    else: chk("unassigned Personal Line numbers in Magnus >= %d" % mn, c["n"] >= mn, "unassigned=%s (upper bound) assigned=%s" % (c["n"], c.get("a")))
if P: did_inventory()
'''
open(F, "w").write(t.replace(anchor, block))
print("patched")
