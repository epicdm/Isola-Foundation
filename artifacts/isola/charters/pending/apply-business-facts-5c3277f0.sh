#!/usr/bin/env bash
# Put EPIC's BUSINESS.md draft into 5c3277f0's Paperclip instructions bundle so the
# owner can open Paperclip and review/edit it there. This is the paused draft target
# named in the 2026-09-17 AGENT-lane dispatch — isola-ai-sales-front-desk-agent@v1 —
# NOT fd2867d1 (see EPIC-BUSINESS-MD-DRAFT-2026-09-17.md's reconciliation note).
#
# RUN FROM THE REPO ROOT, with a currently-valid Paperclip BOARD token:
#   bash artifacts/isola/charters/pending/apply-business-facts-5c3277f0.sh /c/epic-workspace/paperclipboard.txt
#
# SAFE TO RUN REPEATEDLY. Nothing is written unless every check passes:
#   1. the token authenticates as board
#   2. the agent id 5c3277f0-927d-4a56-bf7b-ba5dc958c66b actually exists on this
#      Paperclip instance (does NOT assume it — prints the record for a human to
#      confirm template/company before anything is written)
#   3. the LIVE BUSINESS.md bundle is currently absent/empty (refuses to clobber an
#      unexpected existing value — re-run with a snapshot step added if it is not)
#   4. only then does it PUT, and it re-reads afterwards to prove what landed
#
# Measured 2026-09-17: the token checked into paperclipboard.txt at that time
# returned 403 "Board access required" against this same BASE. Mint or refresh a
# board token before running this — the script will say so and write nothing.
#
# This does NOT set PAPERCLIP_BUSINESS_FACTS_MAP or PAPERCLIP_AGENT_CALLER_SECRETS
# in production, and does NOT deploy PR139. Those are separate, required operator
# steps (see PR139's handover) — until both are set AND PR139 is deployed, this
# content sits in Paperclip for owner review only; no live reply uses it yet.
set -uo pipefail

KEYFILE="${1:-/c/epic-workspace/paperclipboard.txt}"
BASE="${PAPERCLIP_BASE:-https://isola-ai.saas00.epic.dm/api}"
AGENT="5c3277f0-927d-4a56-bf7b-ba5dc958c66b"
CONTENT_FILE="$(dirname "$0")/NEW-5c3277f0-BUSINESS.md"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

[ -f "$KEYFILE" ] || { echo "key file not found: $KEYFILE"; exit 1; }
[ -f "$CONTENT_FILE" ] || { echo "content file not found: $CONTENT_FILE"; exit 1; }
K=$(tr -d ' \t\r\n' < "$KEYFILE")
[ -n "$K" ] || { echo "key file is empty"; exit 1; }
echo "token: $(printf '%s' "$K" | cut -c1-11)... (${#K} chars)"
echo "base:  $BASE"
echo "agent: $AGENT"

echo
echo "--- 1. authentication (board) ---"
CODE=$(curl -s -o "$TMP/auth" -w "%{http_code}" --max-time 30 -H "Authorization: Bearer $K" "$BASE/companies")
echo "    GET /api/companies -> $CODE"
if [ "$CODE" != "200" ]; then
  echo "    body: $(head -c 300 "$TMP/auth")"
  echo
  echo "STOPPED. The token is not accepted as a board token. Nothing was written."
  echo "Mint/refresh a board key against $BASE and put its value in $KEYFILE."
  exit 1
fi

echo
echo "--- 2. does this agent id actually exist here? (confirm before writing) ---"
CODE=$(curl -s -o "$TMP/agent.json" -w "%{http_code}" --max-time 30 -H "Authorization: Bearer $K" "$BASE/agents/$AGENT")
echo "    GET /api/agents/$AGENT -> $CODE"
if [ "$CODE" != "200" ]; then
  echo "    body: $(head -c 300 "$TMP/agent.json")"
  echo
  echo "STOPPED. Agent record not found or not readable. Nothing was written."
  echo "Confirm this is still the correct Paperclip instance/agent id before retrying."
  exit 1
fi
echo "    record (verify template/company/status by eye before continuing):"
head -c 1500 "$TMP/agent.json"; echo

echo
echo "--- 3. pre-write check: is the LIVE BUSINESS.md bundle currently absent/empty? ---"
CODE=$(curl -s -o "$TMP/live.json" -w "%{http_code}" --max-time 30 -H "Authorization: Bearer $K" \
  "$BASE/agents/$AGENT/instructions-bundle/file?path=BUSINESS.md")
echo "    GET .../instructions-bundle/file?path=BUSINESS.md -> $CODE"
if [ "$CODE" = "200" ]; then
  LIVE_LEN=$(python -c "import json,io,sys; print(len(json.load(io.open(sys.argv[1],encoding='utf-8')).get('content','')))" "$TMP/live.json" 2>/dev/null || echo "?")
  if [ "$LIVE_LEN" != "0" ]; then
    echo "    MISMATCH — BUSINESS.md already has content ($LIVE_LEN chars)."
    echo "    STOPPED. Snapshot it first (do not clobber). Nothing was written."
    exit 1
  fi
fi
echo "    absent/empty — safe to write"

echo
echo "--- 4. writing ---"
python - "$CONTENT_FILE" "$TMP/body.json" <<'PY'
import json,io,sys
content=io.open(sys.argv[1],encoding='utf-8',newline='').read()
io.open(sys.argv[2],'w',encoding='utf-8').write(json.dumps({"path":"BUSINESS.md","content":content}))
PY
CODE=$(curl -s -o "$TMP/put.json" -w "%{http_code}" --max-time 60 -X PUT \
  -H "Authorization: Bearer $K" -H "Content-Type: application/json" \
  --data-binary @"$TMP/body.json" \
  "$BASE/agents/$AGENT/instructions-bundle/file")
echo "    PUT -> $CODE"
[ "$CODE" = "200" ] || { echo "    body: $(head -c 300 "$TMP/put.json")"; echo "STOPPED after failed write — verify manually."; exit 1; }

echo
echo "--- 5. verification: re-reading what actually landed ---"
CODE=$(curl -s -o "$TMP/after.json" --max-time 30 -H "Authorization: Bearer $K" \
  "$BASE/agents/$AGENT/instructions-bundle/file?path=BUSINESS.md")
python - "$TMP/after.json" "$CONTENT_FILE" <<'PY'
import json,io,sys,hashlib
after,new=sys.argv[1],sys.argv[2]
try:
    c=json.load(io.open(after,encoding='utf-8')).get('content','')
except Exception as e:
    print(f"    could not re-read ({e})"); raise SystemExit
ab=c.encode('utf-8'); nb=io.open(new,'rb').read()
ok = hashlib.sha256(ab).hexdigest()==hashlib.sha256(nb).hexdigest()
print(f"    {'APPLIED - live now byte-matches the intended file' if ok else 'DID NOT APPLY - live does not match'} ({len(ab)} bytes)")
PY

echo
echo "Done. This makes BUSINESS.md visible/editable in Paperclip for owner review."
echo "It does NOT make any live reply use it — that also needs PAPERCLIP_BUSINESS_FACTS_MAP"
echo "and PAPERCLIP_AGENT_CALLER_SECRETS set for $AGENT in production, and PR139 deployed."
echo "Rollback: PUT an empty content string back to the same path."
