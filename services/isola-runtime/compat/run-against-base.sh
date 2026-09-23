#!/usr/bin/env bash
# ROLLING-DEPLOY STATE (b): run the NEW gateway's request shape against the
# OLD runtime code, i.e. the runtime as it was before PR #151.
#
#   services/isola-runtime/compat/run-against-base.sh <base-sha> [workdir]
#
# It extracts services/isola-runtime at <base-sha> with `git archive` (reads
# only; no checkout, no worktree), installs its locked dependencies, copies
# old-runtime-new-gateway.test.ts into THAT tree's test/ folder, and runs it
# with the base tree's own harness. Nothing in the current tree is touched.
#
# This file and the test live outside test/ on purpose: they must not run in
# the normal suite (they target different code) and must not enter the image
# (.dockerignore excludes test/, and the Dockerfile copies src/ only).
#
# Recorded run, 2026-09-23, base 93cf73f: 3/3 passed; the base suite with the
# file added was 353/353. The check was also shown RED by patching the base
# runtime to fold the principal into the rendered context.
set -euo pipefail

base="${1:?usage: run-against-base.sh <base-sha> [workdir]}"
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(git -C "$here" rev-parse --show-toplevel)"
work="${2:-$(mktemp -d)}"

git -C "$repo" archive --format=tar "$base" services/isola-runtime | tar -xf - -C "$work"
cd "$work/services/isola-runtime"
npm ci --no-audit --no-fund --ignore-scripts >/dev/null
cp "$here/old-runtime-new-gateway.test.ts" test/compat-new-gateway.test.ts
npx vitest run test/compat-new-gateway.test.ts
