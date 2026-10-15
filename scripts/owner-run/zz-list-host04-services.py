"""READ-ONLY: list host04 EasyPanel project/service NAMES and types only (no env, no secrets printed)."""
import os, importlib.util, json
here = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("epc", os.path.join(here, "zz-migrate-02-ep-client.py")); epc = importlib.util.module_from_spec(spec); spec.loader.exec_module(epc)
epc.rpc("initialize", {"protocolVersion": "2025-03-26", "capabilities": {}, "clientInfo": {"name": "lane-a-list", "version": "1"}}); epc.assert_host04()
st, sc = epc.tool("execute_query", {"procedure": "listProjectsAndServices", "input": {}})
r = epc.unwrap(sc)
projects = r.get("projects", []) if isinstance(r, dict) else []
services = r.get("services", []) if isinstance(r, dict) else []
by = {}
for s in services:
    by.setdefault(s.get("projectName"), []).append(f"{s.get('name')}[{s.get('type')}{'' if s.get('enabled', True) else ',DISABLED'}]")
for p in projects:
    n = p.get("name") if isinstance(p, dict) else p
    print(n + ":", ", ".join(sorted(by.get(n, []))) or "(none)")
