#!/bin/bash
# OWNER-AUTHORIZED SECOND REAL RESET of 9610 (17672859610), 2026-10-14 ~23:30Z. Owner words: "reset my account 9610 so i can walk it".
# Same supported fixture-reset route as zz-9610-reset-real.sh (fresh dry-run -> receipt -> real call). Run as root on host04; needs /tmp/zz-fx-reset.js staged.
# Before: the pre-reset preview (it carries the raw Magnus rows, 0600) and runtime flags go to a 0700 backup folder. After: read-back via a dry run (must show no live row).
set -u
B=/var/backups/pl-9610-reset2-20261014
umask 077; mkdir -p "$B"
P=$(docker ps -q -f name=uplink_plsvc-app -f status=running | head -1)
sed 's/slice(0, 170)/slice(0, 1100)/' /tmp/zz-fx-reset.js > /tmp/zz-fx-reset-wide.js
cp -p /home/epicadmin/plprod/runtime-flags.json "$B/runtime-flags.json.before"
echo "[$(date -u +%T)] backup preview -> $B/dry-before.txt (not printed)"
docker exec -i -w /app -e MODE=dry -e TARGET=17672859610 -e ALLOW_OTHER=17672859610 $P node - < /tmp/zz-fx-reset-wide.js > "$B/dry-before.txt" 2>&1
grep -c "" "$B/dry-before.txt"
echo "[$(date -u +%T)] fresh dry run + REAL reset"
docker exec -i -w /app -e MODE=real -e TARGET=17672859610 -e ALLOW_OTHER=17672859610 -e REASON="owner instruction 2026-10-14: reset his own line 9610 (trial, EC\$0) so he can walk a new-customer signup; backup $B" $P node - < /tmp/zz-fx-reset-wide.js 2>&1 | grep -E "^(DRY|REAL|HTTP|DONE)|ok:|error|retire|release|previewReceipt" | cut -c1-260
echo "[$(date -u +%T)] read-back (dry run, must show no live row for this phone)"
docker exec -i -w /app -e MODE=dry -e TARGET=17672859610 -e ALLOW_OTHER=17672859610 $P node - < /tmp/zz-fx-reset.js 2>&1 | cut -c1-260 | head -12
echo "backup sha: $(sha256sum $B/dry-before.txt | cut -c1-16) mode: $(stat -c %a $B $B/dry-before.txt | tr '\n' ' ')"
