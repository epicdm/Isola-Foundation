#!/usr/bin/env python3
# Runs ON host03. Reads the LIVE sf-relay-pl-prod spec and prints a current re-creation script.
# Emits secret NAMES + targets only (Swarm secrets are referenced, never read). Env: a value is emitted only when the NAME is
# not credential-like; credential-like names get a <SET-FROM-SECRET-STORE> marker so no value can leak into the script.
import json, re, subprocess, shlex
spec = json.loads(subprocess.check_output(["sudo", "-n", "docker", "service", "inspect", "sf-relay-pl-prod"]))[0]["Spec"]
cs = spec["TaskTemplate"]["ContainerSpec"]
CRED = re.compile(r"(SECRET|TOKEN|PASSW|PRIVATE|API_KEY|_KEY$|CREDENTIAL|AUTH)", re.I)
nets = [n.get("Target") for n in spec["TaskTemplate"].get("Networks", [])]
net_names = []
for n in nets:
    try: net_names.append(json.loads(subprocess.check_output(["sudo", "-n", "docker", "network", "inspect", n]))[0]["Name"])
    except Exception: net_names.append(n)
lines = ["#!/bin/bash",
  "# sf-relay-pl-prod RE-CREATION (generated from the live Swarm spec; secrets referenced by NAME, never read).",
  "# Use ONLY if the service was removed. Normal changes: `docker service update` (the Swarm spec is the deploy record).",
  "# Supersedes scratchpad f3_relay_create.sh (stale: rc6 image, website agent a5e7235d, 2 of 8 secrets).",
  'D="sudo -n docker"; N=sf-relay-pl-prod',
  '$D service inspect $N >/dev/null 2>&1 && { echo "$N exists - refusing (use service update)"; exit 2; }',
  "$D service create --name $N --replicas %d --no-resolve-image \\" % spec.get("Mode", {}).get("Replicated", {}).get("Replicas", 1)]
for n in net_names: lines.append("  --network %s \\" % shlex.quote(n))
for s in cs.get("Secrets", []):
    f = s.get("File", {})
    lines.append("  --secret source=%s,target=%s,mode=%s \\" % (s["SecretName"], f.get("Name"), oct(f.get("Mode", 0o444))[2:].rjust(4, "0")))
for e in cs.get("Env", []):
    k, _, v = e.partition("=")
    if CRED.search(k) and not k.endswith("_FILE") and not k.endswith("_KID"):
        lines.append("  --env %s=<SET-FROM-SECRET-STORE> \\" % k)
    else:
        lines.append("  --env %s \\" % shlex.quote(f"{k}={v}"))
lines.append("  --detach=true %s" % cs["Image"].split("@")[0])
print("\n".join(lines))
