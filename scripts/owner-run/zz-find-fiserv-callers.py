"""READ-ONLY: for every host04 app service, list env NAMES (never values) that look Fiserv/api01-related, and whether the VALUE mentions api01 / fiserv host (boolean only)."""
import os, importlib.util, json, re
here = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("epc", os.path.join(here, "zz-migrate-02-ep-client.py")); epc = importlib.util.module_from_spec(spec); spec.loader.exec_module(epc)
epc.rpc("initialize", {"protocolVersion": "2025-03-26", "capabilities": {}, "clientInfo": {"name": "lane-a-callers", "version": "1"}}); epc.assert_host04()
SV = [("uplink","plsvc-app"),("uplink","pl-action-adapter"),("uplink","uplink-app-prod"),("uplink","relay"),("agents","hermes-agent")]
st, sc = epc.tool("execute_query", {"procedure": "listProjects", "input": {}})
for proj, svc in SV:
    st, sc = epc.tool("execute_query", {"procedure": "inspectAppService", "input": {"projectName": proj, "serviceName": svc}})
    if st != 200: print(proj, svc, "inspect failed", st); continue
    env = epc.unwrap(sc).get("env", "")
    hits = []
    for line in env.splitlines():
        if "=" not in line: continue
        k, v = line.split("=", 1)
        if re.search(r"fiserv|payment|pay_|topup|checkout", k, re.I) or re.search(r"api01|fiserv|saas00|fiserv_fiserv", v, re.I):
            hits.append(f"{k}{'  [value mentions api01/fiserv: ' + ('api01' if 'api01' in v else 'saas00' if 'saas00' in v else 'fiserv-internal' if 'fiserv_fiserv' in v else 'other') + ']' if re.search(r'api01|fiserv|saas00', v, re.I) else ''}")
    print(f"{proj}/{svc}: {hits or 'none'}")
