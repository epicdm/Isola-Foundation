"""zz-relay-hold-set: set RELAY_SUPERVISED_HOLD_MS on uplink/sf-relay-pl-prod to VALUE (0 = off: the war-room image then behaves exactly like rc10l).
Env diff must be exactly that key's value; the definition (image etc.) must not change; one deploy.  VALUE=0 python zz-relay-hold-set.py"""
import os, importlib.util
here = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("epc", os.path.join(here, "zz-migrate-02-ep-client.py")); epc = importlib.util.module_from_spec(spec); spec.loader.exec_module(epc)
VAL = os.environ["VALUE"]; assert VAL.isdigit() and int(VAL) <= 60000
KEY = "RELAY_SUPERVISED_HOLD_MS"; P = {"projectName": "uplink", "serviceName": "sf-relay-pl-prod"}
epc.rpc("initialize", {"protocolVersion": "2025-03-26", "capabilities": {}, "clientInfo": {"name": "lane-a-relay-hold-set", "version": "1"}}); epc.assert_host04()
def insp():
    st, sc = epc.tool("execute_query", {"procedure": "inspectAppService", "input": P}); assert st == 200
    r = dict(epc.unwrap(sc)); r.pop("deploymentUrl", None); return r
def parse(e): return dict(l.split("=", 1) for l in e.splitlines() if "=" in l)
def flat(o, p=""):
    if isinstance(o, dict):
        for k, v in o.items(): yield from flat(v, p + "." + k)
    else: yield p, o
cur = insp(); env0 = parse(cur["env"]); assert KEY in env0, "key missing"
print("BEFORE", KEY, "=", env0[KEY], "| image", cur["source"]["image"][-20:])
new_env = "\n".join((KEY + "=" + VAL) if l.split("=", 1)[0] == KEY else l for l in cur["env"].splitlines()) + ("\n" if cur["env"].endswith("\n") else "")
st, sc = epc.tool("execute_destructive", {"procedure": "updateAppEnv", "input": {**P, "env": new_env}}); print("updateAppEnv ->", st); assert st == 200
after = insp(); a = parse(after["env"])
denv = sorted(k for k in set(a) | set(env0) if a.get(k) != env0.get(k)); print("differing:", denv); assert denv in ([KEY], []), denv
b, c = dict(flat({k: v for k, v in cur.items() if k != "env"})), dict(flat({k: v for k, v in after.items() if k != "env"}))
ddef = sorted(k for k in set(b) | set(c) if b.get(k) != c.get(k)); print("definition diff:", ddef); assert ddef == [], "definition changed; NOT deploying"
st, sc = epc.tool("execute_destructive", {"procedure": "deployAppService", "input": P}); print("deployAppService ->", st); assert st == 200
print("AFTER", KEY, "=", parse(insp()["env"]).get(KEY))
