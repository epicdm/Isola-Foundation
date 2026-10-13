#!/bin/bash
# zz-acct2: run SQL (stdin) against the Uplink STAGING db. usage: zz-acct2-h03-udb.sh ro|rw
# Asserts target (docker service name + database + the synthetic org's identity) BEFORE anything runs.
MODE=$1
ORG=c83151fb-e8e1-429b-b27a-eaeac6375e4a
dk() { sudo -n docker "$@"; }
C=$(dk ps -q -f name=uplinkstg_uplink-db | head -1)
NAME=$(dk inspect $C --format '{{.Name}}')
case "$NAME" in /uplinkstg_uplink-db.*) ;; *) echo "ABORT: target $NAME" >&2; exit 1;; esac
P() { dk exec -i $C psql -U seldon -d seldonframe -At -v ON_ERROR_STOP=1 "$@"; }
DBN=$(echo "select current_database()" | P)
[ "$DBN" = "seldonframe" ] || { echo "ABORT: db $DBN" >&2; exit 1; }
SLUG=$(echo "select slug from organizations where id='$ORG'" | P)
case "$SLUG" in "") echo "ABORT: synthetic org not in this db" >&2; exit 1;; esac
echo "target ok: $NAME db=$DBN org_slug=$SLUG mode=$MODE" >&2
if [ "$MODE" = ro ]; then
  { echo "begin transaction read only;"; cat; echo "commit;"; } | P
else
  { echo "begin;"; cat; echo "commit;"; } | P
fi
