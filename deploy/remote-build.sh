#!/usr/bin/env bash
###############################################################################
# scripts/ops/c360-remote-build.sh -- runs ON host03. Builds the Customer 360
# UAT image from an exact commit in an ISOLATED build directory -- never
# inside a directory a live process serves. Paired with
# scripts/ops/c360-deploy.sh, which enforces the ancestry labels this script
# embeds before deploying the image this script builds.
#
# Usage: remote-build.sh <sha> <ancestry-ref> <YES|NO> -- ANCESTRY_REF and the
# verdict are computed by the release lane BEFORE calling this (via
# `gh api .../compare/<ref>...<sha>`, e.g. scripts/ops/ancestry-check.ps1),
# never assumed here -- see below.
#
# ANCESTRY LABELS, added 2026-09-05 (dec-c360-deploy-ancestry-guard-2026-09-05).
# host03 has no git credentials and no `gh` for this private repo, so this
# script CANNOT independently verify whether SHA is really merged into the
# serving branch -- it can only faithfully RECORD a claim computed elsewhere
# (by the release lane, on a machine with real GitHub access, via
# `gh api .../compare/<SHA>...<branch-tip>`, before this script is even
# invoked). That claim becomes two docker labels baked into the image:
#   isola.ancestry-ref       -- the ref the SHA was checked against
#   isola.ancestry-verified  -- exactly "YES" or "NO", never inferred
# deploy.sh reads these labels back and refuses to serve an image whose
# ancestry-verified label is missing or "NO" (see deploy.sh for the enforcement
# and its named override). This script does NOT refuse to build a "NO" image
# -- recording an honest "NO" is more valuable than refusing to build at all,
# and enforcement belongs at the one place that actually swaps live traffic.
# What this script DOES refuse is a caller who skips the check entirely: an
# absent or malformed verdict is not silently treated as "NO" (which could
# read as a checked-and-failed image when it was never checked), and it is
# not silently treated as "YES" (which would defeat the whole point) -- it is
# a hard refusal to build at all, because an unrecorded fact and a recorded
# false fact are different failure modes and must not be conflated.
###############################################################################
set -euo pipefail

SHA="${1:?commit sha required}"
ANCESTRY_REF="${2:?ancestry ref required (e.g. origin/recover/c360-served-f38f6ecd) -- computed by the caller BEFORE invoking this script, via gh api compare, never assumed here}"
ANCESTRY_VERDICT="${3:?ancestry verdict required: exactly YES or NO -- computed by the caller BEFORE invoking this script, never inferred here}"

case "$ANCESTRY_VERDICT" in
  YES|NO) ;;
  *) echo "REFUSING: ancestry verdict must be exactly YES or NO, got: '${ANCESTRY_VERDICT}'"; exit 1 ;;
esac

SHORT="${SHA:0:8}"
BUILD_DIR="/home/epicadmin/builds/isola360-${SHORT}"
IMAGE="isola-foundation-360:${SHORT}"
CHECKED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

echo "=== build dir: ${BUILD_DIR}"
echo "=== image    : ${IMAGE}"
echo "=== ancestry : CLAIMED BY CALLER, NOT INDEPENDENTLY VERIFIED HERE (host03 has no git credentials for this repo)"
echo "               ref=${ANCESTRY_REF} verdict=${ANCESTRY_VERDICT} checked_at=${CHECKED_AT}"
if [ "$ANCESTRY_VERDICT" = "NO" ]; then
  echo "  WARNING: building an image explicitly recorded as NOT verified-ancestor. This image WILL be refused by deploy.sh's ancestry guard unless an explicit named override is used at deploy time."
fi

# Refuse to build anywhere that looks like a live checkout.
case "$BUILD_DIR" in
  /opt/*|/home/epicdm/*|/etc/*) echo "REFUSING: build dir looks live"; exit 1 ;;
esac

echo
echo "=== source tree present? ==="
test -f "${BUILD_DIR}/package.json" || { echo "source not extracted"; exit 1; }
test -f "${BUILD_DIR}/deploy/Dockerfile" || { echo "Dockerfile missing"; exit 1; }
test -f "${BUILD_DIR}/deploy/entrypoint.sh" || { echo "entrypoint missing"; exit 1; }
echo "  ok: $(find "${BUILD_DIR}" -maxdepth 1 -type d | wc -l) top-level dirs"

echo
echo "=== CONTROL: the extracted tree is the RIGHT commit ==="
echo "  expecting the PR #109 Customer 360 files to be present:"
for f in artifacts/isola/lib/customer-360/odoo-projection.ts \
         artifacts/isola/lib/customer-360/contracts.ts \
         artifacts/isola/app/api/isola-360/context/route.ts \
         artifacts/isola/app/isola-360/page.tsx; do
  if [ -f "${BUILD_DIR}/${f}" ]; then echo "    PRESENT  ${f}"; else echo "    MISSING  ${f}"; fi
done
echo "  and a file that must NOT exist (control for a blind test):"
if [ -f "${BUILD_DIR}/artifacts/isola/lib/customer-360/__definitely_not_here.ts" ]; then
  echo "    UNEXPECTEDLY PRESENT -- the presence check is meaningless"
else
  echo "    correctly absent -- the presence check discriminates"
fi

echo
echo "=== building (this takes several minutes) ==="
cd "${BUILD_DIR}"
DOCKER_BUILDKIT=1 sudo docker build \
  -f deploy/Dockerfile \
  -t "${IMAGE}" \
  --label "isola.commit=${SHA}" \
  --label "isola.purpose=customer-360-uat" \
  --label "isola.ancestry-ref=${ANCESTRY_REF}" \
  --label "isola.ancestry-verified=${ANCESTRY_VERDICT}" \
  --label "isola.ancestry-checked-at=${CHECKED_AT}" \
  . 2>&1 | tail -40

echo
echo "=== image built ==="
sudo docker image inspect "${IMAGE}" \
  --format '  id                : {{.Id}}
  created           : {{.Created}}
  size              : {{.Size}}
  commit            : {{index .Config.Labels "isola.commit"}}
  ancestry-ref      : {{index .Config.Labels "isola.ancestry-ref"}}
  ancestry-verified : {{index .Config.Labels "isola.ancestry-verified"}}
  ancestry-checked  : {{index .Config.Labels "isola.ancestry-checked-at"}}'
