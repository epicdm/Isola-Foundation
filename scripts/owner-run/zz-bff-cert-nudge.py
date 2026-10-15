"""zz-bff-cert-nudge (Lane A, 2026-10-15). Traefik tried the Let's Encrypt cert for bff.epic.dm at 07:05Z when DNS still pointed at deepseek (invalid authorization) and does not retry by itself.
After the owner's DNS flip we need Traefik to re-run the attempt: ACTION=add creates a throw-away extra route on the SAME host (path /zz-cert-nudge -> bff-v2) so the routing config changes and Traefik reloads; ACTION=remove deletes it again.
No new LE name is involved (same host). Reversal of everything: ACTION=remove."""
import os, json, importlib.util
here = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("epc", os.path.join(here, "zz-migrate-02-ep-client.py")); epc = importlib.util.module_from_spec(spec); spec.loader.exec_module(epc)
epc.rpc("initialize", {"protocolVersion": "2025-03-26", "capabilities": {}, "clientInfo": {"name": "lane-a-cert-nudge", "version": "1"}}); epc.assert_host04()
A = os.environ["ACTION"]; NUDGE_ID = "cznudgebffcert2026101507"
def doms():
    st, sc = epc.tool("execute_query", {"procedure": "listDomains", "input": {"projectName": "bff", "serviceName": "bff-v2"}}); assert st == 200; return epc.unwrap(sc)
if A == "add":
    if any(d["path"] == "/zz-cert-nudge" for d in doms()): print("already present")
    else:
        inp = {"certificateResolver": "", "host": "bff.epic.dm", "https": True, "id": NUDGE_ID, "middlewares": [], "path": "/zz-cert-nudge", "wildcard": False,
               "destinationType": "service", "serviceDestination": {"path": "/zz-cert-nudge", "port": 3005, "projectName": "bff", "protocol": "http", "serviceName": "bff-v2"}}
        st, sc = epc.tool("execute_mutation", {"procedure": "createDomain", "input": inp}); print("createDomain nudge ->", st, json.dumps(epc.redact(sc))[:100]); assert st == 200
elif A == "remove":
    d = [x for x in doms() if x["host"] == "bff.epic.dm" and x["path"] == "/zz-cert-nudge"]  # the panel assigns its OWN id; match on host+path
    if not d: print("not present")
    else:
        assert d[0]["host"] == "bff.epic.dm" and d[0]["path"] == "/zz-cert-nudge", d
        st, sc = epc.tool("execute_destructive", {"procedure": "deleteDomain", "input": {"id": d[0]["id"]}}); print("deleteDomain nudge ->", st); assert st == 200
print("bff/bff-v2 domains now:", [(x["host"], x["path"]) for x in doms()])
