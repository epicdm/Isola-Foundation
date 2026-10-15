"""zz-provision-epic-dm-host04 (Lane A, 2026-10-15; owner is pointing provision.epic.dm at host04).
Reproduces deepseek nginx's provision.epic.dm vhost on host04 Traefik, via the panel:
  /api/v1/acrobits/provision -> plsvc /api/lite/acrobits/provision   (the Acrobits portal's InitialProvisioningUrl)
  /api/v1/acrobits/tab-entry -> plsvc /api/lite/acrobits/tab-entry   (Custom Tab URL)
  /home                      -> plsvc /api/lite/acrobits/tab-entry   (legacy Custom Tab URL template)
  /api/lite                  -> plsvc /api/lite                      (the path plsvc advertises when reached as bff.epic.dm; harmless here)
  everything else /          -> fiserv-api :8085                     (nginx: location / -> api01.epic.dm, which is fiserv-api on host04)
NOT reproduced: nginx's root-path provisioning when ?username= is present (legacy emapro shape; the portal uses /api/v1/acrobits/provision).
ACTION=create | nudge | unnudge | list.  Reversal: deleteDomain for each provision.epic.dm entry (ACTION=delete)."""
import os, json, random, string, importlib.util
here = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("epc", os.path.join(here, "zz-migrate-02-ep-client.py")); epc = importlib.util.module_from_spec(spec); spec.loader.exec_module(epc)
epc.rpc("initialize", {"protocolVersion": "2025-03-26", "capabilities": {}, "clientInfo": {"name": "lane-a-provision-epic-dm", "version": "1"}}); epc.assert_host04()
A = os.environ["ACTION"]; HOST = "provision.epic.dm"
def q(proc, **inp):
    st, sc = epc.tool("execute_query", {"procedure": proc, "input": inp}); assert st == 200, (st, str(sc)[:200]); return epc.unwrap(sc)
def m(proc, kind="execute_mutation", **inp):
    st, sc = epc.tool(kind, {"procedure": proc, "input": inp}); print(proc, "->", st, json.dumps(epc.redact(sc))[:120]); assert st == 200; return sc
def cuid(): return "c" + "".join(random.choices(string.ascii_lowercase + string.digits, k=24))
def dom(path, project, service, port, internal):
    return {"certificateResolver": "", "host": HOST, "https": True, "id": cuid(), "middlewares": [], "path": path, "wildcard": False, "destinationType": "service",
            "serviceDestination": {"path": internal, "port": port, "projectName": project, "protocol": "http", "serviceName": service}}
SVCS = (("uplink", "plsvc-app"), ("fiserv", "fiserv-api"), ("bff", "bff-v2"))
def all_domains():
    out = []
    for p, s in SVCS: out += [(p, s, d) for d in q("listDomains", projectName=p, serviceName=s) if d["host"] == HOST]
    return out
PLAN = [("uplink", "plsvc-app", "/api/v1/acrobits/provision", 3005, "/api/lite/acrobits/provision"),
        ("uplink", "plsvc-app", "/api/v1/acrobits/tab-entry", 3005, "/api/lite/acrobits/tab-entry"),
        ("uplink", "plsvc-app", "/home", 3005, "/api/lite/acrobits/tab-entry"),
        ("uplink", "plsvc-app", "/api/lite", 3005, "/api/lite"),
        ("fiserv", "fiserv-api", "/", 8085, "/")]
if A == "create":
    ex = {(p, s, d["path"]) for p, s, d in all_domains()}
    for p, s, path, port, internal in PLAN:
        if (p, s, path) in ex: print("exists", p, s, path); continue
        m("createDomain", **dom(path, p, s, port, internal))
elif A == "fix":
    # The panel's serviceDestination.path does NOT rewrite (measured: /api/v1/acrobits/provision reached plsvc unchanged -> 401).
    # Rewrite with replacePathRegex (query string is preserved by Traefik), then recreate the three affected routes with the middleware.
    MW = {"/api/v1/acrobits/provision": ("prov-epic-dm-provision", r"^/api/v1/acrobits/provision$", "/api/lite/acrobits/provision"),
          "/api/v1/acrobits/tab-entry": ("prov-epic-dm-tabentry", r"^/api/v1/acrobits/tab-entry$", "/api/lite/acrobits/tab-entry"),
          "/home": ("prov-epic-dm-home", r"^/home/?$", "/api/lite/acrobits/tab-entry")}
    have = {x["name"] for x in q("listMiddlewares")}
    for path, (name, rx, rep) in MW.items():
        if name not in have: m("createMiddleware", name=name, type="replacePathRegex", regex=rx, replacement=rep)
    for p, s, d in all_domains():
        if d["path"] in MW and not d.get("middlewares"):
            st, sc = epc.tool("execute_destructive", {"procedure": "deleteDomain", "input": {"id": d["id"]}}); print("deleteDomain", d["path"], "->", st); assert st == 200
            nd = dom(d["path"], p, s, 3005, d["path"]); nd["middlewares"] = [MW[d["path"]][0]]; m("createDomain", **nd)
elif A == "nudge":
    if any(d["path"] == "/zz-cert-nudge" for _, _, d in all_domains()): print("nudge route already present")
    else: m("createDomain", **dom("/zz-cert-nudge", "uplink", "plsvc-app", 3005, "/zz-cert-nudge"))
elif A == "unnudge":
    for p, s, d in all_domains():
        if d["path"] == "/zz-cert-nudge":
            st, sc = epc.tool("execute_destructive", {"procedure": "deleteDomain", "input": {"id": d["id"]}}); print("deleteDomain nudge ->", st); assert st == 200
elif A == "delete":
    for p, s, d in all_domains():
        st, sc = epc.tool("execute_destructive", {"procedure": "deleteDomain", "input": {"id": d["id"]}}); print("deleteDomain", d["path"], "->", st); assert st == 200
print(HOST, "domains now:", [(p + "/" + s, d["path"], d["serviceDestination"].get("path")) for p, s, d in all_domains()])
