"""zz-bff-host04-create-app (Lane A, owner instruction 2026-10-15: move bff.epic.dm to host04).
STAGE=env : build /etc/bff-secrets/bff_env on host04 (0400 root) = deepseek bff-v2 env with ONLY DATABASE_URL re-pointed at the new bff-db,
            plus the four PL_* settings deepseek's pm2 injects outside the .env file. Value-blind: nothing secret is printed. BYTES end to end
            (text-mode pipes on Windows turn LF into CRLF - measured 2026-10-15: every value gained a trailing CR).
STAGE=app : createAppService bff/bff-v2 (image by digest, env PORT/HOSTNAME/NODE_ENV/ISOLA_SCHEDULERS_ENABLED=0, mount the env file as /app/.env). NOT deployed here.
Reversal: destroyAppService bff/bff-v2, destroy bff-db, destroyProject bff, shred /etc/bff-secrets/bff_env. Deepseek is untouched."""
import os, sys, json, subprocess, importlib.util, urllib.parse
here = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("epc", os.path.join(here, "zz-migrate-02-ep-client.py")); epc = importlib.util.module_from_spec(spec); spec.loader.exec_module(epc)
STAGE = os.environ["STAGE"]
epc.rpc("initialize", {"protocolVersion": "2025-03-26", "capabilities": {}, "clientInfo": {"name": "lane-a-bff-app", "version": "1"}})
print("host04 projects:", epc.assert_host04())
def m(proc, **inp):
    st, sc = epc.tool("execute_mutation", {"procedure": proc, "input": inp}); print(proc, "->", st, json.dumps(epc.redact(sc))[:160]); assert st == 200; return sc
def lf(b): return b.decode("utf-8").replace("\r\n", "\n")
if STAGE == "env":
    src = lf(subprocess.run(["ssh", "deepseek", "sudo cat /opt/bff-v2/.env"], capture_output=True).stdout)
    assert src.count("\nDATABASE_URL=") + (1 if src.startswith("DATABASE_URL=") else 0) == 1, "DATABASE_URL not exactly once"
    st, sc = epc.tool("execute_query", {"procedure": "inspectPostgresService", "input": {"projectName": "bff", "serviceName": "bff-db"}}); assert st == 200
    pw = epc.unwrap(sc)["password"]; assert pw and len(pw) >= 16
    url = "postgresql://bff:" + urllib.parse.quote(pw, safe="") + "@bff_bff-db:5432/isolav2"
    remote = "bash /tmp/zz-x3.sh"
    extra = lf(subprocess.run(["ssh", "deepseek", "sudo bash /tmp/zz-x3.sh"], capture_output=True).stdout).strip().splitlines()
    assert len(extra) == 4, ("expected 4 pm2-injected PL_* keys", len(extra))
    skip = {e.split("=", 1)[0] + "=" for e in extra}
    lines = []
    for l in src.splitlines():
        if l.startswith("DATABASE_URL="): l = "DATABASE_URL=" + url
        if l.startswith("ISOLA_SCHEDULERS_ENABLED="): continue
        if any(l.startswith(s) for s in skip): continue
        lines.append(l)
    lines += extra
    body = ("\n".join(lines) + "\n").encode("utf-8")
    assert b"\r" not in body
    print("env lines:", len(lines), "| DATABASE_URL replaced: yes | pm2-injected keys added:", [e.split("=", 1)[0] for e in extra], "| bytes:", len(body))
    r = subprocess.run(["ssh", "epicadmin@host04", "sudo install -m 0400 -o root -g root /dev/stdin /etc/bff-secrets/bff_env && sudo stat -c '%a %U:%G %s bytes %n' /etc/bff-secrets/bff_env && sudo bash /tmp/zz-x4.sh"], input=body, capture_output=True)
    print(r.stdout.decode().strip(), r.stderr.decode().strip()[:160])
elif STAGE == "app":
    dig = subprocess.run(["ssh", "epicadmin@host04", "sudo docker image inspect localhost:5000/bff/bff-v2:d736dbf3 --format '{{range .RepoDigests}}{{println .}}{{end}}'"], capture_output=True, text=True).stdout.split()
    dig = [d for d in dig if d.startswith("localhost:5000/bff/bff-v2@sha256:")]; assert len(dig) == 1, dig
    env = "\n".join(["PORT=3005", "HOSTNAME=0.0.0.0", "NODE_ENV=production", "ISOLA_SCHEDULERS_ENABLED=0"])
    names = {s["name"] for s in epc.unwrap(epc.tool("execute_query", {"procedure": "listProjectsAndServices", "input": {}})[1])["services"] if s.get("projectName") == "bff"}
    assert "bff-v2" not in names, "bff-v2 already exists; refusing"
    m("createAppService", projectName="bff", serviceName="bff-v2", source={"type": "image", "image": dig[0]}, env=env,
      deploy={"replicas": 1, "zeroDowntime": True}, resources={"cpuLimit": 1.5, "cpuReservation": 0.25, "memoryLimit": 2048, "memoryReservation": 256},
      mounts=[{"type": "bind", "hostPath": "/etc/bff-secrets/bff_env", "mountPath": "/app/.env"}])
    print("created (not deployed); image", dig[0][:44] + "...")
