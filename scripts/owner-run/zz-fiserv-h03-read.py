"""READ-ONLY: list host03's EasyPanel fiserv project services (env as NAME(len) only). Reuses the pinned client, re-pointed at host03."""
import importlib.util, os, sys, json
here = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("epc", os.path.join(here, "zz-migrate-02-ep-client.py")); epc = importlib.util.module_from_spec(spec); spec.loader.exec_module(epc)
epc.IP = "66.118.37.110"
epc.rpc("initialize", {"protocolVersion": "2025-03-26", "capabilities": {}, "clientInfo": {"name": "lane-a-fiserv-read", "version": "1"}})
st, sc = epc.tool("execute_query", {"procedure": "listProjects", "input": {}}); print("listProjects", st, json.dumps(epc.redact(sc))[:600])
