"""READ-ONLY: every domain in host04's EasyPanel with its service, path and middlewares, plus where the hostname resolves publicly (via 8.8.8.8 raw query). Flags names that do NOT resolve to host04 (stale / future)."""
import os, json, socket, struct, random, importlib.util
here = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("epc", os.path.join(here, "zz-migrate-02-ep-client.py")); epc = importlib.util.module_from_spec(spec); spec.loader.exec_module(epc)
epc.rpc("initialize", {"protocolVersion": "2025-03-26", "capabilities": {}, "clientInfo": {"name": "lane-a-domains", "version": "1"}}); epc.assert_host04()
def resolve(name, server="8.8.8.8"):
    tid = random.randint(0, 65535); hdr = struct.pack(">HHHHHH", tid, 0x0100, 1, 0, 0, 0)
    qn = b"".join(bytes([len(p)]) + p.encode() for p in name.split(".")) + b"\0"
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.settimeout(3)
    try:
        s.sendto(hdr + qn + struct.pack(">HH", 1, 1), (server, 53)); d, _ = s.recvfrom(2048)
    except Exception: return "?"
    an = struct.unpack(">H", d[6:8])[0]; i = 12
    while d[i] != 0: i += d[i] + 1
    i += 5; out = []
    for _ in range(an):
        i += 2 if d[i] & 0xC0 == 0xC0 else 0
        t, c, ttl, ln = struct.unpack(">HHIH", d[i:i + 10]); i += 10
        if t == 1: out.append("%d.%d.%d.%d" % tuple(d[i:i + 4]))
        i += ln
    return ",".join(out) or "none"
st, sc = epc.tool("execute_query", {"procedure": "listProjectsAndServices", "input": {}})
services = [(s["projectName"], s["name"], s.get("type")) for s in epc.unwrap(sc)["services"] if s.get("type") in ("app", "compose")]
rows = []
for p, s, t in services:
    st, sc = epc.tool("execute_query", {"procedure": "listDomains", "input": {"projectName": p, "serviceName": s}})
    if st != 200: continue
    for d in epc.unwrap(sc): rows.append((d["host"], d.get("path"), f"{p}/{s}", d.get("middlewares") or []))
cache = {}
for h, path, svc, mw in sorted(rows):
    cache.setdefault(h, resolve(h))
    flag = "" if cache[h] == "66.118.37.29" else "   <-- resolves to " + cache[h]
    print(f"{h:44} {path:28} {svc:34} mw={mw}{flag}")
print("total domains:", len(rows), "| hosts not resolving to host04:", sum(1 for h in cache if cache[h] != "66.118.37.29"))
