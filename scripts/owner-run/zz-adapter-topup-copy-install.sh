#!/bin/bash
# Install the top-up copy fix (TOPUP_IN_APP; no more false "top-ups aren't available") over the running adapter.
# Usage (root, host04): bash zz-adapter-topup-copy-install.sh <expected-running-sha16> <candidate-sha256-full>
#        bash zz-adapter-topup-copy-install.sh rollback
# Refuses unless the running file is exactly the expected one; backs it up first; verifies candidate hash before and installed hash after.
# Then redeploy with zz-migrate-22-adapter-redeploy.py (supported path: the file is a bind mount, same inode).
set -eu
F=/home/epicadmin/pladapter/pl-action-adapter.mjs; B=/var/backups/pladapter-topupcopy-20261015; C=/tmp/pl-action-adapter-topupcopy.mjs
if [ "${1:-}" = "rollback" ]; then
  [ -e "$B/pl-action-adapter.mjs.pre" ] || { echo "no backup"; exit 2; }
  cat "$B/pl-action-adapter.mjs.pre" > "$F"; echo "restored $(sha256sum $F | cut -c1-16)"; exit 0
fi
EXP=$1; NEW=$2
mkdir -p "$B"
[ "$(sha256sum $F | cut -c1-16)" = "$EXP" ] || { echo "running file is $(sha256sum $F | cut -c1-16), not $EXP; refusing"; exit 3; }
[ -e "$B/pl-action-adapter.mjs.pre" ] || cp -p "$F" "$B/pl-action-adapter.mjs.pre"
[ "$(sha256sum $C | cut -d' ' -f1)" = "$NEW" ] || { echo "candidate hash mismatch"; exit 4; }
cat "$C" > "$F"
echo "installed $(sha256sum $F | cut -c1-16) (expect ${NEW:0:16}); backup $(sha256sum $B/pl-action-adapter.mjs.pre | cut -c1-16)"
