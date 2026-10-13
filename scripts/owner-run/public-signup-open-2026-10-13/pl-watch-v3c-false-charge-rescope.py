F='/usr/local/lib/pl-watch/pl-watch.py'; s=open(F,encoding='utf8').read()
a=s.index('    CDR = "/usr/local/lib/pl-watch/cdr-check.js"')
b=s.index('if PGC: public_checks()')
NEW = '''    CDR = "/usr/local/lib/pl-watch/cdr-check.js"; CF = "/var/lib/pl-watch/cdr.json"
    if "cdr" in CTRL:
        out = sh("docker exec -i %s sh -c 'cd /app && node - --control' < %s" % (P, CDR), 60)
        for ln in out.splitlines():
            if ln.startswith("CASE "):
                nm, _, res = ln[5:].rpartition(": ")
                chk("false-charge control %s" % nm, res.strip() != "ALARM", "result=%s" % res.strip())   # an ALARM case shows as FAIL (the instrument fired); silent cases show OK
        if "CASE" not in out: chk("false-charge control ran", False, "no output: %s" % out[:80])
    else:
        try: c = json.load(open(CF))
        except Exception: c = {"t": 0}
        if time.time() - c.get("t", 0) > 600:
            out = sh("docker exec -i %s sh -c 'cd /app && node -' < %s" % (P, CDR), 60)
            m = re.search(r"CDR_CHECK n=(\\d+) mode=(\\w+)", out); c = {"t": time.time(), "n": int(m.group(1)) if m else None, "raw": out[:80]}
            os.makedirs(os.path.dirname(CF), exist_ok=True); json.dump(c, open(CF, "w"))
        chk("no charge on a trial-covered call (bundle prefix, trial active, bundle minutes remaining)", c.get("n") == 0, "covered_calls_billed_24h=%s%s" % (c.get("n"), "" if c.get("n") is not None else " probe=" + str(c.get("raw"))))
'''
s=s[:a]+NEW+s[b:]
open(F,'w',encoding='utf8').write(s); print("pl-watch false-charge check re-scoped")
