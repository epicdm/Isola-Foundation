#!/usr/bin/env bash
#
# Meta egress enforcement — idempotent installer and verifier.
#
# Runs at boot, on a timer, and after any Docker restart. Docker rebuilds the
# DOCKER-USER chain when it restarts, which silently drops custom rules; the
# timer is what makes this a control rather than a one-time change.
#
# SHAPE OF THE RULE SET, per protected network:
#   1. ACCEPT  intra-subnet          (containers may talk to each other)
#   2. ACCEPT  the gateway's own IP  (only on meta-egress; the gateway needs Meta)
#   3. DROP    everything else out   (default-deny egress)
#
# Deliberately NOT an IP list of Meta's CDN: blocking a CDN by address is a
# losing game. Default-deny by source is robust and does not decay.
#
# Scope is the networks named below and nothing else. Unrelated production
# traffic on other networks is untouched by design.
set -uo pipefail

TAG="ISOLA-META-EGRESS"
PROTECTED_NETS="meta-egress isola-protected"
GATEWAY_SERVICE="meta-egress-gateway"
STATE="/var/lib/meta-egress"
mkdir -p "$STATE"

log(){ printf '{"event":"meta.egress.enforce","ts":"%s","msg":"%s"}\n' "$(date -Is)" "$1"; }

subnet_of(){ docker network inspect "$1" --format '{{range .IPAM.Config}}{{.Subnet}} {{end}}' 2>/dev/null | tr -s ' ' '\n' | grep -E '^[0-9]' | head -1; }

gateway_ip(){
  local cid
  cid=$(docker ps --filter "name=${GATEWAY_SERVICE}" --format '{{.ID}}' | head -1)
  [ -n "$cid" ] || return 1
  docker inspect "$cid" --format '{{range $k,$v := .NetworkSettings.Networks}}{{if eq $k "meta-egress"}}{{$v.IPAddress}}{{end}}{{end}}' 2>/dev/null
}

# Remove every rule this control owns, so re-application is exact.
flush_ours(){
  local n=0
  while iptables -L DOCKER-USER -n --line-numbers 2>/dev/null | grep -q "$TAG"; do
    local line
    line=$(iptables -L DOCKER-USER -n --line-numbers | grep "$TAG" | head -1 | awk '{print $1}')
    [ -n "$line" ] || break
    iptables -D DOCKER-USER "$line" 2>/dev/null || break
    n=$((n+1))
    [ "$n" -gt 60 ] && break
  done
  echo "$n"
}

case "${1:-apply}" in
  apply)
    REMOVED=$(flush_ours)
    APPLIED=0
    DEFERRED=""

    # Wait briefly for the gateway task. At boot this unit can run before Docker
    # has started the service, and the first post-reboot run did exactly that:
    # it logged `applied=4 gateway_ip=none` and installed a deny for the
    # meta-egress subnet with no matching allow for the gateway.
    GWIP=""
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      GWIP="$(gateway_ip || true)"
      [ -n "$GWIP" ] && break
      sleep 3
    done

    # Rules are INSERTED at the top in reverse priority so the final order is:
    #   intra-subnet ACCEPT, gateway ACCEPT, subnet DROP
    for net in $PROTECTED_NETS; do
      SUB="$(subnet_of "$net")"
      [ -n "$SUB" ] || continue

      # NEVER install a deny without the allow it depends on. If the gateway
      # address is not yet knowable, the meta-egress rules are skipped whole and
      # the timer completes them on its next pass. A partial rule set is a worse
      # outcome than no rule set: the structural `--internal` denial is what
      # actually enforces isolation, and this layer must not degrade the
      # gateway's own egress while pretending to be in force.
      if [ "$net" = "meta-egress" ] && [ -z "$GWIP" ]; then
        DEFERRED="$DEFERRED $net"
        continue
      fi

      iptables -I DOCKER-USER 1 -s "$SUB" -j DROP \
        -m comment --comment "$TAG deny-egress $net" && APPLIED=$((APPLIED+1))

      if [ "$net" = "meta-egress" ]; then
        iptables -I DOCKER-USER 1 -s "$GWIP/32" -j RETURN \
          -m comment --comment "$TAG allow-gateway $net" && APPLIED=$((APPLIED+1))
      fi

      iptables -I DOCKER-USER 1 -s "$SUB" -d "$SUB" -j RETURN \
        -m comment --comment "$TAG allow-intra $net" && APPLIED=$((APPLIED+1))
    done

    # IPv6 parity: deny outright on protected nets. A v4-only rule set is not a
    # boundary, and these networks have no legitimate v6 egress.
    if command -v ip6tables >/dev/null 2>&1 && ip6tables -L DOCKER-USER -n >/dev/null 2>&1; then
      while ip6tables -L DOCKER-USER -n --line-numbers 2>/dev/null | grep -q "$TAG"; do
        l=$(ip6tables -L DOCKER-USER -n --line-numbers | grep "$TAG" | head -1 | awk '{print $1}')
        [ -n "$l" ] || break
        ip6tables -D DOCKER-USER "$l" 2>/dev/null || break
      done
      for net in $PROTECTED_NETS; do
        S6=$(docker network inspect "$net" --format '{{range .IPAM.Config}}{{.Subnet}} {{end}}' 2>/dev/null | tr -s ' ' '\n' | grep ':' | head -1)
        [ -n "$S6" ] && ip6tables -I DOCKER-USER 1 -s "$S6" -j DROP -m comment --comment "$TAG deny-egress-v6 $net" && APPLIED=$((APPLIED+1))
      done
    fi

    printf '%s' "$(date -Is)" > "$STATE/last-apply"
    printf '%s' "$APPLIED" > "$STATE/rule-count"
    if [ -n "$DEFERRED" ]; then
      log "applied=$APPLIED removed=$REMOVED gateway_ip=none deferred=${DEFERRED# } reason=gateway-not-ready"
      # Non-zero so the unit is visibly incomplete rather than silently partial.
      exit 75
    fi
    log "applied=$APPLIED removed=$REMOVED gateway_ip=${GWIP:-none}"
    ;;

  verify)
    EXPECT=$(cat "$STATE/rule-count" 2>/dev/null || echo 0)
    ACTUAL=$(iptables -L DOCKER-USER -n 2>/dev/null | grep -c "$TAG" || true)
    if [ "$ACTUAL" -lt 1 ] || [ "$ACTUAL" != "$EXPECT" ]; then
      log "DRIFT expected=$EXPECT actual=$ACTUAL"
      exit 1
    fi
    log "ok rules=$ACTUAL"
    ;;

  remove)
    N=$(flush_ours)
    while command -v ip6tables >/dev/null 2>&1 && ip6tables -L DOCKER-USER -n --line-numbers 2>/dev/null | grep -q "$TAG"; do
      l=$(ip6tables -L DOCKER-USER -n --line-numbers | grep "$TAG" | head -1 | awk '{print $1}')
      [ -n "$l" ] || break
      ip6tables -D DOCKER-USER "$l" 2>/dev/null || break
    done
    rm -f "$STATE/rule-count"
    log "removed=$N (rollback complete; only this control's rules were touched)"
    ;;

  show)
    iptables -L DOCKER-USER -n --line-numbers | grep -E "num|$TAG" || echo "(no rules)"
    ;;
esac
