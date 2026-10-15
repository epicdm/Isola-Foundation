r"""zz-uplink-ratelimit-off: PM v1.8 (owner decision dec-owner-pl-remove-temporary-pilot-limits-prepare-live-2026-10-14), item B, config-only part.
EasyPanel uplink/uplink-app-prod: set the three EXISTING rate-limit switches read by lib/agents/public-turn-limits.ts resolvePublicTurnLimits()
(defaults 12 per IP per minute / 150 per IP per day / 1500 per agent per day) to 9999999, the largest value their positiveInt parser (/^\d{1,7}$/) accepts. Image, every other env name and the rest of the definition must not change.
  python zz-uplink-ratelimit-off.py            -> snapshot (names + sha8, values never printed), add the three lines, diff (only those keys may differ), deploy
  REVERSE=1 python zz-uplink-ratelimit-off.py  -> prepared rollback: remove only those three lines, diff, deploy
Aborts if the image is not the verified 617d330b digest. Never prints env values."""
import os, sys, json, hashlib, importlib.util
here = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("epc", os.path.join(here, "zz-migrate-02-ep-client.py")); epc = importlib.util.module_from_spec(spec); spec.loader.exec_module(epc)
REVERSE = os.environ.get("REVERSE") == "1"
epc.rpc("initialize", {"protocolVersion": "2025-03-26", "capabilities": {}, "clientInfo": {"name": "lane-a-ratelimit-off", "version": "1"}})
epc.assert_host04()
P = {"projectName": "uplink", "serviceName": "uplink-app-prod"}
KEYS = ["PUBLIC_TURN_IP_PER_MINUTE", "PUBLIC_TURN_IP_PER_DAY", "PUBLIC_TURN_AGENT_PER_DAY"]
VAL = "9999999"
IMG = "617d330b17881d165ad80937162f426bb3c816e38188393bb98c009c13ca2bd9"
def insp():
    st, sc = epc.tool("execute_query", {"procedure": "inspectAppService", "input": P}); assert st == 200
    return epc.unwrap(sc)
def parse(e): return dict(l.split("=", 1) for l in e.splitlines() if "=" in l)
def h8(v): return hashlib.sha256(v.encode()).hexdigest()[:8]
cur = insp(); before = cur["env"]; b = parse(before)
assert IMG in cur["source"]["image"], ("unexpected image; refusing", cur["source"]["image"][-20:])
print("BEFORE env names (%d); image ends ...%s; replicas %s" % (len(b), cur["source"]["image"][-12:], cur["deploy"]["replicas"]))
open(os.path.join(here, "zz-uplink-ratelimit-off.pre-snapshot.%s.json" % ("rollback" if REVERSE else "apply")), "w").write(json.dumps({k: h8(v) for k, v in b.items()}, indent=1))
nonenv_before = json.dumps(epc.redact({k: v for k, v in cur.items() if k != "env"}), sort_keys=True)
lines = before.splitlines(); nl = "\n" if before.endswith("\n") else ""
if REVERSE:
    assert all(k in b for k in KEYS), "switches not present; nothing to roll back"
    new = "\n".join(l for l in lines if l.split("=", 1)[0] not in KEYS) + nl
else:
    assert not any(k in b for k in KEYS), "a switch is already present; refusing"
    new = before.rstrip("\n") + "\n" + "\n".join(k + "=" + VAL for k in KEYS) + nl
st, sc = epc.tool("execute_destructive", {"procedure": "updateAppEnv", "input": {**P, "env": new}}); print("updateAppEnv ->", st, json.dumps(epc.redact(sc))[:100]); assert st == 200
a = parse(insp()["env"]); diff = sorted(k for k in set(a) | set(b) if a.get(k) != b.get(k)); print("env keys:", len(b), "->", len(a), "| differing:", diff); assert diff == sorted(KEYS), diff
if not REVERSE: assert all(a[k] == VAL for k in KEYS)
mid = json.dumps(epc.redact({k: v for k, v in insp().items() if k != "env"}), sort_keys=True)
assert mid == nonenv_before, "non-env definition changed after env update; NOT deploying"
st, sc = epc.tool("execute_destructive", {"procedure": "deployAppService", "input": P}); print("deployAppService ->", st, json.dumps(epc.redact(sc))[:100]); assert st == 200
print("non-env definition identical before/after deploy:", mid == json.dumps(epc.redact({k: v for k, v in insp().items() if k != "env"}), sort_keys=True))
