"""zz-bff-host04-panel: small panel actions for the bff move.  ACTION=deploy | domain | domain-plsvc-peel ... (see below). Value-blind.
ACTION=deploy : deployAppService bff/bff-v2
ACTION=domain : createDomain bff.epic.dm -> bff/bff-v2:3005 (https). DNS still points at deepseek, so nothing reaches host04 until the owner flips it.
ACTION=list   : listDomains for bff/bff-v2 and uplink/plsvc-app"""
import os, json, random, string, importlib.util
here = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("epc", os.path.join(here, "zz-migrate-02-ep-client.py")); epc = importlib.util.module_from_spec(spec); spec.loader.exec_module(epc)
epc.rpc("initialize", {"protocolVersion": "2025-03-26", "capabilities": {}, "clientInfo": {"name": "lane-a-bff-panel", "version": "1"}}); epc.assert_host04()
A = os.environ["ACTION"]
def q(proc, **inp):
    st, sc = epc.tool("execute_query", {"procedure": proc, "input": inp}); assert st == 200, (st, str(sc)[:200]); return epc.unwrap(sc)
def cuid(): return "c" + "".join(random.choices(string.ascii_lowercase + string.digits, k=24))
if A == "deploy":
    st, sc = epc.tool("execute_destructive", {"procedure": "deployAppService", "input": {"projectName": "bff", "serviceName": "bff-v2"}}); print("deployAppService ->", st); assert st == 200
elif A == "domain":
    host = os.environ.get("HOST", "bff.epic.dm")
    if any(d["host"] == host for d in q("listDomains", projectName="bff", serviceName="bff-v2")): print("exists", host)
    else:
        inp = {"certificateResolver": "", "host": host, "https": True, "id": cuid(), "middlewares": [], "path": "/", "wildcard": False,
               "destinationType": "service", "serviceDestination": {"path": "/", "port": 3005, "projectName": "bff", "protocol": "http", "serviceName": "bff-v2"}}
        st, sc = epc.tool("execute_mutation", {"procedure": "createDomain", "input": inp}); print("createDomain", host, "->", st, json.dumps(epc.redact(sc))[:140]); assert st == 200
elif A == "list":
    for p, s in (("bff", "bff-v2"), ("uplink", "plsvc-app")):
        print(p + "/" + s, [(d["host"], d.get("path"), d.get("id")) for d in q("listDomains", projectName=p, serviceName=s)])
if A == "peel":
    host = "bff.epic.dm"
    have = {(d["host"], d.get("path")) for d in q("listDomains", projectName="uplink", serviceName="plsvc-app")}
    for path in ("/api/lite", "/api/internal/personal-line", "/api/internal/payment-link", "/go"):
        if (host, path) in have: print("exists", host, path); continue
        inp = {"certificateResolver": "", "host": host, "https": True, "id": cuid(), "middlewares": [], "path": path, "wildcard": False,
               "destinationType": "service", "serviceDestination": {"path": path, "port": 3005, "projectName": "uplink", "protocol": "http", "serviceName": "plsvc-app"}}
        st, sc = epc.tool("execute_mutation", {"procedure": "createDomain", "input": inp}); print("createDomain", host, path, "->", st, json.dumps(epc.redact(sc))[:120]); assert st == 200
