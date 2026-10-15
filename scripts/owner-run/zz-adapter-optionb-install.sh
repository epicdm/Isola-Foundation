#!/bin/bash
# zz-adapter-optionb-install: Option B / item K on the bind-mounted adapter file (owner decision dec-owner-pl-signup-option-b-chat-buttons-2026-10-14).
# Run on host04 as root AFTER the candidate is at /tmp/pl-action-adapter-optionb.mjs. Then redeploy with zz-migrate-22-adapter-redeploy.py (supported path).
#   bash zz-adapter-optionb-install.sh            -> backup the running file (must be 796f0286), install the candidate (must be $CAND_SHA)
#   bash zz-adapter-optionb-install.sh rollback   -> restore the backup byte-for-byte
set -eu
F=/home/epicadmin/pladapter/pl-action-adapter.mjs; B=/var/backups/pladapter-optionb-20261014
RUNNING=796f02868906534209d08b479ed90ee66d1ebcdab86a6abd5e9d6dae6e93721a
CAND_SHA=${CAND_SHA:?set CAND_SHA to the candidate sha256}
if [ "${1:-}" = "rollback" ]; then
  [ "$(sha256sum $B/pl-action-adapter.mjs.pre | cut -d' ' -f1)" = "$RUNNING" ] || { echo "backup is not the pre-change file"; exit 2; }
  cp -p $B/pl-action-adapter.mjs.pre $F; echo "restored: $(sha256sum $F | cut -c1-16)"; exit 0
fi
mkdir -p $B
[ -e $B/pl-action-adapter.mjs.pre ] || cp -p $F $B/pl-action-adapter.mjs.pre
[ "$(sha256sum $B/pl-action-adapter.mjs.pre | cut -d' ' -f1)" = "$RUNNING" ] || { echo "running file is not the expected 796f0286; refusing"; exit 3; }
[ "$(sha256sum /tmp/pl-action-adapter-optionb.mjs | cut -d' ' -f1)" = "$CAND_SHA" ] || { echo "candidate hash mismatch; refusing"; exit 4; }
if command -v node >/dev/null; then node --check /tmp/pl-action-adapter-optionb.mjs; else echo "(node not on host; syntax checked on the runner)"; fi
cat /tmp/pl-action-adapter-optionb.mjs > $F   # same inode: the container bind-mounts this single file
echo "installed: $(sha256sum $F | cut -c1-16) (expect ${CAND_SHA:0:16})"
