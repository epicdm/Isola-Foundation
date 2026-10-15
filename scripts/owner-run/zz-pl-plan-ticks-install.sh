#!/bin/bash
# Lane A, owner instruction 2026-10-15 ("add the timers"): schedule the two Personal Line plan jobs on host04 against plsvc.
# They were disabled on deepseek 2026-10-10 (PL-WINDOW-DISABLED) and nothing scheduled them on host04 since; deepseek's DB holds no PL data anyway.
#   plan-lifecycle : every 15 min  (expires past-due 'active' lite_plan_subscriptions; blocks that account's outbound calling; also rides a registration-watch tick)
#   plan-metering  : at :07 :22 :37 :52 (polls Magnus CDRs for active subscriptions and decrements usCanSecondsUsed; never rates or credits)
# Auth: the SAME file the launcher exports as CRON_SECRET (/app/.cronsecret), sent in the x-cron-secret header, read in-process, never on the host/unit/URL.
# Run as root on host04.   MODE=once runs each tick once (flock-guarded) and prints the result;  MODE=enable installs+enables both timers.
# Reversal: systemctl disable --now pl-plan-lifecycle-tick.timer pl-plan-metering-tick.timer; rm /etc/systemd/system/pl-plan-*-tick.{service,timer}; rm -r /usr/local/lib/pl-plan-ticks /var/lib/pl-plan-ticks; systemctl daemon-reload
set -e
MODE=${MODE:-once}
install -d -m 0700 /usr/local/lib/pl-plan-ticks /var/lib/pl-plan-ticks
for JOB in plan-lifecycle plan-metering; do
cat > /usr/local/lib/pl-plan-ticks/$JOB.sh <<EOS
#!/bin/bash
P=\$(docker ps -q -f name=uplink_plsvc-app -f status=running | head -1)
[ -n "\$P" ] || { echo "\$(date -u +%FT%TZ) plsvc not running; skipped"; exit 0; }
docker exec -i -w /app "\$P" node - <<'EOJ'
const fs = require('fs');
const secret = fs.readFileSync('/app/.cronsecret', 'utf8').trim();
fetch('http://127.0.0.1:3005/api/cron/$JOB', { headers: { 'x-cron-secret': secret }, signal: AbortSignal.timeout(110000) })
  .then((r) => r.text().then((t) => { console.log(new Date().toISOString(), '$JOB HTTP', r.status, t.slice(0, 600)); process.exit(r.ok ? 0 : 1); }))
  .catch((e) => { console.log(new Date().toISOString(), '$JOB ERR', e.message); process.exit(1); });
EOJ
EOS
chmod 0700 /usr/local/lib/pl-plan-ticks/$JOB.sh
done
if [ "$MODE" = "once" ]; then
  for JOB in plan-lifecycle plan-metering; do echo "--- one manual run: $JOB"; /usr/bin/flock -n /var/lib/pl-plan-ticks/lock-$JOB /usr/local/lib/pl-plan-ticks/$JOB.sh || echo "(exit $?)"; done
  exit 0
fi
declare -A CAL=( [plan-lifecycle]="*:0/15" [plan-metering]="*:07,22,37,52" )
for JOB in plan-lifecycle plan-metering; do
cat > /etc/systemd/system/pl-$JOB-tick.service <<EOS
[Unit]
Description=PL $JOB tick (calls the existing /api/cron/$JOB on plsvc; reversal: systemctl disable --now pl-$JOB-tick.timer; rm unit files)
[Service]
Type=oneshot
ExecStart=/usr/bin/flock -n /var/lib/pl-plan-ticks/lock-$JOB /usr/local/lib/pl-plan-ticks/$JOB.sh
StandardOutput=append:/var/log/pl-plan-ticks.log
StandardError=append:/var/log/pl-plan-ticks.log
Nice=10
EOS
cat > /etc/systemd/system/pl-$JOB-tick.timer <<EOS
[Unit]
Description=PL $JOB tick
[Timer]
OnCalendar=${CAL[$JOB]}
AccuracySec=15s
Persistent=false
[Install]
WantedBy=timers.target
EOS
done
systemctl daemon-reload
systemctl enable --now pl-plan-lifecycle-tick.timer pl-plan-metering-tick.timer
systemctl list-timers --no-pager | grep -E 'pl-plan|NEXT' | cut -c1-150
