"""zz-test-epic-dm-host04 (Lane A, 2026-10-15; owner: deepseek is retiring, everything on host04).
Reproduces deepseek nginx's test.epic.dm vhost on host04 Traefik, via the panel:
  /home, /home/  -> 302 https://app.isola.epic.dm/<query>        (nginx: location = /home/ and /home -> return 302 https://app.isola.epic.dm/?$args)
  everything else-> 302 https://app.isola.epic.dm/<same path+query>  (nginx: location / -> return 302 https://app.isola.epic.dm$request_uri)
  /api/lite/*, /go/* -> plsvc (nginx: proxy to pl-edge.uplink.epic.dm = plsvc)
ACTION=create : middlewares + domains.   ACTION=nudge : same-host throw-away route add/remove so Traefik re-runs Let's Encrypt AFTER DNS points here (see reference_traefik_acme_no_retry_after_prednsfailure).
ACTION=list   : domains for test.epic.dm.   Reversal: deleteDomain for each test.epic.dm entry + deleteMiddleware for the two test-epic-dm-* middlewares."""
import os, sys, json, random, string, importlib.util
here = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("epc", os.path.join(here, "zz-migrate-02-ep-client.py")); epc = importlib.util.module_from_spec(spec); spec.loader.exec_module(epc)
epc.rpc("initialize", {"protocolVersion": "2025-03-26", "capabilities": {}, "clientInfo": {"name": "lane-a-test-epic-dm", "version": "1"}}); epc.assert_host04()
A = os.environ["ACTION"]; HOST = "test.epic.dm"
def q(proc, **inp):
    st, sc = epc.tool("execute_query", {"procedure": proc, "input": inp}); assert st == 200, (st, str(sc)[:200]); return epc.unwrap(sc)
def m(proc, kind="execute_mutation", **inp):
    st, sc = epc.tool(kind, {"procedure": proc, "input": inp}); print(proc, "->", st, json.dumps(epc.redact(sc))[:120]); assert st == 200; return sc
def cuid(): return "c" + "".join(random.choices(string.ascii_lowercase + string.digits, k=24))
def dom(path, project, service, port, mws=()):
    return {"certificateResolver": "", "host": HOST, "https": True, "id": cuid(), "middlewares": list(mws), "path": path, "wildcard": False, "destinationType": "service",
            "serviceDestination": {"path": path, "port": port, "projectName": project, "protocol": "http", "serviceName": service}}
def all_domains():
    out = []
    for p, s in (("bff", "bff-v2"), ("uplink", "plsvc-app")):
        out += [(p, s, d) for d in q("listDomains", projectName=p, serviceName=s) if d["host"] == HOST]
    return out
if A == "create":
    # a stale mapping restored from host03 (test.epic.dm -> fiserv/fiserv-api) would hijack the name after the DNS flip: remove it first (exact host+service match only)
    for d in q("listDomains", projectName="fiserv", serviceName="fiserv-api"):
        if d["host"] == HOST:
            assert d["serviceDestination"]["serviceName"] == "fiserv-api" and d["path"] == "/", d
            st, sc = epc.tool("execute_destructive", {"procedure": "deleteDomain", "input": {"id": d["id"]}}); print("deleted stale", HOST, "-> fiserv-api:", st); assert st == 200
    have = {x["name"] for x in q("listMiddlewares")}
    if "test-epic-dm-redirect" not in have:
        m("createMiddleware", name="test-epic-dm-redirect", type="redirectRegex", regex=r"^https?://test\.epic\.dm/(.*)$", replacement="https://app.isola.epic.dm/${1}", permanent=False)
    if "test-epic-dm-home" not in have:
        m("createMiddleware", name="test-epic-dm-home", type="redirectRegex", regex=r"^https?://test\.epic\.dm/home/?(\?.*)?$", replacement="https://app.isola.epic.dm/${1}", permanent=False)
    ex = {(p, s, d["path"]) for p, s, d in all_domains()}
    plan = [("bff", "bff-v2", "/", 3005, ["test-epic-dm-redirect"]), ("bff", "bff-v2", "/home", 3005, ["test-epic-dm-home"]),
            ("uplink", "plsvc-app", "/api/lite", 3005, []), ("uplink", "plsvc-app", "/go", 3005, [])]
    for p, s, path, port, mws in plan:
        if (p, s, path) in ex: print("exists", p, s, path); continue
        m("createDomain", **dom(path, p, s, port, mws))
elif A == "nudge":
    NP = "/zz-cert-nudge"
    existing = [(p, s, d) for p, s, d in all_domains() if d["path"] == NP]
    if existing: print("nudge route already present")
    else: m("createDomain", **dom(NP, "bff", "bff-v2", 3005))
elif A == "unnudge":
    for p, s, d in all_domains():
        if d["path"] == "/zz-cert-nudge":
            st, sc = epc.tool("execute_destructive", {"procedure": "deleteDomain", "input": {"id": d["id"]}}); print("deleteDomain nudge ->", st); assert st == 200
print(HOST, "domains now:", [(p + "/" + s, d["path"], d.get("middlewares")) for p, s, d in all_domains()])
