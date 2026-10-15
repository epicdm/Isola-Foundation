"""zz-relay-image-hold: swap uplink/sf-relay-pl-prod from EXPECT_FROM to NEW_IMAGE and set RELAY_SUPERVISED_HOLD_MS=HOLD in ONE deploy.
The env diff must be exactly that key (or nothing) and the definition diff exactly .source.image.
  EXPECT_FROM=<digest ref> NEW_IMAGE=<digest ref> HOLD=20000 python zz-relay-image-hold.py
Rollback to the previous step: EXPECT_FROM=<new> NEW_IMAGE=<old> HOLD=0 python zz-relay-image-hold.py"""
import os, importlib.util
here = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("epc", os.path.join(here, "zz-migrate-02-ep-client.py")); epc = importlib.util.module_from_spec(spec); spec.loader.exec_module(epc)
FROM, TO, HOLD = os.environ["EXPECT_FROM"], os.environ["NEW_IMAGE"], os.environ["HOLD"]
assert FROM.startswith("localhost:5000/pl/sf-relay-ctx@sha256:") and TO.startswith("localhost:5000/pl/sf-relay-ctx@sha256:") and FROM != TO and HOLD.isdigit()
KEY = "RELAY_SUPERVISED_HOLD_MS"; P = {"projectName": "uplink", "serviceName": "sf-relay-pl-prod"}
epc.rpc("initialize", {"protocolVersion": "2025-03-26", "capabilities": {}, "clientInfo": {"name": "lane-a-relay-image-hold", "version": "1"}}); epc.assert_host04()
def insp():
    st, sc = epc.tool("execute_query", {"procedure": "inspectAppService", "input": P}); assert st == 200
    r = dict(epc.unwrap(sc)); r.pop("deploymentUrl", None); return r
def parse(e): return dict(l.split("=", 1) for l in e.splitlines() if "=" in l)
def flat(o, p=""):
    if isinstance(o, dict):
        for k, v in o.items(): yield from flat(v, p + "." + k)
    else: yield p, o
cur = insp(); env0 = parse(cur["env"]); assert KEY in env0, "hold key missing"
print("BEFORE image:", cur["source"]["image"][-20:], "| hold:", env0[KEY])
assert cur["source"]["image"] == FROM, ("unexpected starting image; abort", cur["source"]["image"][-20:])
new_env = "\n".join((KEY + "=" + HOLD) if l.split("=", 1)[0] == KEY else l for l in cur["env"].splitlines()) + ("\n" if cur["env"].endswith("\n") else "")
st, sc = epc.tool("execute_destructive", {"procedure": "updateAppEnv", "input": {**P, "env": new_env}}); print("updateAppEnv ->", st); assert st == 200
st, sc = epc.tool("execute_destructive", {"procedure": "updateAppSourceImage", "input": dict(P, image=TO)}); print("updateAppSourceImage ->", st); assert st == 200
after = insp(); a = parse(after["env"])
denv = sorted(k for k in set(a) | set(env0) if a.get(k) != env0.get(k)); print("env differing:", denv); assert denv in ([KEY], []), denv
b, c = dict(flat({k: v for k, v in cur.items() if k != "env"})), dict(flat({k: v for k, v in after.items() if k != "env"}))
ddef = sorted(k for k in set(b) | set(c) if b.get(k) != c.get(k)); print("definition diff:", ddef); assert ddef == [".source.image"], "unexpected definition change; NOT deploying"
st, sc = epc.tool("execute_destructive", {"procedure": "deployAppService", "input": P}); print("deployAppService ->", st); assert st == 200
fin = insp(); print("AFTER image:", fin["source"]["image"][-20:], "| hold:", parse(fin["env"]).get(KEY))
