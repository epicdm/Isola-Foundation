"""zz-migrate-26: digest-pinned deploy of relay rc10m (Isola-Foundation e3d3d27: on request_too_large rotate ONCE to a fresh Uplink conversation with carry-over instead of handing off; guarded against duplicate side effects)
after the joint isolated acceptance (rc10l 9/9 = positive control for the old handoff; rc10m 11/11) and the relay unit suite 126/126. Image = the DEPLOYED rc10l image + ONE changed file (relay.js 32dda8c9 -> 079150e4).
Deploy:  python zz-migrate-26-relay-rc10m-deploy.py       Rollback:  REVERSE=1 python zz-migrate-26-relay-rc10m-deploy.py   (back to rc10l 636a0af8)
Two execute_destructive calls (updateAppSourceImage then deployAppService) on uplink/sf-relay-pl-prod. Everything except source.image must stay identical (diffed)."""
import os, sys, json, importlib.util
here = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("epc", os.path.join(here, "zz-migrate-02-ep-client.py")); epc = importlib.util.module_from_spec(spec); spec.loader.exec_module(epc)
RC10M = "localhost:5000/pl/sf-relay-ctx@sha256:8d473255793411062d1e8eacfd5d9c5a8e3ce5e94e8d03e968c2486990051538"
RC10L = "localhost:5000/pl/sf-relay-ctx@sha256:636a0af88cdc0db223925b708de342174b98ee9f32098af1261e41a6dc3adde5"
rev = os.environ.get("REVERSE") == "1"
epc.rpc("initialize", {"protocolVersion": "2025-03-26", "capabilities": {}, "clientInfo": {"name": "lane-a-relay-rc10m", "version": "1"}})
epc.assert_host04()
P = {"projectName": "uplink", "serviceName": "sf-relay-pl-prod"}
def snap():
    st, sc = epc.tool("execute_query", {"procedure": "inspectAppService", "input": P}); assert st == 200
    r = dict(epc.unwrap(sc)); r.pop("deploymentUrl", None); return r
before = snap(); cur = before["source"]["image"]; print("current image reference:", cur)
if rev:
    assert cur == RC10M, ("not on rc10m; refusing rollback", cur); target = RC10L
else:
    assert cur == RC10L, ("unexpected current image; refusing", cur); target = RC10M
st, sc = epc.tool("execute_destructive", {"procedure": "updateAppSourceImage", "input": dict(P, image=target)}); print("updateAppSourceImage ->", st); assert st == 200
mid = snap()
def flat(o, p=""):
    if isinstance(o, dict):
        for k, v in o.items(): yield from flat(v, p + "." + k)
    else: yield p, o
b, a = dict(flat(before)), dict(flat(mid)); diff = sorted(k for k in set(a) | set(b) if a.get(k) != b.get(k)); print("DIFF keys:", diff); assert diff == [".source.image"], diff
st, sc = epc.tool("execute_destructive", {"procedure": "deployAppService", "input": P}); print("deployAppService ->", st); assert st == 200
print("now:", snap()["source"]["image"])
