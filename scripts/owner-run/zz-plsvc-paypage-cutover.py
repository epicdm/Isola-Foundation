"""zz-plsvc-paypage-cutover (Lane A, 2026-10-15). Fixes 'something went wrong' on the hosted pay page after bff.epic.dm moved to host04.
Root cause (measured): the pay page authenticates with the FRONTEND credential (deployed bff: ISOLA_INTERNAL_SECRET); plsvc only accepted INTERNAL_SECRET, so the lookup GET /api/internal/payment-link/<token> was 401.
Fix = narrow code (validatePayPageSecret, new env PL_PAYPAGE_SECRET, accepted ONLY by the payment-link lookup + charge routes) + that env value copied value-blind from deepseek's ISOLA_INTERNAL_SECRET.
Deliberately NOT done: configuring ISOLA_INTERNAL_SECRET on plsvc (would make the frontend credential valid for every /api/internal/* route).
  NEW_IMAGE=localhost:5000/pl/plsvc@sha256:<digest> python zz-plsvc-paypage-cutover.py     -> add env key PL_PAYPAGE_SECRET + swap image, one deploy; diff must be exactly {env: PL_PAYPAGE_SECRET} + .source.image
  REVERSE=1 NEW_IMAGE=<the new digest> python zz-plsvc-paypage-cutover.py                  -> remove the key, image back to 1354bf93, one deploy"""
import os, sys, json, hashlib, subprocess, importlib.util
here = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("epc", os.path.join(here, "zz-migrate-02-ep-client.py")); epc = importlib.util.module_from_spec(spec); spec.loader.exec_module(epc)
REVERSE = os.environ.get("REVERSE") == "1"
OLD = "localhost:5000/pl/plsvc@sha256:1354bf933b7fb1c223d98e1ec0644553927d6e25726569753fe28af2a3e9d74e"
NEW = os.environ["NEW_IMAGE"]; assert NEW.startswith("localhost:5000/pl/plsvc@sha256:") and NEW != OLD
KEY = "PL_PAYPAGE_SECRET"
FROM, TO = (NEW, OLD) if REVERSE else (OLD, NEW)
P = {"projectName": "uplink", "serviceName": "plsvc-app"}
epc.rpc("initialize", {"protocolVersion": "2025-03-26", "capabilities": {}, "clientInfo": {"name": "lane-a-paypage", "version": "1"}}); epc.assert_host04()
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
assert cur["source"]["image"] == FROM, ("unexpected starting image; abort", cur["source"]["image"])
lines = cur["env"].splitlines()
if REVERSE:
    assert KEY in env0, "key not present; nothing to reverse"
    new_env = "\n".join(l for l in lines if l.split("=", 1)[0] != KEY) + ("\n" if cur["env"].endswith("\n") else "")
else:
    assert KEY not in env0, "key already present; refusing"
    raw = subprocess.run(["ssh", "deepseek", "sudo grep -E '^ISOLA_INTERNAL_SECRET=' /opt/bff-v2/.env | head -1 | cut -d= -f2-"], capture_output=True).stdout.decode().strip().strip('"').strip("'")
    assert len(raw) == 64, ("unexpected frontend secret length", len(raw))
    print("frontend credential read in-process: length", len(raw), "sha8", hashlib.sha256(raw.encode()).hexdigest()[:8], "(expect 480203f2)")
    new_env = cur["env"].rstrip("\n") + "\n" + KEY + "=" + raw + ("\n" if cur["env"].endswith("\n") else "")
st, sc = epc.tool("execute_destructive", {"procedure": "updateAppEnv", "input": {**P, "env": new_env}}); print("updateAppEnv ->", st); assert st == 200
st, sc = epc.tool("execute_destructive", {"procedure": "updateAppSourceImage", "input": dict(P, image=TO)}); print("updateAppSourceImage ->", st); assert st == 200
after = insp(); a = parse(after["env"])
denv = sorted(k for k in set(a) | set(env0) if a.get(k) != env0.get(k)); print("env keys:", len(env0), "->", len(a), "| differing:", denv); assert denv == [KEY], denv
b, c = dict(flat({k: v for k, v in cur.items() if k != "env"})), dict(flat({k: v for k, v in after.items() if k != "env"}))
ddef = sorted(k for k in set(b) | set(c) if b.get(k) != c.get(k)); print("definition diff (non-env):", ddef); assert ddef == [".source.image"], "unexpected definition change; NOT deploying"
st, sc = epc.tool("execute_destructive", {"procedure": "deployAppService", "input": P}); print("deployAppService ->", st); assert st == 200
fin = insp(); print("AFTER image:", fin["source"]["image"][-20:], "| env names:", len(parse(fin["env"])), "| key present:", KEY in parse(fin["env"]))
