#!/bin/bash
# OWNER-AUTHORIZED REAL RESET of 9610 (17672859610) via the supported fixture-reset route. Owner words (relayed by the coordinator 2026-10-14): "17672652970 is no longer available.. we will use me.. 9610 reset it, and get it ready for me to test".
# Sequence: fresh dry-run (stores the preview receipt) immediately followed by the real call with that receipt. Backup is in /var/backups/pl-9610-reset-20261014/. Run as root on host04; needs /tmp/zz-fx-reset.js staged.
P=$(docker ps -q -f name=uplink_plsvc-app -f status=running | head -1)
sed 's/slice(0, 170)/slice(0, 1100)/' /tmp/zz-fx-reset.js > /tmp/zz-fx-reset-wide.js
echo "[$(date -u +%T)] fresh dry run"; docker exec -i -w /app -e MODE=dry -e TARGET=17672859610 -e ALLOW_OTHER=17672859610 $P node - < /tmp/zz-fx-reset-wide.js 2>&1 | grep -E "^DRY|previewReceipt" | cut -c1-160
echo "[$(date -u +%T)] REAL reset"; docker exec -i -w /app -e MODE=real -e TARGET=17672859610 -e ALLOW_OTHER=17672859610 -e REASON="owner instruction 2026-10-14: reset his own line 9610 and prepare it for a new-customer test; backup /var/backups/pl-9610-reset-20261014" $P node - < /tmp/zz-fx-reset-wide.js 2>&1 | fold -w 200
