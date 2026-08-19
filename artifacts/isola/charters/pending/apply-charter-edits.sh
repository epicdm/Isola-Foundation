#!/usr/bin/env bash
# Apply charter edits 3-5 to the two live Paperclip agents.
#
# RUN FROM THE REPO ROOT:
#   bash artifacts/isola/charters/pending/apply-charter-edits.sh /c/epic-workspace/paperclipboard.txt
#
# It is SAFE TO RUN REPEATEDLY. Nothing is written unless every check passes:
#   1. the token authenticates
#   2. the LIVE bundle still byte-matches the verified snapshot (no silent clobber)
#   3. only then does it PUT, and it re-reads afterwards to prove what landed
#
# If the token is wrong you see a 401 immediately and nothing is touched.
set -uo pipefail

KEYFILE="${1:-/c/epic-workspace/paperclipboard.txt}"
BASE="https://isola-ai.saas00.epic.dm/api"
DIR="artifacts/isola/charters"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

[ -f "$KEYFILE" ] || { echo "key file not found: $KEYFILE"; exit 1; }
K=$(tr -d ' \t\r\n' < "$KEYFILE")
[ -n "$K" ] || { echo "key file is empty"; exit 1; }
echo "token: $(printf '%s' "$K" | cut -c1-11)... (${#K} chars)"

echo
echo "--- 1. authentication ---"
CODE=$(curl -s -o "$TMP/auth" -w "%{http_code}" --max-time 30 -H "Authorization: Bearer $K" "$BASE/companies")
echo "    GET /api/companies -> $CODE"
if [ "$CODE" != "200" ]; then
  echo "    body: $(head -c 200 "$TMP/auth")"
  echo
  echo "STOPPED. The token is not accepted. Nothing was written."
  echo "Mint a board key against https://isola-ai.saas00.epic.dm and put its value in $KEYFILE"
  exit 1
fi

# agent id : snapshot file : prepared file : short name
AGENTS=(
  "fd2867d1-ee43-4032-a1cc-52eb3379a581|$DIR/SNAPSHOT-2026-08-19-fd2867d1-6737-front-desk-AGENTS.md|$DIR/pending/NEW-fd2867d1-AGENTS.md|fd2867d1 (6737 customer)"
  "a60770e9-e0e1-431a-aef5-f2158b963f61|$DIR/SNAPSHOT-2026-08-19-a60770e9-9043-internal-manager-AGENTS.md|$DIR/pending/NEW-a60770e9-AGENTS.md|a60770e9 (9043 internal)"
)

echo
echo "--- 2. pre-write check: does the LIVE bundle still match the snapshot? ---"
SAFE=1
for row in "${AGENTS[@]}"; do
  IFS='|' read -r ID SNAP NEW NAME <<< "$row"
  curl -s -o "$TMP/live.json" --max-time 30 -H "Authorization: Bearer $K" \
    "$BASE/agents/$ID/instructions-bundle/file?path=AGENTS.md"
  python - "$TMP/live.json" "$SNAP" "$NAME" <<'PY' || SAFE=0
import json,io,sys,hashlib
live,snap,name=sys.argv[1],sys.argv[2],sys.argv[3]
try:
    c=json.load(io.open(live,encoding='utf-8')).get('content','')
except Exception as e:
    print(f"    {name}: could not read live bundle ({e})"); raise SystemExit(1)
lb=c.encode('utf-8'); sb=io.open(snap,'rb').read()
lh=hashlib.sha256(lb).hexdigest(); sh=hashlib.sha256(sb).hexdigest()
if lh==sh:
    print(f"    {name}: live matches snapshot ({len(lb)} bytes) - safe")
else:
    print(f"    {name}: MISMATCH - live {lh[:16]} vs snapshot {sh[:16]}")
    print("      the charter changed since the snapshot. STOP and re-snapshot.")
    raise SystemExit(1)
PY
done
[ "$SAFE" = "1" ] || { echo; echo "STOPPED. Nothing was written."; exit 1; }

echo
echo "--- 3. writing ---"
for row in "${AGENTS[@]}"; do
  IFS='|' read -r ID SNAP NEW NAME <<< "$row"
  python - "$NEW" "$TMP/body.json" <<'PY'
import json,io,sys
content=io.open(sys.argv[1],encoding='utf-8',newline='').read()
io.open(sys.argv[2],'w',encoding='utf-8').write(json.dumps({"path":"AGENTS.md","content":content}))
PY
  CODE=$(curl -s -o "$TMP/put.json" -w "%{http_code}" --max-time 60 -X PUT \
    -H "Authorization: Bearer $K" -H "Content-Type: application/json" \
    --data-binary @"$TMP/body.json" \
    "$BASE/agents/$ID/instructions-bundle/file")
  echo "    $NAME  PUT -> $CODE"
  [ "$CODE" = "200" ] || echo "      body: $(head -c 250 "$TMP/put.json")"
done

echo
echo "--- 4. verification: re-reading what actually landed ---"
for row in "${AGENTS[@]}"; do
  IFS='|' read -r ID SNAP NEW NAME <<< "$row"
  curl -s -o "$TMP/after.json" --max-time 30 -H "Authorization: Bearer $K" \
    "$BASE/agents/$ID/instructions-bundle/file?path=AGENTS.md"
  python - "$TMP/after.json" "$NEW" "$NAME" <<'PY'
import json,io,sys,hashlib
after,new,name=sys.argv[1],sys.argv[2],sys.argv[3]
try:
    c=json.load(io.open(after,encoding='utf-8')).get('content','')
except Exception as e:
    print(f"    {name}: could not re-read ({e})"); raise SystemExit
ab=c.encode('utf-8'); nb=io.open(new,'rb').read()
ok = hashlib.sha256(ab).hexdigest()==hashlib.sha256(nb).hexdigest()
print(f"    {name}: {'APPLIED - live now byte-matches the intended file' if ok else 'DID NOT APPLY - live does not match'} ({len(ab)} bytes)")
PY
done

echo
echo "Done. Charter changes take effect on the next message - the runtime re-reads every 60s."
echo "Rollback if needed: re-run with the SNAPSHOT files in place of the NEW files."
