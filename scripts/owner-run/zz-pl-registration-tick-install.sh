#!/bin/bash
# Install the one-minute registration-watch tick on host04 (restores the scheduler lost when the watch moved off the old estate: last tick was 2026-10-11T21:45Z).
# It calls the EXISTING route GET /api/cron/registration-watch inside the plsvc container; the CRON_SECRET is read in-process from /app/.env.cur and sent in the
# x-cron-secret header (never on the host, never in a unit file, never in a URL). Same shape as pl-watch (oneshot + timer, flock, logfile).
# Reversal: systemctl disable --now pl-registration-tick.timer; rm /etc/systemd/system/pl-registration-tick.{service,timer}; rm -r /usr/local/lib/pl-registration-tick /var/lib/pl-registration-tick; systemctl daemon-reload
set -e
install -d -m 0700 /usr/local/lib/pl-registration-tick /var/lib/pl-registration-tick
cat > /usr/local/lib/pl-registration-tick/tick.sh <<'EOS'
#!/bin/bash
P=$(docker ps -q -f name=uplink_plsvc-app -f status=running | head -1)
[ -n "$P" ] || { echo "$(date -u +%FT%TZ) plsvc not running; skipped"; exit 0; }
docker exec -i -w /app "$P" node - <<'EOJ'
const fs = require('fs');
const secret = fs.readFileSync('/app/.cronsecret', 'utf8').trim();   // the SAME file the launcher exports as CRON_SECRET (launch.sh); .env.cur carries a stale placeholder
fetch('http://127.0.0.1:3005/api/cron/registration-watch', { headers: { 'x-cron-secret': secret }, signal: AbortSignal.timeout(50000) })
  .then((r) => r.text().then((t) => { console.log(new Date().toISOString(), 'HTTP', r.status, t.slice(0, 200)); process.exit(r.ok ? 0 : 1); }))
  .catch((e) => { console.log(new Date().toISOString(), 'ERR', e.message); process.exit(1); });
EOJ
EOS
chmod 0700 /usr/local/lib/pl-registration-tick/tick.sh
cat > /etc/systemd/system/pl-registration-tick.service <<'EOS'
[Unit]
Description=PL registration watch tick (calls the existing /api/cron/registration-watch; reversal: systemctl disable --now pl-registration-tick.timer; rm unit files)
[Service]
Type=oneshot
ExecStart=/usr/bin/flock -n /var/lib/pl-registration-tick/lock /usr/local/lib/pl-registration-tick/tick.sh
StandardOutput=append:/var/log/pl-registration-tick.log
StandardError=append:/var/log/pl-registration-tick.log
Nice=10
EOS
cat > /etc/systemd/system/pl-registration-tick.timer <<'EOS'
[Unit]
Description=PL registration watch tick every minute
[Timer]
OnBootSec=2min
OnUnitActiveSec=1min
AccuracySec=10s
[Install]
WantedBy=timers.target
EOS
systemctl daemon-reload
systemctl enable --now pl-registration-tick.timer
systemctl list-timers --no-pager | grep -E 'pl-registration-tick|NEXT' | cut -c1-150
