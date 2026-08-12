#!/usr/bin/env bash
#
# Meta egress topology verifier.
#
# Answers one question: is every designated protected service STILL confined to
# networks that have no path to the internet, while the gateway alone retains
# one?
#
# FAILS CLOSED. A service that cannot be inspected, has no running task, or
# whose namespace cannot be entered is a FAILURE, never a skip. Absence of
# evidence must not produce PASS.
#
# Probes carry no credential: an unauthenticated HTTPS connect and a gateway
# health call, nothing more.
set -uo pipefail

CONF=/etc/meta-egress/protected-services.conf
CREDFREE_CONF=/etc/meta-egress/credential-free-services.conf
RETIRED_CONF=/etc/meta-egress/retired-services.conf
ALERTS=/var/lib/meta-egress/alerts.jsonl
GATEWAY_SERVICE=meta-egress-gateway
EXTERNAL_NET=meta-egress

# PROBES ARE BY IP, DELIBERATELY.
#
# `nsenter -t PID -n` enters only the NETWORK namespace; the mount namespace
# stays the host's, so name resolution still uses the host's /etc/resolv.conf
# and Docker's embedded DNS is not consulted. A name-based probe therefore fails
# for both a genuinely isolated service and a perfectly healthy one, which makes
# it useless as evidence. The first run of this verifier reported exactly that
# false failure.
#
# Resolving on the host and probing the address tests pure network reachability,
# which is the property being verified.
GRAPH_IP="$(getent ahostsv4 graph.facebook.com 2>/dev/null | awk '{print $1}' | head -1)"
GW_PORT=3000

mkdir -p "$(dirname "$ALERTS")" /etc/meta-egress
[ -f "$CONF" ] || printf '%s\n' "meta-egress-monitor" > "$CONF"
[ -f "$CREDFREE_CONF" ] || : > "$CREDFREE_CONF"
[ -f "$RETIRED_CONF" ] || : > "$RETIRED_CONF"

FAIL=0; CHECKS=0
declare -a FAILURES=()
ok(){   CHECKS=$((CHECKS+1)); printf '  PASS  %s\n' "$1"; }
bad(){  CHECKS=$((CHECKS+1)); FAIL=$((FAIL+1)); FAILURES+=("$1"); printf '  FAIL  %s\n' "$1"; }

alert(){ # severity reason
  printf '{"event":"meta.egress.topology_verify","ts":"%s","result":"FAIL","severity":"%s","reason":"%s"}\n' \
    "$(date -Iseconds)" "$1" "$2" >> "$ALERTS"
}

# A network is APPROVED for a protected service when it is BOTH internal and
# encrypted. Approval is by PROPERTY, not by name.
#
# The previous version carried a hardcoded name list, which would have rejected
# the new Chatwoot ingress and data networks purely for being new. Property
# checks are also the stronger test: `Internal=true` is what actually removes
# the egress path, so a network that has it is safe whatever it is called, and a
# network that lacks it is unsafe however familiar the name.
net_approved(){ # name -> 0 approved, 1 not
  local n="$1" int enc
  int=$(docker network inspect "$n" --format '{{.Internal}}' 2>/dev/null)
  enc=$(docker network inspect "$n" --format '{{index .Options "encrypted"}}' 2>/dev/null)
  [ "$int" = "true" ] && [ -n "$enc" ]
}

echo "=== 1. the Meta lane's own protected networks ==="
for n in meta-egress-internal isola-protected; do
  if ! docker network inspect "$n" >/dev/null 2>&1; then
    bad "network $n does not exist (recreated or removed?)"; continue
  fi
  INT=$(docker network inspect "$n" --format '{{.Internal}}' 2>/dev/null)
  ENC=$(docker network inspect "$n" --format '{{index .Options "encrypted"}}' 2>/dev/null)
  [ "$INT" = "true" ] && ok "$n Internal=true" || bad "$n Internal=$INT (MUST be true)"
  [ -n "$ENC" ] && ok "$n encrypted" || bad "$n is not encrypted"
done

echo
echo "=== 2. only the gateway is attached to the external network ==="
if ! docker network inspect "$EXTERNAL_NET" >/dev/null 2>&1; then
  bad "external network $EXTERNAL_NET missing"
else
  MEMBERS=$(docker network inspect "$EXTERNAL_NET" --format '{{range .Containers}}{{.Name}} {{end}}' 2>/dev/null)
  UNEXPECTED=""
  for m in $MEMBERS; do
    case "$m" in
      ${GATEWAY_SERVICE}*|*-endpoint) : ;;
      *) UNEXPECTED="$UNEXPECTED $m" ;;
    esac
  done
  if [ -z "$UNEXPECTED" ]; then
    ok "external network members are gateway-only"
  else
    bad "UNAUTHORIZED attachment to $EXTERNAL_NET:$UNEXPECTED"
  fi
fi

echo
echo "=== gateway address on the internal network (probe target) ==="
GW_CID=$(docker ps --filter "name=$GATEWAY_SERVICE" --format '{{.ID}}' | head -1)
GW_IP=""
if [ -n "$GW_CID" ]; then
  GW_IP=$(docker inspect "$GW_CID" --format '{{range $k,$v := .NetworkSettings.Networks}}{{if eq $k "meta-egress-internal"}}{{$v.IPAddress}}{{end}}{{end}}' 2>/dev/null)
fi
[ -n "$GW_IP" ] && ok "gateway internal address resolved" || bad "cannot resolve the gateway's internal address (fails closed)"

echo
echo "=== 3-6. each designated protected service ==="
while read -r SVC; do
  [ -z "$SVC" ] && continue
  case "$SVC" in \#*) continue ;; esac
  echo "  -- $SVC"

  if ! docker service inspect "$SVC" >/dev/null 2>&1; then
    bad "$SVC: cannot inspect service (fails closed)"; continue
  fi

  # 3+4: every network attachment must be internal AND encrypted
  NETIDS=$(docker service inspect "$SVC" --format '{{range .Spec.TaskTemplate.Networks}}{{.Target}} {{end}}' 2>/dev/null)
  if [ -z "$NETIDS" ]; then
    bad "$SVC: no network attachments readable (fails closed)"; continue
  fi
  ATTACHED=""; BADNET=""
  for id in $NETIDS; do
    NAME=$(docker network inspect "$id" --format '{{.Name}}' 2>/dev/null)
    [ -z "$NAME" ] && { BADNET="$BADNET <unreadable:$id>"; continue; }
    ATTACHED="$ATTACHED $NAME"
    if ! net_approved "$NAME"; then
      INT=$(docker network inspect "$NAME" --format '{{.Internal}}' 2>/dev/null)
      ENC=$(docker network inspect "$NAME" --format '{{index .Options "encrypted"}}' 2>/dev/null)
      BADNET="$BADNET $NAME(Internal=${INT:-?},encrypted=${ENC:-no})"
    fi
  done
  if [ -z "$BADNET" ]; then
    ok "$SVC: every network is internal+encrypted:$ATTACHED"
  else
    bad "$SVC: DISALLOWED network exposure:$BADNET"
  fi

  # 5+6: probe EVERY running task, not just the first.
  # A service with more than one replica must not be judged by one container:
  # partial inspection is a silent exclusion, and the standard here is complete
  # inspection or failure.
  CIDS=$(docker ps --filter "name=$SVC" --format '{{.ID}}')
  if [ -z "$CIDS" ]; then
    bad "$SVC: no running task to probe (fails closed)"; continue
  fi
  DESIRED=$(docker service inspect "$SVC" --format '{{if .Spec.Mode.Replicated}}{{.Spec.Mode.Replicated.Replicas}}{{else}}?{{end}}' 2>/dev/null)
  RUNNING=$(printf '%s\n' "$CIDS" | grep -c .)
  if [ "$DESIRED" != "?" ] && [ -n "$DESIRED" ] && [ "$RUNNING" != "$DESIRED" ]; then
    bad "$SVC: $RUNNING running task(s) but $DESIRED desired - inspection would be incomplete"
  fi

  TASKN=0
  for CID in $CIDS; do
    TASKN=$((TASKN+1))
    PID=$(docker inspect "$CID" --format '{{.State.Pid}}' 2>/dev/null)
    if [ -z "$PID" ] || [ "$PID" = "0" ]; then
      bad "$SVC task#$TASKN: cannot resolve namespace pid (fails closed)"; continue
    fi

    if [ -z "$GRAPH_IP" ]; then
      bad "$SVC task#$TASKN: no Graph address resolved on the host to probe with (fails closed)"
    else
      DIRECT=$(nsenter -t "$PID" -n curl -sk -o /dev/null -w '%{http_code}' -m 8 "https://$GRAPH_IP/" 2>/dev/null)
      [ -z "$DIRECT" ] && DIRECT=000
      if [ "$DIRECT" = "000" ]; then
        ok "$SVC task#$TASKN: direct Graph probe DENIED (000)"
      else
        bad "$SVC task#$TASKN: REACHED Meta directly (HTTP $DIRECT)"
      fi
    fi

    if [ -z "${GW_IP:-}" ]; then
      bad "$SVC task#$TASKN: gateway address unknown, cannot prove reachability (fails closed)"
    else
      GW=$(nsenter -t "$PID" -n curl -s -m 8 "http://$GW_IP:$GW_PORT/healthz" 2>/dev/null | head -c 120)
      case "$GW" in
        *'"status"'*) ok "$SVC task#$TASKN: gateway reachable" ;;
        *)            bad "$SVC task#$TASKN: gateway UNREACHABLE" ;;
      esac
    fi
  done
done < "$CONF"

echo
echo "=== 6b. services required to be credential-free ==="
CF=0
while read -r SVC; do
  [ -z "$SVC" ] && continue
  case "$SVC" in \#*) continue ;; esac
  CF=$((CF+1))
  if ! docker service inspect "$SVC" >/dev/null 2>&1; then
    bad "$SVC: cannot inspect credential-free service (fails closed)"; continue
  fi
  SECRETS=$(docker service inspect "$SVC" --format '{{range .Spec.TaskTemplate.ContainerSpec.Secrets}}{{.SecretName}} {{end}}' 2>/dev/null | tr -s ' ')
  # Names only. No value is read or printed.
  ENVKEYS=$(docker service inspect "$SVC" --format '{{range .Spec.TaskTemplate.ContainerSpec.Env}}{{println .}}{{end}}' 2>/dev/null \
            | grep -oiE '^[A-Z0-9_]*(TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL)[A-Z0-9_]*=' | sed 's/=$//' | sort -u | tr '\n' ' ')
  if [ -z "$(printf '%s' "$SECRETS" | tr -d ' ')" ]; then
    ok "$SVC: no Swarm secret mounted"
  else
    bad "$SVC: mounts secret(s):$SECRETS"
  fi
  if [ -z "$ENVKEYS" ]; then
    ok "$SVC: no credential-shaped environment key"
  else
    bad "$SVC: credential-shaped env key(s): $ENVKEYS"
  fi
done < "$CREDFREE_CONF"
[ "$CF" = "0" ] && echo "  (none configured)"

echo
echo "=== 6c. superseded services must be fully stopped ==="
#
# After a migration the OLD Rails/Sidekiq services must not still be running:
# two live processors on one number is the zero-overlap violation the cutover
# exists to prevent. Full removal is the strongest state; zero replicas is
# accepted; anything running is a failure.
#
# HONEST LIMIT, stated rather than implied: this inspects the SERVICE, not the
# database. If the old and new stacks share a Chatwoot database volume, the
# workload token lives in `channel_whatsapp.provider_config` and is reachable by
# whichever service is running. These checks prove the old service is not
# running and mounts no secret of its own; they do NOT prove a data-layer
# separation that does not exist. Token custody across a shared database is a
# main-lane data question.
RT=0
while read -r SVC; do
  [ -z "$SVC" ] && continue
  case "$SVC" in \#*) continue ;; esac
  RT=$((RT+1))
  PRESENT=$(docker service ls --filter "name=$SVC" --format '{{.Name}}' 2>/dev/null | grep -Fx "$SVC" || true)
  if [ -z "$PRESENT" ]; then
    ok "$SVC: not present (fully removed)"
    continue
  fi
  DESIRED=$(docker service inspect "$SVC" --format '{{if .Spec.Mode.Replicated}}{{.Spec.Mode.Replicated.Replicas}}{{else}}?{{end}}' 2>/dev/null)
  RUNNING=$(docker ps --filter "name=$SVC" --format '{{.ID}}' 2>/dev/null | grep -c . || true)
  [ "$RUNNING" = "0" ] && ok "$SVC: 0 running tasks" || bad "$SVC: STILL RUNNING ($RUNNING task(s)) - two processors risk"
  [ "$DESIRED" = "0" ] && ok "$SVC: desired replicas = 0" || bad "$SVC: desired replicas = ${DESIRED:-?} (must be 0)"
  SEC=$(docker service inspect "$SVC" --format '{{range .Spec.TaskTemplate.ContainerSpec.Secrets}}{{.SecretName}} {{end}}' 2>/dev/null | tr -s ' ' | sed 's/^ *//;s/ *$//')
  [ -z "$SEC" ] && ok "$SVC: mounts no Swarm secret" || bad "$SVC: still mounts secret(s): $SEC"
done < "$RETIRED_CONF"
[ "$RT" = "0" ] && echo "  (none configured)"

echo
echo "=== 7. gateway itself must retain egress ==="
GCID=$(docker ps --filter "name=$GATEWAY_SERVICE" --format '{{.ID}}' | head -1)
if [ -z "$GCID" ]; then
  bad "gateway has no running task (fails closed)"
else
  GPID=$(docker inspect "$GCID" --format '{{.State.Pid}}' 2>/dev/null)
  if [ -z "$GRAPH_IP" ]; then
    bad "cannot probe gateway egress without a resolved Graph address (fails closed)"
  else
    GD=$(nsenter -t "$GPID" -n curl -sk -o /dev/null -w '%{http_code}' -m 8 "https://$GRAPH_IP/" 2>/dev/null)
    [ -z "$GD" ] && GD=000
    [ "$GD" != "000" ] && ok "gateway retains Meta egress (HTTP $GD)" || bad "gateway LOST Meta egress"
  fi
fi

# Chatwoot-specific verdict, emitted only when Chatwoot services are in scope,
# so the cutover gate has an unambiguous line to key on.
CW=$(grep -vE '^\s*#' "$CONF" 2>/dev/null | grep -cE 'isola_chat($|[^a-z])|sidekiq' || true)
echo
if [ "$FAIL" -eq 0 ]; then
  printf '{"event":"meta.egress.topology_verify","ts":"%s","result":"PASS","checks":%s}\n' "$(date -Iseconds)" "$CHECKS" >> "$ALERTS"
  [ "$CW" -gt 0 ] && echo "CHATWOOT CONFINEMENT PASS"
  echo "RESULT PASS  checks=$CHECKS"
  exit 0
else
  R=$(printf '%s; ' "${FAILURES[@]}" | sed 's/"/'"'"'/g' | cut -c1-400)
  alert critical "$R"
  [ "$CW" -gt 0 ] && echo "CHATWOOT CONFINEMENT FAIL"
  echo "RESULT FAIL  checks=$CHECKS failures=$FAIL"
  exit 1
fi
