"""zz-bff-host04-create-db (Lane A, owner instruction 2026-10-15: move bff.epic.dm to host04).
Creates host04 project `bff` and Postgres 18 service `bff-db` (db isolav2, superuser `bff`). Non-destructive; nothing live depends on it. The EasyPanel-generated password is never printed.
Reversal: destroyPostgresService bff/bff-db + destroyProject bff (nothing else references them until the app is deployed)."""
import os, json, importlib.util
here = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("epc", os.path.join(here, "zz-migrate-02-ep-client.py")); epc = importlib.util.module_from_spec(spec); spec.loader.exec_module(epc)
epc.rpc("initialize", {"protocolVersion": "2025-03-26", "capabilities": {}, "clientInfo": {"name": "lane-a-bff-db", "version": "1"}})
print("host04 projects:", epc.assert_host04())
def m(proc, **inp):
    st, sc = epc.tool("execute_mutation", {"procedure": proc, "input": inp}); print(proc, "->", st, json.dumps(epc.redact(sc))[:160]); assert st == 200; return sc
projects = epc.assert_host04()
assert "bff" not in projects, "project bff already exists; refusing"
m("createProject", name="bff")
m("createPostgresService", projectName="bff", serviceName="bff-db", image="postgres:18", databaseName="isolav2", user="bff",
  env="PGDATA=/var/lib/postgresql/data", command="docker-entrypoint.sh postgres -c shared_buffers=128MB -c max_connections=60",
  resources={"memoryLimit": 1024, "memoryReservation": 256, "cpuLimit": 1, "cpuReservation": 0.1})
print("done")
