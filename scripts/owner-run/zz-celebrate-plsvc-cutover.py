"""zz-celebrate-plsvc-cutover: switch on 'celebrate when the phone is online' (owner: 'switch it on', 2026-10-14) on EasyPanel uplink/plsvc-app.
ONE deploy that changes EXACTLY the image and four settings (values other than the URL/cutoff are fixed words; nothing secret is printed):
  NEW_IMAGE=localhost:5000/pl/plsvc@sha256:<digest> python zz-celebrate-plsvc-cutover.py            -> image 535c620f -> NEW and add the four keys, diff, deploy
  python zz-celebrate-plsvc-cutover.py with REVERSE=1 NEW_IMAGE=<the same digest>                      -> image back to 535c620f and remove the four keys, deploy
Keys: REGISTRATION_SOURCE=magnus | REGISTRATION_FOLLOWUPS=chatwoot | PL_ADAPTER_URL=http://uplink_pl-action-adapter:9100 | REGISTRATION_FOLLOWUPS_NOT_BEFORE=<ISO, now+4 min>
The cutoff means only hand-offs AFTER it are ever spoken to; earlier ones (the conference participants) are not contacted.
"""
import os, sys, json, hashlib, datetime, importlib.util
here = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("epc", os.path.join(here, "zz-migrate-02-ep-client.py")); epc = importlib.util.module_from_spec(spec); spec.loader.exec_module(epc)
REVERSE = os.environ.get("REVERSE") == "1"
PREV = "localhost:5000/pl/plsvc@sha256:535c620f94e75be5234c61625d1e8d5a2a6a8920ef18cc19556e2a8acbb95a36"
NEW = os.environ.get("NEW_IMAGE", "")
assert NEW.startswith("localhost:5000/pl/plsvc@sha256:") and len(NEW) == len("localhost:5000/pl/plsvc@sha256:") + 64 and NEW != PREV, "NEW_IMAGE must be a full digest-pinned candidate"
cutoff = (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(minutes=4)).strftime("%Y-%m-%dT%H:%M:%SZ")
KEYS = {"REGISTRATION_SOURCE": "magnus", "REGISTRATION_FOLLOWUPS": "chatwoot", "PL_ADAPTER_URL": "http://uplink_pl-action-adapter:9100", "REGISTRATION_FOLLOWUPS_NOT_BEFORE": cutoff}
epc.rpc("initialize", {"protocolVersion": "2025-03-26", "capabilities": {}, "clientInfo": {"name": "lane-a-celebrate-plsvc", "version": "1"}})
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
print("BEFORE image:", cur["source"]["image"], "| env names:", len(env0), "| replicas:", cur["deploy"]["replicas"], "| mode:", "REVERSE" if REVERSE else "FORWARD")
open(os.path.join(here, "zz-celebrate-plsvc-cutover.pre-snapshot%s.json" % (".rollback" if REVERSE else "")), "w").write(
    json.dumps({"names_sha8": {k: h8(v) for k, v in env0.items()}, "image": cur["source"]["image"]}, indent=1))
FROM, TO = (NEW, PREV) if REVERSE else (PREV, NEW)
assert cur["source"]["image"] == FROM, ("unexpected starting image; abort", cur["source"]["image"])
lines = cur["env"].splitlines()
if REVERSE:
    assert all(k in env0 for k in KEYS), "not all four keys present; nothing to roll back"
    new_env = "\n".join(l for l in lines if l.split("=", 1)[0] not in KEYS) + ("\n" if cur["env"].endswith("\n") else "")
else:
    assert not any(k in env0 for k in KEYS), "one of the keys is already present; refusing"
    new_env = cur["env"].rstrip("\n") + "\n" + "\n".join(f"{k}={v}" for k, v in KEYS.items()) + ("\n" if cur["env"].endswith("\n") else "")
nonenv = json.dumps(epc.redact({k: v for k, v in cur.items() if k not in ("env", "source")}), sort_keys=True)
st, sc = epc.tool("execute_destructive", {"procedure": "updateAppSourceImage", "input": dict(P, image=TO)}); print("updateAppSourceImage ->", st); assert st == 200
st, sc = epc.tool("execute_destructive", {"procedure": "updateAppEnv", "input": {**P, "env": new_env}}); print("updateAppEnv ->", st); assert st == 200
chk = insp(); chk.pop("deploymentUrl", None); a = parse(chk["env"])
diff_env = sorted(k for k in set(a) | set(env0) if a.get(k) != env0.get(k)); print("env keys:", len(env0), "->", len(a), "| differing:", diff_env); assert diff_env == sorted(KEYS), diff_env
b, c = dict(flat({k: v for k, v in cur.items() if k != "env"})), dict(flat({k: v for k, v in chk.items() if k != "env"}))
diff_def = sorted(k for k in set(b) | set(c) if b.get(k) != c.get(k)); print("definition diff (non-env):", diff_def); assert diff_def == [".source.image"], "unexpected definition change; NOT deploying"
st, sc = epc.tool("execute_destructive", {"procedure": "deployAppService", "input": P}); print("deployAppService ->", st); assert st == 200
fin = insp(); print("AFTER image:", fin["source"]["image"], "| env names:", len(parse(fin["env"])), "| cutoff set:", cutoff if not REVERSE else "removed")
