#!/usr/bin/env python3
"""Patch pl-watch v3.4 -> v3.5 (2026-10-15, Lane A): the host-level guards that lived on retiring boxes become pl-watch checks.
  backup freshness  (replaces easypanel-backup's Kuma push + deepseek rsync): /var/lib/host04-backup/last-success must be < 26 h old and last-failure must not be newer
  disk usage        (replaces host03 disk-alert): root filesystem < 85 %
  fiserv image pin  (replaces host03 fiserv-pin-guard): service fiserv_fiserv-api must run a digest-pinned image equal to /etc/pl-watch/fiserv-expected-digest
Each has a PLW_CTRL switch that forces an impossible condition so the instrument can be seen firing. Idempotent; backs up first. Run as root on host04."""
import shutil, time, sys
F = "/usr/local/lib/pl-watch/pl-watch.py"
t = open(F).read()
if "host_guards" in t:
    print("already patched"); sys.exit(0)
shutil.copy2(F, F + ".v3.4-before-host-guards-" + time.strftime("%Y%m%dT%H%MZ", time.gmtime()))
anchor = "if P: did_inventory()\n"
assert t.count(anchor) == 1, "anchor not unique"
block = anchor + '''# v3.5 (2026-10-15, Lane A): host guards moved from retiring boxes. Controls: PLW_CTRL=bk / disk / pin.
def host_guards():
    # backup freshness
    maxh = 0.0001 if "bk" in CTRL else float(os.environ.get("PLW_BACKUP_MAX_HOURS", "26"))
    ls = "/var/lib/host04-backup/last-success"; lf = "/var/lib/host04-backup/last-failure"
    try:
        age_h = (time.time() - os.path.getmtime(ls)) / 3600
        failed_after = os.path.exists(lf) and os.path.getmtime(lf) > os.path.getmtime(ls)
        chk("host04 backup succeeded in the last %s h and no failure since" % ("26" if maxh >= 1 else "0.0001"), age_h <= maxh and not failed_after,
            "last_success_age_h=%.1f failure_after_success=%s (restic -> Wasabi, 02:30 UTC)" % (age_h, failed_after))
    except Exception as e:
        chk("host04 backup has ever succeeded", False, "no success stamp: %s" % type(e).__name__)
    # disk
    lim = 1 if "disk" in CTRL else int(os.environ.get("PLW_DISK_MAX_PCT", "85"))
    pct = sh("df --output=pcent / | tail -1 | tr -dc 0-9")
    chk("root filesystem below %d%%" % lim, pct.isdigit() and int(pct) < lim, "used=%s%%" % pct)
    # fiserv image pin
    exp_f = "/etc/pl-watch/fiserv-expected-digest"
    ref = sh("docker service inspect fiserv_fiserv-api --format '{{.Spec.TaskTemplate.ContainerSpec.Image}}' 2>/dev/null")
    m = re.search(r"@(sha256:[0-9a-f]{64})", ref or ""); actual = m.group(1) if m else ""
    try: expected = open(exp_f).read().strip()
    except Exception: expected = ""
    if "pin" in CTRL: expected = "sha256:" + "0" * 64
    chk("fiserv-api runs its digest-pinned image", bool(actual) and bool(expected) and actual == expected,
        "running=%s expected=%s" % (actual[:19] or "MUTABLE/none", expected[:19] or "(no expected-digest file)"))
if P: host_guards()
'''
open(F, "w").write(t.replace(anchor, block))
print("patched")
