"""READ-ONLY helper: print the raw search_procedures result (names + input schema) for a query. Usage: python zz-panel-search.py "<query>" [grep-substring]"""
import sys, os, json, importlib.util
here = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("epc", os.path.join(here, "zz-migrate-02-ep-client.py")); epc = importlib.util.module_from_spec(spec); spec.loader.exec_module(epc)
epc.rpc("initialize", {"protocolVersion": "2025-03-26", "capabilities": {}, "clientInfo": {"name": "lane-a-search", "version": "1"}})
st, sc = epc.tool("search_procedures", {"query": sys.argv[1]})
txt = json.dumps(sc, indent=1)
if len(sys.argv) > 2:
    import re
    for blk in (sc.get("procedures") or sc.get("results") or sc if isinstance(sc, (list, dict)) else []):
        s = json.dumps(blk)
        if sys.argv[2].lower() in s.lower(): print(json.dumps(blk, indent=1)[:2500]); print("-----")
else:
    print(txt[:60000])
