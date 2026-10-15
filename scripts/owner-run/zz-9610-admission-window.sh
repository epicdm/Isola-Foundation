#!/bin/bash
# OWNER-AUTHORIZED (coordinator relay 2026-10-14) TEMPORARY tester-only admission for the owner's 9610 new-customer test.
#   usage: zz-9610-admission-window.sh dry     -> builds the candidate file, prints the key diff + sha, writes NOTHING live
#          APPLY=1 zz-9610-admission-window.sh apply  -> writes the candidate IN PLACE (cat >, same inode; the plsvc bind-mounts the single file)
#          zz-9610-admission-window.sh revert  -> writes the pre-change bytes back IN PLACE (sha must read 575bc9fb...4cfe)
# Candidate = current file with LITE_ADMISSION_PAUSED=false, LITE_ADMISSION_OPEN_COUNTRY_PREFIXES=[], LITE_ADMISSION_COUNTRY_ALLOWLIST=["17672859610"]. Nothing else changes.
F=/home/epicadmin/plprod/runtime-flags.json; B=/var/backups/pl-9610-reset-20261014; BEFORE=575bc9fb620703600d4e3ee61a6a7b491c66870a2e3246a5ce59fea7c3df4cfe
P=$(docker ps -q -f name=uplink_plsvc-app -f status=running | head -1); MODE=${1:-dry}
sha() { sha256sum "$1" | cut -c1-64; }
view() { docker exec -i $P sh -c 'sha256sum /app/data/runtime-flags.json | cut -c1-64' </dev/null; }
if [ "$MODE" = "revert" ]; then
  [ "$(sha $B/runtime-flags.json.before)" = "$BEFORE" ] || { echo "ABORT: backup is not the expected pre-change bytes"; exit 9; }
  I0=$(stat -c %i $F); cat $B/runtime-flags.json.before > $F; sleep 12
  echo "REVERTED: sha $(sha $F | cut -c1-8)...$(sha $F | cut -c61-64) inode $I0/$(stat -c %i $F) | container view $(view | cut -c1-8)...$(view | cut -c61-64)"; exit 0
fi
[ "$(sha $F)" = "$BEFORE" ] || { echo "ABORT: flags file is not at the expected pre-change sha (575bc9fb...4cfe); got $(sha $F | cut -c1-8)"; exit 9; }
python3 - <<'PY'
import json
F = "/home/epicadmin/plprod/runtime-flags.json"; d = json.load(open(F)); old = dict(d)
d["LITE_ADMISSION_PAUSED"] = False
d["LITE_ADMISSION_OPEN_COUNTRY_PREFIXES"] = []
d["LITE_ADMISSION_COUNTRY_ALLOWLIST"] = ["17672859610"]
open("/tmp/flags-9610only.json", "w").write(json.dumps(d, indent=2, ensure_ascii=False) + "\n")
print("KEY DIFF (old -> new):")
for k in sorted(set(d) | set(old)):
    if d.get(k) != old.get(k): print("  ", k, ":", json.dumps(old.get(k)), "->", json.dumps(d.get(k)))
print("keys unchanged:", sum(1 for k in d if d.get(k) == old.get(k)), "of", len(d))
PY
echo "candidate sha: $(sha /tmp/flags-9610only.json)"
if [ "$MODE" != "apply" ] || [ "${APPLY:-0}" != "1" ]; then echo "(dry: nothing written)"; exit 0; fi
echo "quiet-moment check, customer messages in the last 3 min: $(docker exec -i $(docker ps -q -f name=uplink_chatwoot-db | head -1) psql -U postgres -d isola -X -At -c "select count(*) from messages where message_type=0 and created_at > now() - interval '3 minutes'" </dev/null)"
I0=$(stat -c %i $F); cat /tmp/flags-9610only.json > $F
echo "[$(date -u +%T)] WRITTEN IN PLACE: sha $(sha $F) inode $I0/$(stat -c %i $F)"; sleep 12
echo "container view sha: $(view)"
python3 -c "import json;d=json.load(open('$F'));print('read-back paused=',d['LITE_ADMISSION_PAUSED'],'prefixes=',d['LITE_ADMISSION_OPEN_COUNTRY_PREFIXES'],'allowlist n=',len(d['LITE_ADMISSION_COUNTRY_ALLOWLIST']))"
