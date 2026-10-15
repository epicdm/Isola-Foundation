"""zz-plsvc-activation-enable: PM v1.8 (2026-10-14, owner decision dec-owner-pl-remove-temporary-pilot-limits-prepare-live-2026-10-14) authorizes ONE env change on EasyPanel uplink/plsvc-app:
add exactly LITE_ACTIVATION_ENABLED=true (lib/lite-activation.ts activationEnabled() requires === 'true'), then redeploy that one service.
  python zz-plsvc-activation-enable.py            -> snapshot (names + sha8 of each value, written beside this script, values never printed), add the one line, diff (only that key may differ), deploy
  REVERSE=1 python zz-plsvc-activation-enable.py  -> the prepared rollback: remove only that line, diff, deploy
Never prints env values. Two execute_destructive calls (updateAppEnv, deployAppService)."""
import os, sys, json, hashlib, importlib.util
here = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("epc", os.path.join(here, "zz-migrate-02-ep-client.py")); epc = importlib.util.module_from_spec(spec); spec.loader.exec_module(epc)
REVERSE = os.environ.get("REVERSE") == "1"
epc.rpc("initialize", {"protocolVersion": "2025-03-26", "capabilities": {}, "clientInfo": {"name": "lane-a-activation-enable", "version": "1"}})
epc.assert_host04()
P = {"projectName": "uplink", "serviceName": "plsvc-app"}
KEY = "LITE_ACTIVATION_ENABLED"
def insp():
    st, sc = epc.tool("execute_query", {"procedure": "inspectAppService", "input": P}); assert st == 200
    return epc.unwrap(sc)
def parse(e): return dict(l.split("=", 1) for l in e.splitlines() if "=" in l)
def h8(v): return hashlib.sha256(v.encode()).hexdigest()[:8]
cur = insp(); before = cur["env"]; b = parse(before)
print("BEFORE env names (%d):" % len(b), sorted(b))
print("BEFORE image:", cur["source"]["image"], "| replicas:", cur["deploy"]["replicas"], "| zeroDowntime:", cur["deploy"]["zeroDowntime"])
snap = {k: h8(v) for k, v in b.items()}
open(os.path.join(here, "zz-plsvc-activation-enable.pre-snapshot.%s.json" % ("rollback" if REVERSE else "enable")), "w").write(json.dumps({"names_sha8": snap, "image": cur["source"]["image"]}, indent=1))
nonenv_before = json.dumps(epc.redact({k: v for k, v in cur.items() if k != "env"}), sort_keys=True)
lines = before.splitlines()
if REVERSE:
    assert KEY in b, "variable not present; nothing to roll back"
    new = "\n".join(l for l in lines if not l.startswith(KEY + "=")) + ("\n" if before.endswith("\n") else "")
else:
    assert KEY not in b, "variable already present; refusing"
    new = before.rstrip("\n") + "\n" + KEY + "=true" + ("\n" if before.endswith("\n") else "")
st, sc = epc.tool("execute_destructive", {"procedure": "updateAppEnv", "input": {**P, "env": new}}); print("updateAppEnv ->", st, json.dumps(epc.redact(sc))[:100]); assert st == 200
a = parse(insp()["env"]); diff = sorted(k for k in set(a) | set(b) if a.get(k) != b.get(k)); print("env keys:", len(b), "->", len(a), "| differing:", diff); assert diff == [KEY], diff
if not REVERSE: assert a[KEY] == "true"
mid = json.dumps(epc.redact({k: v for k, v in insp().items() if k != "env"}), sort_keys=True)
assert mid == nonenv_before, "non-env definition changed after env update; NOT deploying"
st, sc = epc.tool("execute_destructive", {"procedure": "deployAppService", "input": P}); print("deployAppService ->", st, json.dumps(epc.redact(sc))[:100]); assert st == 200
print("non-env definition identical before/after deploy:", mid == json.dumps(epc.redact({k: v for k, v in insp().items() if k != "env"}), sort_keys=True))
