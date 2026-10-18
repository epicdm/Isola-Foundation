#!/bin/bash
set -e
D=/home/epicadmin/zz-acct2-20261011
dk() { sudo -n docker "$@"; }
C=$(dk ps -q -f name=plstg_zzacct2_mock | head -1)
NAME=$(dk inspect $C --format '{{.Name}}')
case "$NAME" in /plstg_zzacct2_mock.*) echo "target ok: $NAME";; *) echo "ABORT: target $NAME"; exit 1;; esac
dk exec $C node /mock/zz-acct2-seed.mjs "$@"
