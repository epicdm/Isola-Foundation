"""zz-relay-war-room-cutover (Lane A, 2026-10-15; owner: 'build the war room', 20 s supervised hold).
Swaps uplink/sf-relay-pl-prod from rc10l (636a0af8) to the war-room image (rc10l + relay.js/server.js: supervised hold with @hold, trace notes)
AND adds env RELAY_SUPERVISED_HOLD_MS=20000. One deploy. The env diff must be exactly that key and the definition diff exactly .source.image.
  NEW_IMAGE=localhost:5000/pl/sf-relay-ctx@sha256:<digest> python zz-relay-war-room-cutover.py
  REVERSE=1 NEW_IMAGE=<digest> python zz-relay-war-room-cutover.py      -> key removed, image back to rc10l, one deploy
Quick OFF without a rollback: set RELAY_SUPERVISED_HOLD_MS=0 (the new image then behaves exactly like rc10l)."""
import os, json, importlib.util
here = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("epc", os.path.join(here, "zz-migrate-02-ep-client.py")); epc = importlib.util.module_from_spec(spec); spec.loader.exec_module(epc)
REVERSE = os.environ.get("REVERSE") == "1"
OLD = "localhost:5000/pl/sf-relay-ctx@sha256:636a0af88cdc0db223925b708de342174b98ee9f32098af1261e41a6dc3adde5"
NEW = os.environ["NEW_IMAGE"]; assert NEW.startswith("localhost:5000/pl/sf-relay-ctx@sha256:") and NEW != OLD
KEY, VAL = "RELAY_SUPERVISED_HOLD_MS", "20000"
FROM, TO = (NEW, OLD) if REVERSE else (OLD, NEW)
P = {"projectName": "uplink", "serviceName": "sf-relay-pl-prod"}
epc.rpc("initialize", {"protocolVersion": "2025-03-26", "capabilities": {}, "clientInfo": {"name": "lane-a-relay-war-room", "version": "1"}}); epc.assert_host04()
def insp():
    st, sc = epc.tool("execute_query", {"procedure": "inspectAppService", "input": P}); assert st == 200
    r = dict(epc.unwrap(sc)); r.pop("deploymentUrl", None); return r
def parse(e): return dict(l.split("=", 1) for l in e.splitlines() if "=" in l)
def flat(o, p=""):
    if isinstance(o, dict):
        for k, v in o.items(): yield from flat(v, p + "." + k)
    else: yield p, o
cur = insp(); env0 = parse(cur["env"])
print("BEFORE image:", cur["source"]["image"][-20:], "| env names:", len(env0), "| mode:", "REVERSE" if REVERSE else "FORWARD")
assert cur["source"]["image"] == FROM, ("unexpected starting image; abort", cur["source"]["image"][-20:])
lines = cur["env"].splitlines()
if REVERSE:
    assert KEY in env0, "key not present; nothing to reverse"
    new_env = "\n".join(l for l in lines if l.split("=", 1)[0] != KEY) + ("\n" if cur["env"].endswith("\n") else "")
else:
    assert KEY not in env0, "key already present; refusing"
    new_env = cur["env"].rstrip("\n") + "\n" + KEY + "=" + VAL + ("\n" if cur["env"].endswith("\n") else "")
st, sc = epc.tool("execute_destructive", {"procedure": "updateAppEnv", "input": {**P, "env": new_env}}); print("updateAppEnv ->", st); assert st == 200
st, sc = epc.tool("execute_destructive", {"procedure": "updateAppSourceImage", "input": dict(P, image=TO)}); print("updateAppSourceImage ->", st); assert st == 200
after = insp(); a = parse(after["env"])
denv = sorted(k for k in set(a) | set(env0) if a.get(k) != env0.get(k)); print("env keys:", len(env0), "->", len(a), "| differing:", denv); assert denv == [KEY], denv
b, c = dict(flat({k: v for k, v in cur.items() if k != "env"})), dict(flat({k: v for k, v in after.items() if k != "env"}))
ddef = sorted(k for k in set(b) | set(c) if b.get(k) != c.get(k)); print("definition diff (non-env):", ddef); assert ddef == [".source.image"], "unexpected definition change; NOT deploying"
st, sc = epc.tool("execute_destructive", {"procedure": "deployAppService", "input": P}); print("deployAppService ->", st); assert st == 200
fin = insp(); print("AFTER image:", fin["source"]["image"][-20:], "| key:", parse(fin["env"]).get(KEY, "(absent)"))
