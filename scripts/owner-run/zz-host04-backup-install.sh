#!/bin/bash
# Lane A, 2026-10-15 (owner: deepseek + host03 are retiring, everything on host04). host04 had NO backups; the only prior one was host03 -> deepseek (both retiring).
# Installs /usr/local/sbin/host04-backup.sh + systemd timer (02:30 UTC daily). Run as root on host04.  MODE=once runs it now;  MODE=enable installs+enables the timer.
#   1. logical dump (pg_dumpall / mysqldump) of EVERY running database container -> /var/backups/host04-dumps/<service>.sql.gz (atomic, size-checked)
#   2. restic -> Wasabi S3 (existing bucket, credentials moved value-blind to /etc/restic-host04.env + .pw), repo path <bucket>/host04, tags per run
#      paths: /etc/easypanel (panel state, service definitions, traefik, acme), /etc/pl-secrets, /etc/bff-secrets, /home/epicadmin/{plprod,pladapter}, unit files + our scripts, pl-watch, the dumps
#      EXCLUDED: live Postgres data dirs (inconsistent while running; the dumps cover them) and the docker registry.
#   3. retention: keep 7 daily, 4 weekly, 6 monthly (prune each run).   4. freshness stamp /var/lib/host04-backup/last-success (pl-watch alerts if > 26 h old).
# Reversal: systemctl disable --now host04-backup.timer; rm /etc/systemd/system/host04-backup.* /usr/local/sbin/host04-backup.sh
set -e
MODE=${MODE:-once}
install -d -m 0700 /var/lib/host04-backup /var/backups/host04-dumps
cat > /usr/local/sbin/host04-backup.sh <<'EOS'
#!/usr/bin/env bash
set -uo pipefail
set -a; . /etc/restic-host04.env; set +a
export RESTIC_REPOSITORY="s3:s3.${WASABI_REGION}.wasabisys.com/${BUCKET_NAME}/host04"
DUMPS=/var/backups/host04-dumps; LOG=/var/log/host04-backup.log; ST=/var/lib/host04-backup
START=$(date +%s); FAILS=()
exec >>"$LOG" 2>&1
echo "=== $(date -u +%FT%TZ) start ==="
umask 077; mkdir -p "$DUMPS"
for c in $(docker ps --format '{{.Names}}'); do
  name=${c%%.*}; out="$DUMPS/$name.sql.gz"; rc=1
  # a DATABASE container is one whose image exports PG_MAJOR (official postgres) or MYSQL_MAJOR/MARIADB_MAJOR; app containers that merely ship pg_dumpall (chatwoot, uplink-app) are NOT databases
  if docker exec "$c" printenv PG_MAJOR >/dev/null 2>&1; then
    # POSTGRES_USER is not always a superuser (measured: the PL production DB container has POSTGRES_USER=ocmt, super=false; pg_dumpall needs 'postgres') -> try the configured user, then postgres
    for u in "$(docker exec "$c" printenv POSTGRES_USER 2>/dev/null)" postgres; do
      [[ -n $u ]] || continue
      docker exec "$c" pg_dumpall -U "$u" 2>/dev/null | gzip >"$out.tmp"; rc=${PIPESTATUS[0]}
      [[ $rc -eq 0 && $(stat -c%s "$out.tmp") -gt 200 ]] && break
    done
  elif docker exec "$c" sh -c 'printenv MYSQL_MAJOR || printenv MARIADB_MAJOR' >/dev/null 2>&1; then
    docker exec "$c" sh -c 'D=$(command -v mysqldump || command -v mariadb-dump); $D -uroot --all-databases --single-transaction' 2>/dev/null | gzip >"$out.tmp"; rc=${PIPESTATUS[0]}
  else continue; fi
  if [[ $rc -eq 0 && $(stat -c%s "$out.tmp") -gt 200 ]]; then mv "$out.tmp" "$out"; echo "dump ok: $name ($(stat -c%s "$out") bytes)"
  else rm -f "$out.tmp"; FAILS+=("dump:$name"); echo "dump FAILED: $name"; fi
done
touch "$DUMPS/.stamp"
restic snapshots >/dev/null 2>&1 || { echo "repo not initialised: init"; restic init || FAILS+=("restic-init"); }
PATHS=(/etc/easypanel /etc/pl-secrets /etc/bff-secrets /home/epicadmin/plprod /home/epicadmin/pladapter /etc/systemd/system /usr/local/lib /usr/local/sbin /etc/pl-watch /var/lib/pl-watch "$DUMPS")
EXIST=(); for p in "${PATHS[@]}"; do [[ -e $p ]] && EXIST+=("$p"); done
restic backup "${EXIST[@]}" --tag host04 --host host04 --exclude-caches \
  --exclude '/etc/easypanel/projects/*/*/data/pgdata' --exclude '/etc/easypanel/projects/*/*/data/base' --exclude '/etc/easypanel/projects/*/*/data/pg_wal' \
  --exclude '/etc/easypanel/monitoring' --exclude '/etc/easypanel/logs'
rc=$?
# restic exit 3 = snapshot WAS saved but some files vanished/unreadable (measured: transient sqlite -wal/-shm of a live agent DB) -> warning, not failure
if [[ $rc -eq 3 ]]; then echo "warning: restic rc=3 (snapshot saved; some files vanished while reading)"; elif [[ $rc -ne 0 ]]; then FAILS+=("restic-backup:rc$rc"); fi
restic forget --keep-daily 7 --keep-weekly 4 --keep-monthly 6 --prune --tag host04 || FAILS+=("restic-forget")
SECS=$(( $(date +%s) - START ))
if [[ ${#FAILS[@]} -eq 0 ]]; then date -u +%FT%TZ > "$ST/last-success"; echo "=== $(date -u +%FT%TZ) OK in ${SECS}s ==="
else echo "${FAILS[*]}" > "$ST/last-failure"; echo "=== $(date -u +%FT%TZ) FAILED: ${FAILS[*]} ==="; exit 1; fi
EOS
chmod 0700 /usr/local/sbin/host04-backup.sh
if [ "$MODE" = "once" ]; then /usr/local/sbin/host04-backup.sh; echo "exit: $?"; tail -n 40 /var/log/host04-backup.log | cut -c1-200; exit 0; fi
cat > /etc/systemd/system/host04-backup.service <<'EOS'
[Unit]
Description=host04 nightly backup (DB dumps + restic to Wasabi; reversal: systemctl disable --now host04-backup.timer)
After=docker.service network-online.target
[Service]
Type=oneshot
ExecStart=/usr/bin/flock -n /var/lib/host04-backup/lock /usr/local/sbin/host04-backup.sh
Nice=10
IOSchedulingClass=idle
EOS
cat > /etc/systemd/system/host04-backup.timer <<'EOS'
[Unit]
Description=host04 nightly backup 02:30 UTC
[Timer]
OnCalendar=*-*-* 02:30:00 UTC
RandomizedDelaySec=10min
Persistent=true
[Install]
WantedBy=timers.target
EOS
systemctl daemon-reload; systemctl enable --now host04-backup.timer; systemctl list-timers --no-pager | grep -E 'host04-backup|NEXT' | cut -c1-150
