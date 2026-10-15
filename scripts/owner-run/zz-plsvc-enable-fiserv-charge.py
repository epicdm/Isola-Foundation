"""zz-plsvc-enable-fiserv-charge (Lane A, OWNER INSTRUCTION 2026-10-15: "enable card charging").
Sets FISERV_CHARGE_ENABLED=true and FISERV_API_KEY on host04 uplink/plsvc-app so the Personal Line pay page can charge through the host04 Fiserv (api01).
The key is read IN-PROCESS from the deepseek bff-v2 env (the key api01 was proven to accept: empty-body POST -> 400, wrong key -> 401) and never printed.
  python zz-plsvc-enable-fiserv-charge.py              -> add both keys (refuses if either already present), env diff must be exactly those two, definition diff empty, deploy
  REVERSE=1 python zz-plsvc-enable-fiserv-charge.py    -> remove both keys, deploy (charging returns to the safe disabled default)
"""
import os, sys, json, hashlib, subprocess, importlib.util
here = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("epc", os.path.join(here, "zz-migrate-02-ep-client.py")); epc = importlib.util.module_from_spec(spec); spec.loader.exec_module(epc)
REVERSE = os.environ.get("REVERSE") == "1"
KEYS = ["FISERV_CHARGE_ENABLED", "FISERV_API_KEY"]
P = {"projectName": "uplink", "serviceName": "plsvc-app"}
epc.rpc("initialize", {"protocolVersion": "2025-03-26", "capabilities": {}, "clientInfo": {"name": "lane-a-fiserv-enable", "version": "1"}})
epc.assert_host04()
def insp():
    st, sc = epc.tool("execute_query", {"procedure": "inspectAppService", "input": P}); assert st == 200
    r = dict(epc.unwrap(sc)); r.pop("deploymentUrl", None); return r
def parse(e): return dict(l.split("=", 1) for l in e.splitlines() if "=" in l)
def flat(o, p=""):
    if isinstance(o, dict):
        for k, v in o.items(): yield from flat(v, p + "." + k)
    else: yield p, o
cur = insp(); env0 = parse(cur["env"])
print("BEFORE env names:", len(env0), "| mode:", "REVERSE" if REVERSE else "FORWARD", "| image:", cur["source"]["image"][-20:])
lines = cur["env"].splitlines()
if REVERSE:
    assert all(k in env0 for k in KEYS), "keys not both present; nothing to reverse"
    new_env = "\n".join(l for l in lines if l.split("=", 1)[0] not in KEYS) + ("\n" if cur["env"].endswith("\n") else "")
else:
    assert not any(k in env0 for k in KEYS), "a key is already present; refusing"
    out = subprocess.run(["ssh", "deepseek", "sudo grep -E '^FISERV_API_KEY=' /opt/bff-v2/.env | head -1 | cut -d= -f2-"], capture_output=True, text=True).stdout.strip().strip('"').strip("'")
    assert len(out) == 40, ("unexpected key length from deepseek; abort", len(out))
    new_env = cur["env"].rstrip("\n") + "\nFISERV_CHARGE_ENABLED=true\nFISERV_API_KEY=" + out + ("\n" if cur["env"].endswith("\n") else "")
    print("key read in-process: length", len(out), "sha8", hashlib.sha256(out.encode()).hexdigest()[:8])
st, sc = epc.tool("execute_destructive", {"procedure": "updateAppEnv", "input": {**P, "env": new_env}}); print("updateAppEnv ->", st); assert st == 200
chk = insp(); a = parse(chk["env"])
diff_env = sorted(k for k in set(a) | set(env0) if a.get(k) != env0.get(k)); print("env keys:", len(env0), "->", len(a), "| differing:", diff_env); assert diff_env == sorted(KEYS), diff_env
b, c = dict(flat({k: v for k, v in cur.items() if k != "env"})), dict(flat({k: v for k, v in chk.items() if k != "env"}))
diff_def = sorted(k for k in set(b) | set(c) if b.get(k) != c.get(k)); print("definition diff (non-env):", diff_def); assert diff_def == [], "unexpected definition change; NOT deploying"
st, sc = epc.tool("execute_destructive", {"procedure": "deployAppService", "input": P}); print("deployAppService ->", st); assert st == 200
fin = insp(); print("AFTER env names:", len(parse(fin["env"])), "| charge flag present:", "FISERV_CHARGE_ENABLED" in parse(fin["env"]))
