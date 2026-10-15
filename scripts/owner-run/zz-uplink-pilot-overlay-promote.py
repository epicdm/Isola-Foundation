"""zz-uplink-pilot-overlay-promote: the OWNER-APPROVED (dec-owner-uplink-pilot-overlay-promotion-and-owner-check-approved-2026-10-14, plan v1.4) image-only promotion of
EasyPanel project `uplink` / service `uplink-app-prod`, and its prepared rollback. Mirrors zz-migrate-03 (definition captured in-process, never printed; env shown as NAME(len) only).
  python zz-uplink-pilot-overlay-promote.py            -> updateAppSourceImage to the NEW image, diff (only source.image may differ), then deployAppService (no forceRebuild)
  REVERSE=1 python zz-uplink-pilot-overlay-promote.py  -> the prepared rollback: updateAppSourceImage back to the ghcr digest, then deployAppService
Aborts BEFORE deploying if anything other than source.image changed, or if the starting image is not the expected one."""
import sys, os, json
sys.argv = [sys.argv[0], "x"]
import importlib.util
here = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("epc", os.path.join(here, "zz-migrate-02-ep-client.py"))
epc = importlib.util.module_from_spec(spec); spec.loader.exec_module(epc)

OLD = "ghcr.io/epicdm/isola-seldonframe@sha256:9306368dae177d6f2a69fc59df7d17ad8aa6873571bbccdb9701593aefc03307"
OLD_TAG = "ghcr.io/epicdm/isola-seldonframe:host04-9306368dae17"
# 2026-10-14: the first digest (faa487b8, WorkingDir=/app/packages/crm) crash-looped and was rolled back; the metadata-corrected digest below (WorkingDir=/app) is the owner-approved one.
NEW = os.environ.get("NEW_IMAGE", "localhost:5000/pl/uplink-app@sha256:617d330b17881d165ad80937162f426bb3c816e38188393bb98c009c13ca2bd9")
REVERSE = os.environ.get("REVERSE") == "1"
OLD_TAG = os.environ.get("EXPECT_START_IMAGE", OLD)   # after the 04:01Z rollback the service carries the digest-pinned ghcr form
FROM, TO = (NEW, OLD) if REVERSE else (OLD_TAG, NEW)
P = {"projectName": "uplink", "serviceName": "uplink-app-prod"}
st, raw = epc.rpc("initialize", {"protocolVersion": "2025-03-26", "capabilities": {}, "clientInfo": {"name": "lane-a-promote", "version": "1"}})
assert st == 200, (st, raw)
print("host04 projects:", epc.assert_host04())

def read():
    st, sc = epc.tool("execute_query", {"procedure": "inspectAppService", "input": P})
    assert st == 200, (st, str(sc)[:200])
    r = dict(epc.unwrap(sc)); r.pop("deploymentUrl", None)
    return r

before = read()
print("BEFORE source.image:", before["source"]["image"], "| replicas:", before["deploy"]["replicas"], "| zeroDowntime:", before["deploy"]["zeroDowntime"])
print("BEFORE env:", len(epc.redact({"env": before["env"]})["env"]), "names | mounts:", [(m["hostPath"], m["mountPath"]) for m in before["mounts"]], "| limits:", before["resources"])
if not REVERSE:
    assert before["source"]["image"] == FROM, "unexpected starting image; abort"
    assert before["deploy"]["replicas"] == 1
st, sc = epc.tool("execute_destructive", {"procedure": "updateAppSourceImage", "input": dict(P, image=TO)})
print("updateAppSourceImage ->", st, json.dumps(epc.redact(sc))[:240])
if st != 200: sys.exit(3)
after = read()
def flat(o, p=""):
    if isinstance(o, dict):
        for k, v in o.items(): yield from flat(v, p + "." + k)
    else: yield p, o
b = dict(flat(before)); a = dict(flat(after))
diff = sorted(k for k in set(a) | set(b) if a.get(k) != b.get(k))
print("DIFF keys (before vs after update):", diff)
print("AFTER source.image:", after["source"]["image"])
bad = [k for k in diff if k != ".source.image"]
if bad or after["source"]["image"] != TO:
    print("UNEXPECTED CHANGES ->", bad, "-> NOT deploying"); sys.exit(4)
st, sc = epc.tool("execute_destructive", {"procedure": "deployAppService", "input": P})
print("deployAppService ->", st, json.dumps(epc.redact(sc))[:240])
sys.exit(0 if st == 200 else 5)
