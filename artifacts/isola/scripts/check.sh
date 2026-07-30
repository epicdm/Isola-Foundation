#!/usr/bin/env bash
# One-call Foundation verification. Prints at most 6 short lines.
#
# WHY THIS EXISTS: every command from the agent crosses a bridge with a
# multi-second round trip, and the tool echoes the command back into the
# transcript. Compute here is cheap - tsc is ~3s incremental, vitest ~1s a file.
# The cost is CALLS and PAYLOAD, so this collapses typecheck + tests + repo
# state into one call with a tiny command and a tiny answer.
#
#   scripts/check.sh              full suite
#   scripts/check.sh lib/foo      one path
#   scripts/check.sh --publish-gate --expected-sha <FULL_SHA> [--require-ancestor <FULL_SHA>]...
#   scripts/check.sh --publish-gate --manifest release-manifest.json
set -uo pipefail
cd /home/runner/workspace/artifacts/isola || exit 1

# --publish-gate delegates to the release gate and does NOT fall through to the
# ordinary check output. The gate reruns tsc and vitest itself, because a test
# result only means something bound to the exact HEAD being published.
if [ "${1:-}" = "--publish-gate" ]; then
  shift
  exec npx tsx scripts/publish-gate.ts "$@"
fi
T0=$(date +%s)
./node_modules/.bin/tsc --noEmit -p tsconfig.json > /tmp/isola-tsc.log 2>&1
TSC=$?
npx vitest run ${1:-} > /tmp/isola-vitest.log 2>&1
VT=$?
T1=$(date +%s)
if [ $TSC -eq 0 ]; then echo "TSC clean"; else
  echo "TSC FAILED $(grep -c "error TS" /tmp/isola-tsc.log) errors:"
  grep "error TS" /tmp/isola-tsc.log | head -5
fi
grep -E "^ *Test Files|^ *Tests " /tmp/isola-vitest.log | sed "s/^ *//" | tr "\n" " "
echo ""
if [ $VT -ne 0 ]; then grep -E "FAIL|AssertionError" /tmp/isola-vitest.log | head -6; fi
cd /home/runner/workspace || exit 1
echo "HEAD $(git rev-parse --short HEAD) | dirty $(git status --porcelain | wc -l) | $((T1-T0))s"
