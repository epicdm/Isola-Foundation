#!/usr/bin/env bash
# 10-host04-firewall-owner-run.sh  --  OWNER-RUN. Lane A prepared it; Lane A has NOT run it.
#
# Host: host04 (66.118.37.29), standalone Swarm + EasyPanel. Ubuntu 24.04, nftables 1.0.9,
# Docker 29.9.0 with the *iptables* firewall backend (docker info: FirewallBackend iptables).
#
# WHAT IT DOES (and why it works with Docker - see 00-current-state-baseline.md):
#   Docker publishes 3000/80/443 in mode=host through docker-proxy + DNAT. External IPv4 traffic is
#   DNAT'ed in nat/PREROUTING and then FORWARDed, so it NEVER crosses the INPUT chain (that is why
#   ufw would do nothing). IPv6 has no NAT rule: it reaches docker-proxy on [::]:PORT in INPUT.
#   So the guard needs BOTH paths:
#     * input   hook : v4 + v6, drops from the public interface (22, 3000, 2377, 7946, 4789 [, 80/443])
#     * forward hook : matches the ORIGINAL destination port (ct original proto-dst) after DNAT.
#   The rules live in their OWN nftables table `inet host04_guard`, at priority -10 (ahead of Docker's
#   iptables-nft chains, priority 0). Docker's docs sanction exactly this ("rules can be added in
#   separate tables ... base chain priority") and say Docker never owns/flushes foreign tables, so
#   the rules survive a dockerd restart without re-application (DOCKER-USER, by contrast, is
#   re-created by dockerd, which is why host03 needs a 3-minute timer). The persistent unit below
#   still re-asserts on drift (reboot, `nft flush ruleset` by another tool).
#   Rules are DROP-only: nothing here can override a Docker or tailscale ACCEPT/DROP, and a
#   non-public interface (lo, tailscale0, docker*, ens192) is accepted early = never touched.
#
# SAFETY:
#   * `plan`    prints the ruleset and a before/after diff. Changes nothing. Safe anywhere.
#   * `apply`   snapshots, ARMS AN AUTOMATIC REVERT (systemd-run --on-active=5min), then applies.
#               Refuses if your own SSH source would be locked out. Existing SSH sessions survive
#               (ct state established,related is accepted for tcp/22 BEFORE the admin check).
#   * `confirm` run ONLY after you proved ssh + console access from a SECOND window: cancels the
#               auto-revert and installs the persistent unit + drift timer.
#   * `revert`  immediate manual revert (same script the timer runs).
#
# ADMIN SOURCES (CONFIRM/EDIT): default ADMIN_CIDRS4=66.118.37.10/32 = the workstation egress seen in the live
#   ssh logins on host04 (and host03). Tailscale (100.64.0.0/10) arrives on tailscale0 and is NEVER filtered,
#   so it is admin-allowed by construction. Add more with ADMIN_CIDRS4="66.118.37.10/32 a.b.c.d/32".
#
# COPY/PASTE (from the workstation, Foundation worktree):
#   scp ops/personal-line/migration/host04/10-host04-firewall-*.sh epicadmin@66.118.37.29:/tmp/
#   ssh epicadmin@66.118.37.29
#   cd /tmp && sudo ADMIN_CIDRS4="66.118.37.10/32" bash 10-host04-firewall-owner-run.sh plan     # no change
#   sudo ADMIN_CIDRS4="66.118.37.10/32" bash 10-host04-firewall-owner-run.sh apply    # auto-reverts in 5 min
#   (second window)  ssh epicadmin@66.118.37.29 ; http://100.116.115.19:3000 over tailscale ;
#   (workstation)    powershell -File 20-host04-verify-external.ps1 -Phase After
#   sudo bash 10-host04-firewall-owner-run.sh confirm      # ONLY if all of the above worked
#   Optional: WEB_MODE=restricted WEB_CIDRS4="66.118.37.10/32" restricts 80/443 to the admin (default: public).
# NOTE on DOCKER-USER: rules are in table `inet host04_guard` (forward hook, priority -10, matching
#   ct original proto-dst after the DNAT) = the nftables equivalent Docker documents for DOCKER-USER, and it is
#   not wiped when dockerd re-creates DOCKER-USER. Proven 33/33 in 15-host04-firewall-netns-selftest.sh.
#
# USAGE (as root, on host04):
#   ADMIN_CIDRS4="66.118.37.10/32 203.0.113.7/32" ./10-host04-firewall-owner-run.sh plan
#   ADMIN_CIDRS4="..." ./10-host04-firewall-owner-run.sh apply
#   # second window: ssh in; open http://100.116.115.19:3000 (tailscale) or via the tunnel;
#   ./10-host04-firewall-owner-run.sh confirm
#
# PARAMETERS (environment; defaults shown). CONFIRM ADMIN_CIDRS4 BEFORE APPLY.
#   PUB_IF          public interface                     ens160
#   ADMIN_CIDRS4    space-separated IPv4 CIDRs allowed to reach ssh(22) and console(3000)
#                   default = the source seen in the two live ssh sessions + the Lane A workstation
#                   egress: 66.118.37.10/32.  Tailscale (100.64.0.0/10) arrives on tailscale0 and is
#                   never filtered, so it needs no entry.
#   ADMIN_CIDRS6    IPv6 CIDRs (default empty = no IPv6 admin source; use tailscale for IPv6 admin)
#   WEB_MODE        public | restricted   (80/443 = Traefik)       public
#                   RECOMMENDED public: Let's Encrypt HTTP-01 validates from many public IPs and
#                   renewals need :80; Traefik only answers hostnames that have a router (default
#                   404), and every app sits behind its own login with all outbound disabled.
#                   Use `restricted` only after certs are issued and only with WEB_CIDRS4/6 set.
#   WEB_CIDRS4/6    sources allowed on 80/443 when WEB_MODE=restricted
#   PEER_CIDRS4/6   Swarm peer nodes for 2377/7946/4789. DEFAULT EMPTY: host04 is a standalone
#                   single-node swarm (Swarm NodeAddr 127.0.0.1, nodes=1). Fill ONLY if clustering
#                   ever becomes a requirement.
#   REVERT_AFTER    auto-revert delay                    5min
set -euo pipefail

PUB_IF="${PUB_IF:-ens160}"
ADMIN_CIDRS4="${ADMIN_CIDRS4:-66.118.37.10/32}"
ADMIN_CIDRS6="${ADMIN_CIDRS6:-}"
WEB_MODE="${WEB_MODE:-public}"
WEB_CIDRS4="${WEB_CIDRS4:-}"
WEB_CIDRS6="${WEB_CIDRS6:-}"
# --- optional, ONLY if Swarm clustering becomes required (leave empty for standalone) -------------
PEER_CIDRS4="${PEER_CIDRS4:-}"      # e.g. "10.22.10.0/25"   (second node on the private ens192 net)
PEER_CIDRS6="${PEER_CIDRS6:-}"
REVERT_AFTER="${REVERT_AFTER:-5min}"

TABLE="host04_guard"
STATE=/var/lib/host04-guard
CONF=/etc/host04-guard/host04-guard.conf
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

die() { echo "ERROR: $*" >&2; exit 1; }
join() { local IFS=,; echo "$*"; }

set_decl() {  # name type cidrs...
  local name="$1" type="$2"; shift 2
  if [ "$#" -gt 0 ]; then
    echo "  set $name { type $type; flags interval; elements = { $(join "$@") } }"
  else
    echo "  set $name { type $type; flags interval; }"
  fi
}

ruleset() {
  case "$WEB_MODE" in public|restricted) ;; *) die "WEB_MODE must be public|restricted";; esac
  # shellcheck disable=SC2086
  {
  echo "add table inet $TABLE"
  echo "delete table inet $TABLE"
  echo "table inet $TABLE {"
  set_decl admin4 ipv4_addr $ADMIN_CIDRS4
  set_decl admin6 ipv6_addr $ADMIN_CIDRS6
  set_decl web4   ipv4_addr $WEB_CIDRS4
  set_decl web6   ipv6_addr $WEB_CIDRS6
  set_decl peer4  ipv4_addr $PEER_CIDRS4
  set_decl peer6  ipv6_addr $PEER_CIDRS6
  cat <<EOF

  # ---- INPUT: ssh, userland-proxy path (IPv6 + local), swarm control/overlay ------------------
  chain input {
    type filter hook input priority -10; policy accept;
    iifname != "$PUB_IF" accept comment "lo, tailscale0, docker*, ens192: never filtered"

    tcp dport 22 ct state established,related accept comment "existing ssh sessions survive"
    tcp dport 22 ip  saddr @admin4 accept comment "ssh: admin v4"
    tcp dport 22 ip6 saddr @admin6 accept comment "ssh: admin v6"
    tcp dport 22 counter drop comment "ssh: admin only (public)"

    tcp dport 3000 ip  saddr @admin4 accept comment "console: admin v4"
    tcp dport 3000 ip6 saddr @admin6 accept comment "console: admin v6"
    tcp dport 3000 counter drop comment "console 3000: admin only (docker-proxy path, v6 only path)"

    tcp dport { 2377, 7946 } ip  saddr @peer4 accept comment "swarm peers v4 (empty = standalone)"
    tcp dport { 2377, 7946 } ip6 saddr @peer6 accept comment "swarm peers v6 (empty = standalone)"
    udp dport { 7946, 4789 } ip  saddr @peer4 accept comment "swarm peers v4"
    udp dport { 7946, 4789 } ip6 saddr @peer6 accept comment "swarm peers v6"
    tcp dport { 2377, 7946 } counter drop comment "swarm control/gossip: no public access"
    udp dport { 7946, 4789 } counter drop comment "swarm gossip/vxlan: no public access"
EOF
  if [ "$WEB_MODE" = restricted ]; then
    cat <<EOF

    tcp dport { 80, 443 } ip  saddr @web4 accept comment "web: allowed v4 sources"
    tcp dport { 80, 443 } ip6 saddr @web6 accept comment "web: allowed v6 sources"
    tcp dport { 80, 443 } counter drop comment "web restricted (WEB_MODE=restricted)"
EOF
  fi
  cat <<EOF
  }

  # ---- FORWARD: published ports are DNAT'ed, so INPUT never sees them (Docker docs) -----------
  # Match the ORIGINAL destination port via conntrack, because after DNAT only the container
  # address/port is visible. 'ct status dnat' limits it to NAT'ed flows.
  chain forward {
    type filter hook forward priority -10; policy accept;
    iifname != "$PUB_IF" accept comment "container->world, overlay, tailscale forwarding untouched"

    ct status dnat meta l4proto tcp ct original proto-dst 3000 ip  saddr @admin4 accept comment "console: admin v4"
    ct status dnat meta l4proto tcp ct original proto-dst 3000 ip6 saddr @admin6 accept comment "console: admin v6"
    ct status dnat meta l4proto tcp ct original proto-dst 3000 counter drop comment "console 3000 via DNAT: admin only"
EOF
  if [ "$WEB_MODE" = restricted ]; then
    cat <<EOF

    ct status dnat meta l4proto tcp ct original proto-dst { 80, 443 } ip  saddr @web4 accept comment "web: allowed v4"
    ct status dnat meta l4proto tcp ct original proto-dst { 80, 443 } ip6 saddr @web6 accept comment "web: allowed v6"
    ct status dnat meta l4proto tcp ct original proto-dst { 80, 443 } counter drop comment "web restricted via DNAT"
EOF
  fi
  echo "  }"
  echo "}"
  }
}

norm_ipt() { { iptables-save; echo "## ip6"; ip6tables-save; } 2>/dev/null | grep -v '^#' | sed -E 's/\[[0-9]+:[0-9]+\]//'; }
snapshot() { # dir
  mkdir -p "$1"; chmod 700 "$STATE" "$1"
  nft list ruleset > "$1/nft-ruleset.txt" 2>/dev/null || true
  norm_ipt > "$1/iptables-normalised.txt" || true
}

need_root() { [ "$(id -u)" -eq 0 ] || die "run as root (sudo)"; }

lockout_check() {
  [ -n "${SSH_CONNECTION:-}" ] || { echo "note: no SSH_CONNECTION (console/tty session): lock-out check skipped"; return 0; }
  local src; src="$(echo "$SSH_CONNECTION" | awk '{print $1}')"
  python3 - "$src" "$ADMIN_CIDRS4" "$ADMIN_CIDRS6" <<'PY' || die "your ssh source ($src) is NOT in ADMIN_CIDRS and not on a non-public path: refusing (set ADMIN_CIDRS4/6 to include it)"
import ipaddress,sys
src=ipaddress.ip_address(sys.argv[1])
nets=[ipaddress.ip_network(x,strict=False) for x in (sys.argv[2]+" "+sys.argv[3]).split()]
sys.exit(0 if any(src in n for n in nets if n.version==src.version) or src.is_private or src in ipaddress.ip_network("100.64.0.0/10") else 1)
PY
  echo "lock-out check ok: ssh source $src is admin / private / tailscale"
}

cmd_plan() {
  command -v nft >/dev/null || die "nft missing"
  echo "=== proposed ruleset (table inet $TABLE) ==="
  ruleset
  echo
  if [ "$(id -u)" -eq 0 ]; then
    ruleset | nft -c -f - && echo "nft -c (dry run): syntax OK, nothing applied"
  else
    echo "(not root: dry-run syntax check skipped; run with sudo to include it)"
  fi
  echo "ADMIN_CIDRS4='$ADMIN_CIDRS4' ADMIN_CIDRS6='$ADMIN_CIDRS6' WEB_MODE=$WEB_MODE PEER4='$PEER_CIDRS4' PUB_IF=$PUB_IF"
}

cmd_apply() {
  need_root; lockout_check
  [ -f "$SELF_DIR/10-host04-firewall-revert.sh" ] || die "10-host04-firewall-revert.sh must sit next to this script"
  bash -n "$SELF_DIR/10-host04-firewall-revert.sh" || die "revert script has a syntax error"
  ip link show "$PUB_IF" >/dev/null 2>&1 || die "interface $PUB_IF not found"
  ruleset | nft -c -f - || die "ruleset failed the dry run; nothing applied"
  local ts; ts="$(date -u +%Y%m%dT%H%M%SZ)"; local snap="$STATE/backup-$ts"
  mkdir -p "$STATE"; snapshot "$snap/before"
  install -m 0755 "$SELF_DIR/10-host04-firewall-revert.sh" /usr/local/sbin/host04-guard-revert.sh
  # ARM THE REVERT FIRST. If this fails we have changed nothing.
  systemctl stop host04-guard-autorevert.timer host04-guard-autorevert.service 2>/dev/null || true
  systemd-run --quiet --unit=host04-guard-autorevert --on-active="$REVERT_AFTER" \
      /usr/local/sbin/host04-guard-revert.sh --auto \
    || die "could not arm auto-revert; nothing applied"
  systemctl is-active --quiet host04-guard-autorevert.timer || die "auto-revert timer not active; reverting nothing was applied"
  echo "auto-revert ARMED: rules vanish in $REVERT_AFTER unless you run: $0 confirm"
  systemctl list-timers host04-guard-autorevert.timer --no-pager | sed -n 1,3p
  ruleset | nft -f -
  snapshot "$snap/after"
  echo; echo "=== diff: nft ruleset (before -> after) ==="
  diff -u "$snap/before/nft-ruleset.txt" "$snap/after/nft-ruleset.txt" || true
  echo; echo "=== diff: iptables/ip6tables-save, counters stripped (expect NO change: Docker/tailscale untouched) ==="
  diff -u "$snap/before/iptables-normalised.txt" "$snap/after/iptables-normalised.txt" && echo "(identical)"
  cat <<EOF

APPLIED (not yet persistent). Snapshot: $snap
NOW, from a SECOND window / device, within $REVERT_AFTER:
  1. ssh epicadmin@66.118.37.29                      (from an ADMIN_CIDR) must still work
  2. console: tailscale  -> http://100.116.115.19:3000   OR   ssh -N -L 3000:127.0.0.1:3000 epicadmin@66.118.37.29
  3. from the Lane A workstation: pwsh ./20-host04-verify-external.ps1 -Phase After
If everything is right:   $0 confirm
If anything is wrong, do nothing: the rules remove themselves at the timer, or run  $0 revert
EOF
}

cmd_confirm() {
  need_root
  nft list table inet "$TABLE" >/dev/null 2>&1 || die "guard table is not loaded; run apply first"
  install -d -m 0755 /etc/host04-guard
  { echo "# written by 10-host04-firewall-owner-run.sh confirm $(date -u +%FT%TZ)"
    for v in PUB_IF ADMIN_CIDRS4 ADMIN_CIDRS6 WEB_MODE WEB_CIDRS4 WEB_CIDRS6 PEER_CIDRS4 PEER_CIDRS6; do printf '%s=%q\n' "$v" "${!v}"; done
  } > "$CONF"; chmod 0644 "$CONF"
  install -m 0755 "${BASH_SOURCE[0]}" /usr/local/sbin/host04-guard.sh
  mkdir -p "$STATE"; norm_table > "$STATE/expected.sha"
  cat > /etc/systemd/system/host04-guard.service <<'EOF'
[Unit]
Description=host04 guard: nftables table inet host04_guard (ssh/console/swarm/web exposure)
Documentation=ops/personal-line/migration/host04/10-host04-firewall-owner-run.sh
DefaultDependencies=no
After=local-fs.target
Before=network-pre.target
Wants=network-pre.target
[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/sbin/host04-guard.sh ensure
[Install]
WantedBy=multi-user.target
EOF
  cat > /etc/systemd/system/host04-guard.timer <<'EOF'
[Unit]
Description=host04 guard: re-assert on drift
[Timer]
OnBootSec=45s
OnUnitActiveSec=3min
Unit=host04-guard.service
[Install]
WantedBy=timers.target
EOF
  systemctl daemon-reload
  systemctl enable host04-guard.service host04-guard.timer
  systemctl start host04-guard.timer
  # only now cancel the safety net
  systemctl stop host04-guard-autorevert.timer host04-guard-autorevert.service 2>/dev/null || true
  echo "CONFIRMED: persistent (boot + 3-min drift check). auto-revert cancelled."
  systemctl is-enabled host04-guard.service host04-guard.timer
}

norm_table() { nft list table inet "$TABLE" 2>/dev/null | sed -E 's/packets [0-9]+ bytes [0-9]+/packets 0 bytes 0/' | sha256sum | cut -c1-16; }

cmd_ensure() { # persistent path: params from CONF, idempotent, acts ONLY on drift
  need_root; [ -f "$CONF" ] && . "$CONF"
  ruleset | nft -c -f - >/dev/null 2>&1 || { echo "host04-guard: ruleset from $CONF fails dry run; leaving system as is" >&2; exit 1; }
  local want have; want="$(cat "$STATE/expected.sha" 2>/dev/null || true)"; have="$(norm_table)"
  if [ -n "$want" ] && [ "$have" = "$want" ]; then echo "host04-guard: in place, no drift ($have)"; return 0; fi
  ruleset | nft -f -
  norm_table > "$STATE/expected.sha"
  echo "host04-guard: (re)applied; drift '${have}' vs expected '${want:-none}' -> $(cat "$STATE/expected.sha")"
}

cmd_status() {
  nft list table inet "$TABLE" 2>&1 | sed -n 1,80p
  systemctl list-timers 'host04-guard*' --no-pager 2>/dev/null | sed -n 1,6p || true
}

case "${1:-}" in
  print-ruleset) ruleset ;;
  plan)    cmd_plan ;;
  apply)   cmd_apply ;;
  confirm) cmd_confirm ;;
  ensure)  cmd_ensure ;;
  status)  cmd_status ;;
  revert)  need_root; exec "$SELF_DIR/10-host04-firewall-revert.sh" ;;
  *) sed -n '1,12p;20,45p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' ; echo "usage: $0 plan|apply|confirm|status|revert"; exit 2 ;;
esac
