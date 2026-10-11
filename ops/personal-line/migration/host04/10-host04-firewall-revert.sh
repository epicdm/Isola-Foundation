#!/usr/bin/env bash
# 10-host04-firewall-revert.sh -- OWNER-RUN / auto-run by the safety timer. Lane A has NOT run it.
# Removes ONLY what 10-host04-firewall-owner-run.sh added (exact-target deletes, no recursive removal):
#   * nftables table `inet host04_guard`  (Docker's and tailscale's iptables-nft tables are not touched)
#   * the persistent units host04-guard.service/.timer, /etc/host04-guard/host04-guard.conf,
#     /usr/local/sbin/host04-guard.sh, the auto-revert transient units
# Keeps /var/lib/host04-guard (snapshots) for evidence. Idempotent: safe to run any number of times.
# Installed by `apply` as /usr/local/sbin/host04-guard-revert.sh.
set -uo pipefail
[ "$(id -u)" -eq 0 ] || { echo "run as root" >&2; exit 1; }
MODE="${1:-manual}"
logger -t host04-guard "revert ($MODE)" 2>/dev/null || true

# stop the drift timer FIRST, otherwise it would re-create the table behind us
systemctl disable --now host04-guard.timer host04-guard.service >/dev/null 2>&1 || true
rm -f /etc/systemd/system/host04-guard.service /etc/systemd/system/host04-guard.timer
rm -f /etc/host04-guard/host04-guard.conf /usr/local/sbin/host04-guard.sh /var/lib/host04-guard/expected.sha
rmdir /etc/host04-guard 2>/dev/null || true
systemctl daemon-reload >/dev/null 2>&1 || true

if nft list table inet host04_guard >/dev/null 2>&1; then
  nft delete table inet host04_guard && echo "removed nft table inet host04_guard"
else
  echo "nft table inet host04_guard already absent"
fi

# the auto-revert timer is one-shot; clear it if this is a manual revert
if [ "$MODE" != "--auto" ]; then
  systemctl stop host04-guard-autorevert.timer host04-guard-autorevert.service >/dev/null 2>&1 || true
fi

echo "--- after revert ---"
nft list tables
echo "iptables DOCKER-USER (untouched by the guard):"; iptables -S DOCKER-USER 2>&1 | head -3
echo "listeners 22/3000/2377/7946: $(ss -tln | awk '$4 ~ /:(22|3000|2377|7946)$/ {print $4}' | sort -u | tr '\n' ' ')"
echo "NOTE: host04 is back to its pre-guard exposure (3000/2377/7946 public)."
