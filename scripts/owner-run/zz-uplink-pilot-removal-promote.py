"""zz-uplink-pilot-removal-promote: image-only promotion of EasyPanel uplink/uplink-app-prod to the pilot-restriction-removal candidate
(owner decision dec-owner-pl-remove-temporary-pilot-limits-prepare-live-2026-10-14; handoff .workbench/codex-handoff-pilot-removal-617d330b-2026-10-14).
Mirrors zz-uplink-pilot-overlay-promote.py, but the rollback target is the image running TODAY (617d330b), not the older ghcr 9306368.
  NEW_IMAGE=localhost:5000/pl/uplink-app@sha256:<digest> python zz-uplink-pilot-removal-promote.py   -> 617d330b -> NEW, diff (only source.image), deploy
  NEW_IMAGE=... REVERSE=1 python zz-uplink-pilot-removal-promote.py                                   -> NEW -> 617d330b, deploy
Definition captured in-process, never printed (env shown as a count only)."""
import sys, os, json, importlib.util
here = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("epc", os.path.join(here, "zz-migrate-02-ep-client.py")); epc = importlib.util.module_from_spec(spec); spec.loader.exec_module(epc)
CURRENT = "localhost:5000/pl/uplink-app@sha256:617d330b17881d165ad80937162f426bb3c816e38188393bb98c009c13ca2bd9"
NEW = os.environ.get("NEW_IMAGE", "")
assert NEW.startswith("localhost:5000/pl/uplink-app@sha256:") and NEW != CURRENT, "NEW_IMAGE must be the digest-pinned candidate"
REVERSE = os.environ.get("REVERSE") == "1"
FROM, TO = (NEW, CURRENT) if REVERSE else (CURRENT, NEW)
P = {"projectName": "uplink", "serviceName": "uplink-app-prod"}
epc.rpc("initialize", {"protocolVersion": "2025-03-26", "capabilities": {}, "clientInfo": {"name": "lane-a-pilot-removal-promote", "version": "1"}})
print("host04 projects:", epc.assert_host04())
def read():
    st, sc = epc.tool("execute_query", {"procedure": "inspectAppService", "input": P}); assert st == 200
    r = dict(epc.unwrap(sc)); r.pop("deploymentUrl", None); return r
def flat(o, p=""):
    if isinstance(o, dict):
        for k, v in o.items(): yield from flat(v, p + "." + k)
    else: yield p, o
before = read()
print("BEFORE source.image:", before["source"]["image"], "| replicas:", before["deploy"]["replicas"], "| env names:", len(epc.redact({"env": before["env"]})["env"]))
assert before["source"]["image"] == FROM, "unexpected starting image; abort"
st, sc = epc.tool("execute_destructive", {"procedure": "updateAppSourceImage", "input": dict(P, image=TO)}); print("updateAppSourceImage ->", st); assert st == 200
after = read()
b, a = dict(flat(before)), dict(flat(after)); diff = sorted(k for k in set(a) | set(b) if a.get(k) != b.get(k))
print("DIFF keys:", diff)
if diff != [".source.image"] or after["source"]["image"] != TO: print("UNEXPECTED CHANGES -> NOT deploying"); sys.exit(4)
st, sc = epc.tool("execute_destructive", {"procedure": "deployAppService", "input": P}); print("deployAppService ->", st)
sys.exit(0 if st == 200 else 5)
