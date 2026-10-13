"""zz-migrate-25: PREPARED, NOT RUN (waits for the coordinator go). Digest-pinned deploy of the plsvc admission release (isolav2 branch ops/plsvc-admission-paused-failclosed-2026-10-13, head 4d605a7d, tree fd19ba568c3f5ae4bff7286a466056d6171fc596; image sha256:5acad2e83272754745bf088421fba3e2bf1db390f87cd3259f4a5423aa600115: LITE_ADMISSION_PAUSED + fail-closed compiled defaults) and its rollback to the currently deployed wording release sha256:8d5bbed5611c85065c5679c66161bd3e11ce3cef77daea11652ffd807a80937d. A SEPARATE release from the wording release.
Deploy:   python zz-migrate-25-plsvc-admission-paused-deploy.py        Rollback: REVERSE=1 python zz-migrate-25-plsvc-admission-paused-deploy.py
Two execute_destructive calls on uplink/plsvc-app (updateAppSourceImage then deployAppService); everything except .source.image must stay identical (diffed). Post-deploy checks: zz-wording-verify.sh (enforcement 8/8 + admission flags), zz-relay-verify.sh (door/reachability), zz-plsvc-paused-check.sh (new defaults compiled in, old absent)."""
import os, sys, json, importlib.util
here = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("epc", os.path.join(here, "zz-migrate-02-ep-client.py")); epc = importlib.util.module_from_spec(spec); spec.loader.exec_module(epc)
NEW = "localhost:5000/pl/plsvc@sha256:5acad2e83272754745bf088421fba3e2bf1db390f87cd3259f4a5423aa600115"
PREV = "localhost:5000/pl/plsvc@sha256:8d5bbed5611c85065c5679c66161bd3e11ce3cef77daea11652ffd807a80937d"
rev = os.environ.get("REVERSE") == "1"
epc.rpc("initialize", {"protocolVersion": "2025-03-26", "capabilities": {}, "clientInfo": {"name": "lane-a-plsvc-admission-paused", "version": "1"}})
epc.assert_host04()
P = {"projectName": "uplink", "serviceName": "plsvc-app"}
def snap():
    st, sc = epc.tool("execute_query", {"procedure": "inspectAppService", "input": P}); assert st == 200
    r = dict(epc.unwrap(sc)); r.pop("deploymentUrl", None); return r
before = snap(); cur = before["source"]["image"]; print("current image reference:", cur)
if rev:
    assert cur == NEW, ("not on the admission release; refusing rollback", cur); target = PREV
else:
    assert cur == PREV, ("unexpected current image; refusing", cur); target = NEW
st, sc = epc.tool("execute_destructive", {"procedure": "updateAppSourceImage", "input": dict(P, image=target)}); print("updateAppSourceImage ->", st); assert st == 200
mid = snap()
def flat(o, p=""):
    if isinstance(o, dict):
        for k, v in o.items(): yield from flat(v, p + "." + k)
    else: yield p, o
b, a = dict(flat(before)), dict(flat(mid)); diff = sorted(k for k in set(a) | set(b) if a.get(k) != b.get(k)); print("DIFF keys:", diff); assert diff == [".source.image"], diff
st, sc = epc.tool("execute_destructive", {"procedure": "deployAppService", "input": P}); print("deployAppService ->", st); assert st == 200
print("now:", snap()["source"]["image"])
