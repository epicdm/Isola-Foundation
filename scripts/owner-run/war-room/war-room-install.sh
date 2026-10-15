#!/bin/bash
# Install war-room.timer (every minute) on host04. Reversal: systemctl disable --now war-room.timer && rm /etc/systemd/system/war-room.{service,timer} && systemctl daemon-reload
set -eu
cat > /etc/systemd/system/war-room.service <<'EOF'
[Unit]
Description=EPIC Personal Line war room: live launch alerts to the owner's Telegram (read-only on all watched systems)
After=docker.service
[Service]
Type=oneshot
ExecStart=/usr/bin/flock -n /var/lib/war-room/lock /usr/bin/python3 /usr/local/lib/war-room/war-room.py
TimeoutStartSec=90
EOF
cat > /etc/systemd/system/war-room.timer <<'EOF'
[Unit]
Description=Run the war room watcher every minute
[Timer]
OnBootSec=1min
OnUnitActiveSec=60s
AccuracySec=5s
[Install]
WantedBy=timers.target
EOF
systemctl daemon-reload
systemctl enable --now war-room.timer
sleep 3
systemctl start war-room.service || true
systemctl list-timers --no-pager | grep war-room | cut -c1-140
journalctl -u war-room.service -n 5 --no-pager -o cat | cut -c1-200
