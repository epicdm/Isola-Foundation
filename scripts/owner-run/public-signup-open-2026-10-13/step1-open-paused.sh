#!/bin/bash
set -u
F=/home/epicadmin/plprod/runtime-flags.json
[ "$(sha256sum $F | cut -c1-64)" = "3c19ba08227c372b25f4e51d7ff4ddb318aa22e74e6c1269751690094e10e73a" ] || { echo "ABORT: flags not at the expected before-sha"; exit 9; }
install -o epicadmin -g epicadmin -m 0644 /tmp/flags-stage1.json $F.tmp && mv -f $F.tmp $F
echo "STEP1 written (open + PAUSED): $(sha256sum $F | cut -c1-64)"
sleep 12
P=$(docker ps -q -f name=uplink_plsvc-app -f status=running | head -1)
echo "--- synthetic verification (SYNTHETIC 1767 number 17675550912, paused; nothing may be allocated)"
docker exec -i -w /app -e MODE=o4 -e PHONE=17675550912 $P node - < /tmp/zz-fx-walk.js 2>&1 | tail -2 | cut -c1-300
bash /tmp/zz-fx-state.sh 17675550912 2>&1 | sed -n 1,8p | cut -c1-200
