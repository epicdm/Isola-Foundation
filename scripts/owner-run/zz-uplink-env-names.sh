#!/bin/bash
# READ-ONLY: env NAMES (never values) on the running uplink-app-prod service spec, grouped by prefix of interest; plus value LENGTH/shape for numeric tuning names only.
S=$(docker service inspect uplink_uplink-app-prod --format '{{range .Spec.TaskTemplate.ContainerSpec.Env}}{{println .}}{{end}}')
echo "total names: $(echo "$S" | grep -c .)"
echo "$S" | cut -d= -f1 | sort | tr '\n' ' '
echo
echo "--- numeric/boolean tuning names (value shown only if purely digits or true/false):"
echo "$S" | grep -E '^(PUBLIC_PILOT|UPLINK_RELAY|PILOT|METER|SPEND|RATE|MAX_|LLM_|AGENT_)' | while IFS='=' read k v; do if echo "$v" | grep -qE '^([0-9._]+|true|false)$'; then echo "$k=$v"; else echo "$k=<${#v} chars>"; fi; done
