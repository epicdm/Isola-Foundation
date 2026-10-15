#!/bin/bash
# Install the celebration adapter (composeProactive copy only) over the running d8a6f6bf. Usage: sudo bash zz-adapter-celebrate-install.sh <expected-running-sha16> <candidate-sha256-full>
# Refuses unless the running file is exactly the expected one; backs it up first; verifies the candidate hash before and the installed hash after.
set -e
EXP=$1; NEW=$2
F=/home/epicadmin/pladapter/pl-action-adapter.mjs; B=/var/backups/pladapter-celebrate-20261014; C=/tmp/pl-action-adapter-celebrate.mjs
mkdir -p "$B"
[ "$(sha256sum $F | cut -c1-16)" = "$EXP" ] || { echo "running file is not $EXP, refusing"; exit 3; }
[ -e "$B/pl-action-adapter.mjs.pre" ] || cp -p "$F" "$B/pl-action-adapter.mjs.pre"
[ "$(sha256sum $C | cut -d' ' -f1)" = "$NEW" ] || { echo "candidate hash mismatch"; exit 4; }
cat "$C" > "$F"
echo "installed $(sha256sum $F | cut -c1-16) ; backup $B/pl-action-adapter.mjs.pre ($(sha256sum $B/pl-action-adapter.mjs.pre | cut -c1-16))"
