#!/usr/bin/env bash
###############################################################################
# Rebuild with the deployment-identity health route.
#
# PROVENANCE, STATED PLAINLY: this image is PR #109 head b59b8f0 PLUS one
# additive change to app/api/health/route.ts that echoes DEPLOY_SHA. It is
# therefore NOT byte-identical to the head, and is tagged `b59b8f0c-h1` rather
# than `b59b8f0c` so the two can never be confused. The dispatch requires the
# health endpoint to return the deployed SHA, which cannot be done without
# touching that route; recording the deviation is the honest way to comply.
###############################################################################
set -euo pipefail

SHA="b59b8f0cf82a09e0baa6962d93ffea33a4082f48"
SRC="/home/epicadmin/builds/isola360-b59b8f0c"
BUILD_DIR="/home/epicadmin/builds/isola360-b59b8f0c-h1"
IMAGE="isola-foundation-360:b59b8f0c-h1"

case "$BUILD_DIR" in /opt/*|/home/epicdm/*|/etc/*) echo "REFUSING: looks live"; exit 1 ;; esac

echo "=== preparing $BUILD_DIR from the already-extracted exact head ==="
rm -rf "$BUILD_DIR"
cp -a "$SRC" "$BUILD_DIR"

echo "=== applying the ONE additive change ==="
cp "$BUILD_DIR/deploy/health-route.ts" "$BUILD_DIR/artifacts/isola/app/api/health/route.ts"

echo
echo "=== the exact diff being introduced (auditable, not hidden) ==="
diff -u "$SRC/artifacts/isola/app/api/health/route.ts" \
        "$BUILD_DIR/artifacts/isola/app/api/health/route.ts" | sed 's/^/  /' || true

echo
echo "=== CONTROL: nothing ELSE differs from the exact head ==="
CHANGED=$( { diff -rq "$SRC" "$BUILD_DIR" 2>/dev/null || true; } | grep -v '/deploy/' | wc -l )
echo "  files differing outside deploy/: ${CHANGED} (must be exactly 1)"
{ diff -rq "$SRC" "$BUILD_DIR" 2>/dev/null || true; } | grep -v '/deploy/' | sed 's/^/    /' || true

echo
echo "=== building ${IMAGE} ==="
cd "$BUILD_DIR"
DOCKER_BUILDKIT=1 sudo docker build \
  -f deploy/Dockerfile \
  -t "${IMAGE}" \
  --label "isola.commit=${SHA}" \
  --label "isola.provenance=head-plus-health-sha-additive" \
  --label "isola.purpose=customer-360-staging" \
  . 2>&1 | tail -25

echo
echo "=== built ==="
sudo docker image inspect "${IMAGE}" --format '  id={{.Id}}
  commit={{index .Config.Labels "isola.commit"}}
  provenance={{index .Config.Labels "isola.provenance"}}'
