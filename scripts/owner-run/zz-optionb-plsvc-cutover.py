"""zz-optionb-plsvc-cutover: Option B (owner decision dec-owner-pl-signup-option-b-chat-buttons-2026-10-14) on EasyPanel uplink/plsvc-app.
Two separate, separately reversible steps (mirrors zz-uplink-pilot-overlay-promote.py and zz-plsvc-activation-enable.py; values never printed):
  STEP=image python zz-optionb-plsvc-cutover.py              -> source.image 5acad2e8 (isolav2 4d605a7d) -> NEW_IMAGE, diff (only source.image), deploy
  STEP=image REVERSE=1 python zz-optionb-plsvc-cutover.py    -> back to 5acad2e8
  STEP=v8env FLOW_ID=<published v8 id> python ...            -> add exactly PL_SIGNUP_FLOW_ID_V8=<id>, diff (only that key), deploy
  STEP=v8env REVERSE=1 python ...                            -> remove only that line (new customers return to the 7.x Flow), deploy
"""
import os, sys, json, hashlib, importlib.util
here = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("epc", os.path.join(here, "zz-migrate-02-ep-client.py")); epc = importlib.util.module_from_spec(spec); spec.loader.exec_module(epc)
STEP = os.environ.get("STEP", ""); REVERSE = os.environ.get("REVERSE") == "1"
assert STEP in ("image", "v8env"), "STEP=image|v8env"
PREV = "localhost:5000/pl/plsvc@sha256:5acad2e83272754745bf088421fba3e2bf1db390f87cd3259f4a5423aa600115"
PREV = os.environ.get("EXPECT_START_IMAGE", PREV)   # a follow-up image replaces the previous Option B image (its rollback target)
NEW = os.environ.get("NEW_IMAGE", "")
KEY = "PL_SIGNUP_FLOW_ID_V8"
epc.rpc("initialize", {"protocolVersion": "2025-03-26", "capabilities": {}, "clientInfo": {"name": "lane-a-optionb-plsvc", "version": "1"}})
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
print("BEFORE image:", cur["source"]["image"], "| env names:", len(env0), "| replicas:", cur["deploy"]["replicas"])
open(os.path.join(here, "zz-optionb-plsvc-cutover.pre-snapshot.%s%s.json" % (STEP, ".rollback" if REVERSE else "")), "w").write(
    json.dumps({"names_sha8": {k: h8(v) for k, v in env0.items()}, "image": cur["source"]["image"]}, indent=1))
if STEP == "image":
    assert NEW.startswith("localhost:5000/pl/plsvc@sha256:"), "NEW_IMAGE must be a digest-pinned localhost:5000/pl/plsvc reference"
    FROM, TO = (NEW, PREV) if REVERSE else (PREV, NEW)
    assert cur["source"]["image"] == FROM, ("unexpected starting image; abort", cur["source"]["image"])
    st, sc = epc.tool("execute_destructive", {"procedure": "updateAppSourceImage", "input": dict(P, image=TO)}); print("updateAppSourceImage ->", st); assert st == 200
    after = insp(); after.pop("deploymentUrl", None)
    b, a = dict(flat(cur)), dict(flat(after)); diff = sorted(k for k in set(a) | set(b) if a.get(k) != b.get(k))
    print("DIFF keys:", diff); assert diff == [".source.image"], "unexpected change; NOT deploying"
else:
    lines = cur["env"].splitlines()
    if REVERSE:
        assert KEY in env0, "variable not present; nothing to roll back"
        new = "\n".join(l for l in lines if not l.startswith(KEY + "=")) + ("\n" if cur["env"].endswith("\n") else "")
    else:
        fid = os.environ.get("FLOW_ID", "")
        assert fid.isdigit() and 10 <= len(fid) <= 20, "FLOW_ID must be the published Meta Flow id"
        assert KEY not in env0, "variable already present; refusing"
        new = cur["env"].rstrip("\n") + "\n" + KEY + "=" + fid + ("\n" if cur["env"].endswith("\n") else "")
    nonenv = json.dumps(epc.redact({k: v for k, v in cur.items() if k != "env"}), sort_keys=True)
    st, sc = epc.tool("execute_destructive", {"procedure": "updateAppEnv", "input": {**P, "env": new}}); print("updateAppEnv ->", st); assert st == 200
    chk = insp(); chk.pop("deploymentUrl", None); a = parse(chk["env"])
    diff = sorted(k for k in set(a) | set(env0) if a.get(k) != env0.get(k)); print("env keys:", len(env0), "->", len(a), "| differing:", diff); assert diff == [KEY], diff
    assert json.dumps(epc.redact({k: v for k, v in chk.items() if k != "env"}), sort_keys=True) == nonenv, "non-env definition changed; NOT deploying"
st, sc = epc.tool("execute_destructive", {"procedure": "deployAppService", "input": P}); print("deployAppService ->", st); assert st == 200
fin = insp(); print("AFTER image:", fin["source"]["image"], "| env names:", len(parse(fin["env"])))
