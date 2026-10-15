"""zz-fiserv-move-host04 (Lane A, owner-directed 2026-10-15: 'move fiserv to host04, same name api01.epic.dm').
host04's EasyPanel already carries the fiserv project definitions (env, domain, db, redis) restored from host03; nothing was deployed.
Data (cold copy of host03 pgdata + redis, sha256-verified, restore PROVEN in a scratch postgres) is in /etc/easypanel/projects/fiserv/*/data.
STAGE=data : enablePostgresService fiserv-db + enableRedisService fiserv-redis   (no app yet)
STAGE=api  : updateAppSourceImage fiserv-api -> localhost:5000/fiserv/api@<digest of the host03 image a658c818>; asserts diff is only .source/.commit; deployAppService
Value-blind: env is never printed. Reversal: disableRedisService / disablePostgresService / disable the app; host03 originals untouched."""
import os, sys, json, subprocess, importlib.util
here = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("epc", os.path.join(here, "zz-migrate-02-ep-client.py")); epc = importlib.util.module_from_spec(spec); spec.loader.exec_module(epc)
STAGE = os.environ["STAGE"]
epc.rpc("initialize", {"protocolVersion": "2025-03-26", "capabilities": {}, "clientInfo": {"name": "lane-a-fiserv-move", "version": "1"}})
print("host04 projects:", epc.assert_host04())
def call(kind, proc, inp):
    st, sc = epc.tool(kind, {"procedure": proc, "input": inp}); print(proc, "->", st, json.dumps(epc.redact(sc))[:160]); assert st == 200
if STAGE == "data":
    call("execute_mutation", "enablePostgresService", {"projectName": "fiserv", "serviceName": "fiserv-db"})
    call("execute_mutation", "enableRedisService", {"projectName": "fiserv", "serviceName": "fiserv-redis"})
elif STAGE == "deploy":
    P = {"projectName": "fiserv", "serviceName": "fiserv-api"}
    st, sc = epc.tool("execute_query", {"procedure": "inspectAppService", "input": P}); r = epc.unwrap(sc)
    print("source:", r["source"].get("type"), "| env names:", len(r["env"].splitlines()), "(was 99)"); assert r["source"].get("type") == "image" and len(r["env"].splitlines()) == 99
    call("execute_destructive", "deployAppService", P)
elif STAGE == "api":
    dig = subprocess.run(["ssh", "epicadmin@host04", "sudo docker image inspect localhost:5000/fiserv/api:host03-a658c818 --format '{{range .RepoDigests}}{{println .}}{{end}}'"], capture_output=True, text=True).stdout.split()
    dig = [d for d in dig if d.startswith("localhost:5000/fiserv/api@sha256:")]; assert len(dig) == 1, dig
    NEW = dig[0]; print("image:", NEW[:40] + "...")
    P = {"projectName": "fiserv", "serviceName": "fiserv-api"}
    def insp():
        st, sc = epc.tool("execute_query", {"procedure": "inspectAppService", "input": P}); assert st == 200; r = dict(epc.unwrap(sc)); r.pop("deploymentUrl", None); return r
    def flat(o, p=""):
        if isinstance(o, dict):
            for k, v in o.items(): yield from flat(v, p + "." + k)
        else: yield p, o
    before = insp(); print("before source type:", before["source"].get("type"), "| env names:", len(before["env"].splitlines()))
    call("execute_destructive", "updateAppSourceImage", dict(P, image=NEW))
    after = insp(); b, a = dict(flat(before)), dict(flat(after))
    diff = sorted(k for k in set(a) | set(b) if a.get(k) != b.get(k)); print("DIFF keys:", diff)
    bad = [k for k in diff if not (k.startswith((".source", ".commit", ".build")))]; assert not bad, ("unexpected change; NOT deploying", bad)
    assert after["env"] == before["env"], "env changed; NOT deploying"
    call("execute_destructive", "deployAppService", P)
