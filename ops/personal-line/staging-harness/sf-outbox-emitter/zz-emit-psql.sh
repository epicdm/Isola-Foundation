#!/bin/bash
# zz-emit-psql.sh <plsvc|uplink> <sqlfile>   -- runs a SQL file against the STAGING database through the db container's local socket.
# ASSERTS THE TARGET FIRST: service name, container, current_database() and current_user must equal the intended staging identity,
# and the Swarm service must carry the staging name; otherwise refuses (exit 3) before running anything. Prints identity, then results.
set -u
D="sudo -n docker"
case "${1:-}" in
  plsvc)  SVC=plstg_db;          WANT_DB=plstg;       WANT_USER=plstg ;;
  uplink) SVC=uplinkstg_uplink-db; WANT_DB=seldonframe; WANT_USER=seldon ;;
  *) echo "usage: $0 plsvc|uplink sqlfile"; exit 2 ;;
esac
F=${2:?sqlfile}
C=$($D ps -q -f name=^${SVC}\\. | head -1)
[ -n "$C" ] || { echo "REFUSED: no running container for $SVC"; exit 3; }
SN=$($D inspect $C --format '{{index .Config.Labels "com.docker.swarm.service.name"}}')
[ "$SN" = "$SVC" ] || { echo "REFUSED: container service is '$SN', wanted '$SVC'"; exit 3; }
ID=$($D exec $C psql -U $WANT_USER -d $WANT_DB -Atc "select current_database()||'|'||current_user" 2>&1)
[ "$ID" = "$WANT_DB|$WANT_USER" ] || { echo "REFUSED: identity '$ID' != '$WANT_DB|$WANT_USER'"; exit 3; }
echo "TARGET OK service=$SVC db=$WANT_DB user=$WANT_USER"
$D exec -i $C psql -U $WANT_USER -d $WANT_DB -v ON_ERROR_STOP=1 -P pager=off < "$F"
