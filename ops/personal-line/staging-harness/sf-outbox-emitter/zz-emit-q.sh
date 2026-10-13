#!/bin/bash
# zz-emit-q.sh <plsvc|uplink> [rw]   -- SQL on stdin, run through the identity-asserting helper. Default is READ ONLY (wrapped in a read-only transaction).
D=/home/epicadmin/zz-emit-20261011
T=$(mktemp /tmp/zz-emit-q.XXXXXX.sql)
if [ "$2" = "rw" ]; then { echo "begin;"; cat; echo "commit;"; } > $T; else { echo "begin transaction read only;"; cat; echo "commit;"; } > $T; fi
bash $D/zz-emit-psql.sh "$1" $T
rm -f $T
