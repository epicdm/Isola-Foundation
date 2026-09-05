#!/bin/bash
# Companion to lumen-foundation-token-inject.ps1 -- runs ENTIRELY on host03.
#
# Invokes the already-registered /opt/lumen/inject-secrets.sh (the actual
# secret-handling logic lives there, not here -- this script only runs it and
# refuses to report success unless the injector's OWN proof step passed).
#
# Never prints a secret value: inject-secrets.sh is value-blind by design, and
# this wrapper only greps its stdout for the two literal marker lines it emits.
set -euo pipefail

OUT="$(sudo bash /opt/lumen/inject-secrets.sh 2>&1)"
echo "$OUT"

if echo "$OUT" | grep -q '^PROOF FAIL'; then
  echo "REFUSED: inject-secrets.sh's own proof step reported PROOF FAIL -- see the line above."
  exit 1
fi

if ! echo "$OUT" | grep -qE '^PROOF (PASS|SKIPPED)'; then
  echo "REFUSED: inject-secrets.sh produced no PROOF PASS/PROOF FAIL/PROOF SKIPPED line at all."
  echo "This means the script's own proof step did not run -- treat as a failure, not a silent pass."
  exit 1
fi

echo "OK: inject-secrets.sh ran and its proof step reported a definite result (see above)."
