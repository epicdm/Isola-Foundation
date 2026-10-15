"""zz-plsvc-clerk-bypass-cutover (Lane A, 2026-10-15). After a card attempt the payer is sent back to the Cloud Softphone app instead of a signed-in PWA page.
Change: new public page GET /go/back (launches cloudsip:), pay-link returnUrl default https://bff.epic.dm/go/back for Personal Line payers (app/lib/pay-return.ts, payment-link.ts).
IMAGE-ONLY cutover: no env change. The definition diff must be exactly {.source.image}, and the env must be byte-identical before/after.
  NEW_IMAGE=localhost:5000/pl/plsvc@sha256:<digest> python zz-plsvc-clerk-bypass-cutover.py              -> b6e4c0bc -> new image, one deploy
  REVERSE=1 NEW_IMAGE=<the new digest> python zz-plsvc-clerk-bypass-cutover.py                            -> back to b6e4c0bc, one deploy"""
import os, sys, json, importlib.util
here = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("epc", os.path.join(here, "zz-migrate-02-ep-client.py")); epc = importlib.util.module_from_spec(spec); spec.loader.exec_module(epc)
REVERSE = os.environ.get("REVERSE") == "1"
OLD = "localhost:5000/pl/plsvc@sha256:b6e4c0bcc8974b2efe41e9d183fa16918e01a9be82a1e584e2cae0139816f510"
NEW = os.environ["NEW_IMAGE"]; assert NEW.startswith("localhost:5000/pl/plsvc@sha256:") and NEW != OLD
FROM, TO = (NEW, OLD) if REVERSE else (OLD, NEW)
P = {"projectName": "uplink", "serviceName": "plsvc-app"}
epc.rpc("initialize", {"protocolVersion": "2025-03-26", "capabilities": {}, "clientInfo": {"name": "lane-a-return", "version": "1"}}); epc.assert_host04()
def insp():
    st, sc = epc.tool("execute_query", {"procedure": "inspectAppService", "input": P}); assert st == 200
    r = dict(epc.unwrap(sc)); r.pop("deploymentUrl", None); return r
def flat(o, p=""):
    if isinstance(o, dict):
        for k, v in o.items(): yield from flat(v, p + "." + k)
    else: yield p, o
cur = insp()
print("BEFORE image:", cur["source"]["image"][-20:], "| mode:", "REVERSE" if REVERSE else "FORWARD")
assert cur["source"]["image"] == FROM, ("unexpected starting image; abort", cur["source"]["image"])
st, sc = epc.tool("execute_destructive", {"procedure": "updateAppSourceImage", "input": dict(P, image=TO)}); print("updateAppSourceImage ->", st); assert st == 200
after = insp()
assert after["env"] == cur["env"], "env changed; NOT deploying"
b, c = dict(flat({k: v for k, v in cur.items() if k != "env"})), dict(flat({k: v for k, v in after.items() if k != "env"}))
ddef = sorted(k for k in set(b) | set(c) if b.get(k) != c.get(k)); print("definition diff (non-env):", ddef, "| env identical: True"); assert ddef == [".source.image"], "unexpected definition change; NOT deploying"
st, sc = epc.tool("execute_destructive", {"procedure": "deployAppService", "input": P}); print("deployAppService ->", st); assert st == 200
fin = insp(); print("AFTER image:", fin["source"]["image"][-20:])
