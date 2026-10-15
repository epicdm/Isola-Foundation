"""zz-openmyline-plsvc-image: image-ONLY switch of EasyPanel uplink/plsvc-app for the Open-my-line fix (validated 190/190, three independent reviews, last = SHIP). NOT RUN until the owner says go.
  python zz-openmyline-plsvc-image.py              -> 07bd7895 -> 1354bf93 (env and every other setting untouched; diff must be exactly .source.image), one deploy
  REVERSE=1 python zz-openmyline-plsvc-image.py    -> back to 07bd7895 (the celebration image; the four celebration settings stay)
"""
import os, sys, json, hashlib, importlib.util
here = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("epc", os.path.join(here, "zz-migrate-02-ep-client.py")); epc = importlib.util.module_from_spec(spec); spec.loader.exec_module(epc)
REVERSE = os.environ.get("REVERSE") == "1"
OLD = "localhost:5000/pl/plsvc@sha256:07bd789599cc327eba73ce907d4051d2af42defda353e7d6a247276a5d59a8df"
NEW = "localhost:5000/pl/plsvc@sha256:1354bf933b7fb1c223d98e1ec0644553927d6e25726569753fe28af2a3e9d74e"
FROM, TO = (NEW, OLD) if REVERSE else (OLD, NEW)
epc.rpc("initialize", {"protocolVersion": "2025-03-26", "capabilities": {}, "clientInfo": {"name": "lane-a-openmyline-plsvc", "version": "1"}})
epc.assert_host04()
P = {"projectName": "uplink", "serviceName": "plsvc-app"}
def insp():
    st, sc = epc.tool("execute_query", {"procedure": "inspectAppService", "input": P}); assert st == 200
    return epc.unwrap(sc)
def parse(e): return dict(l.split("=", 1) for l in e.splitlines() if "=" in l)
def h8(v): return hashlib.sha256(v.encode()).hexdigest()[:8]
def flat(o, p=""):
    if isinstance(o, dict):
        for k, v in o.items(): yield from flat(v, p + "." + k)
    else: yield p, o
cur = insp(); cur.pop("deploymentUrl", None); env0 = parse(cur["env"])
print("BEFORE image:", cur["source"]["image"], "| env names:", len(env0), "| mode:", "REVERSE" if REVERSE else "FORWARD")
open(os.path.join(here, "zz-openmyline-plsvc-image.pre-snapshot%s.json" % (".rollback" if REVERSE else "")), "w").write(json.dumps({"names_sha8": {k: h8(v) for k, v in env0.items()}, "image": cur["source"]["image"]}, indent=1))
assert cur["source"]["image"] == FROM, ("unexpected starting image; abort", cur["source"]["image"])
st, sc = epc.tool("execute_destructive", {"procedure": "updateAppSourceImage", "input": dict(P, image=TO)}); print("updateAppSourceImage ->", st); assert st == 200
after = insp(); after.pop("deploymentUrl", None)
b, a = dict(flat(cur)), dict(flat(after)); diff = sorted(k for k in set(a) | set(b) if a.get(k) != b.get(k))
print("DIFF keys:", diff); assert diff == [".source.image"], "unexpected change; NOT deploying"
st, sc = epc.tool("execute_destructive", {"procedure": "deployAppService", "input": P}); print("deployAppService ->", st); assert st == 200
fin = insp(); print("AFTER image:", fin["source"]["image"], "| env names:", len(parse(fin["env"])))
