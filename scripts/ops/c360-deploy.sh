#!/usr/bin/env bash
###############################################################################
# scripts/ops/c360-deploy.sh -- runs ON host03. Deploys the isola360uat stack.
# Paired with scripts/ops/c360-remote-build.sh, which builds the image this
# script deploys and embeds the ancestry labels this script enforces.
#
# Usage (run this file's own content on host03 -- see INDEX.md for how to
# get it there):
#   deploy.sh <commit-sha> [--bootstrap] [--override AUTHORIZED:<port-entity-id>]
#
# GUARDS, added 2026-09-05 (dec-c360-deploy-ancestry-guard-2026-09-05).
# Twice already, another session deployed this stack directly while this
# lane was mid-task; both times the deployed commit happened to be an
# ancestor of what this lane deployed next, so nothing was lost -- but this
# script had no mechanism that would have CAUGHT it if it hadn't been. Two
# guards close that gap:
#
#   GUARD A -- build-id-match. Refuses to swap the live image unless the
#   image CURRENTLY serving matches what THIS script last recorded shipping
#   (state file below). Catches "someone deployed since I last shipped,"
#   regardless of whether that other deploy was safe.
#
#   GUARD B -- ancestry-verified. Refuses to swap in an image whose
#   isola.ancestry-verified label (baked in by remote-build.sh, computed by
#   the release lane on a machine with real GitHub access -- see that
#   script's own header) is missing or not exactly "YES". Catches a
#   non-ancestor image being deployed at all, regardless of what is
#   currently running.
#
# Both guards REFUSE LOUDLY and stop -- never warn-and-continue. Both accept
# the SAME named override, because a guard nobody can get past in an
# emergency gets disabled instead, which is the same as no guard:
#
#   --override AUTHORIZED:<port-entity-id>
#
# The override is for ONE recognised legitimate case: a deliberate rollback
# to an older, already-built tag. That case does not actually need the
# override for Guard B (an old tag's ancestry-verified label was true when
# built and stays true forever -- ancestry is a historical fact about that
# commit, not a claim about the current branch tip), but WILL usually need
# it for Guard A, because the very reason you are rolling back is that
# something else is currently running that does not match your last
# recorded state. Every override use is logged with the entity id, and the
# state file is still updated afterward so the NEXT deploy has a correct
# baseline rather than inheriting the mismatch.
#
# First run after this guard was added: the state file does not exist yet.
# Pass --bootstrap once, having satisfied yourself the serving image is the
# one you expect (same convention as bff-v2's deploy-next-swap.sh).
#
# REGISTERED 2026-09-05 (dec-c360-ops-procedure-registry-2026-09-05). This
# file used to be materialized per build with SHA/SHORT hand-substituted at
# the top by whoever ran remote-build.sh, then scp'd to host03 with no
# canonical copy anywhere -- exactly the class of problem this registry
# exists to close. It now takes the commit sha as its one required argument;
# everything else it needs is either derived from that or is a genuinely
# static per-environment constant (ISSUER_URL, ODOO_URL/DB, the tenant-key
# path below), which is why those stay as fixed values here rather than
# arguments -- they do not change per deploy.
###############################################################################
set -uo pipefail

DEPLOY_SHA="${1:?commit sha required, e.g. 5fe25d3b970515b85e7f02c00bf173af10b5ba78}"
SHORT="${DEPLOY_SHA:0:8}"
shift
DIR="/home/epicadmin/builds/isola360-${SHORT}"
IMAGE="isola-foundation-360:${SHORT}"
export IMAGE_TAG="${SHORT}"
export DEPLOY_SHA

STATE_FILE="/home/epicadmin/builds/.isola360-deploy-state"

export ISSUER_URL="https://isola-360-auth.saas00.epic.dm/realms/isola"
export TENANT_MASTER_KEY="$(cat /home/epicadmin/builds/.tenant_master_key)"

export ODOO_URL=https://epic-communications-inc.odoo.com
export ODOO_DB=epic-communications-inc

fail() { echo "REFUSED: $1" >&2; exit 1; }

BOOTSTRAP=0
OVERRIDE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --bootstrap) BOOTSTRAP=1; shift ;;
    --override)  OVERRIDE="${2:?--override requires AUTHORIZED:<port-entity-id>}"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
if [ -n "$OVERRIDE" ]; then
  case "$OVERRIDE" in
    AUTHORIZED:*) ;;
    *) fail "--override value must be AUTHORIZED:<port-entity-id>, got: '${OVERRIDE}'" ;;
  esac
fi

cd "$DIR"

echo "=== PRE-STATE: rollback baseline ==="
echo "  isola360uat services now: $(sudo docker service ls --filter name=isola360uat -q | wc -l)"
echo "  CONTROL total services on host: $(sudo docker service ls -q | wc -l)"
CURRENT_IMAGE="$(sudo docker service ps isola360uat_app --filter desired-state=running --format '{{.Image}}' 2>/dev/null | head -1)"
echo "  current running task image: ${CURRENT_IMAGE}"

echo
echo "=== GUARD A: build-id-match against last-recorded state ==="
if [ -f "$STATE_FILE" ]; then
  LAST_IMAGE="$(grep -E '^image=' "$STATE_FILE" | cut -d= -f2-)"
  echo "  last recorded by this script : ${LAST_IMAGE}"
  echo "  currently serving            : ${CURRENT_IMAGE}"
  if [ "${CURRENT_IMAGE}" != "${LAST_IMAGE}" ]; then
    if [ -n "$OVERRIDE" ]; then
      echo "  MISMATCH -- OVERRIDDEN via ${OVERRIDE}. Someone else deployed since this script last shipped (or this is a deliberate rollback). Proceeding because an explicit, entity-tied override was supplied. This is logged, not silent."
    else
      fail "someone else deployed since this script last shipped (or this is a deliberate rollback and you meant to pass --override AUTHORIZED:<entity>). Deploying now could silently revert their work -- the exact failure this guard exists to catch. Find out what is in the serving build before proceeding, or re-run with --override AUTHORIZED:<port-entity-id> if this is a deliberate, authorized rollback."
    fi
  else
    echo "  MATCH -- proceeding."
  fi
elif [ "$BOOTSTRAP" -eq 1 ]; then
  echo "  (no state file; --bootstrap recording the current image as the baseline)"
else
  fail "no ${STATE_FILE} yet, so this guard cannot know what it last shipped. Re-run with --bootstrap once, having satisfied yourself the serving image (${CURRENT_IMAGE}) is the one you expect."
fi

echo
echo "=== GUARD B: ancestry-verified label on the image being deployed ==="
IMG_COMMIT="$(sudo docker image inspect "$IMAGE" --format '{{index .Config.Labels "isola.commit"}}' 2>/dev/null || echo '')"
IMG_ANCESTRY_REF="$(sudo docker image inspect "$IMAGE" --format '{{index .Config.Labels "isola.ancestry-ref"}}' 2>/dev/null || echo '')"
IMG_ANCESTRY_VERIFIED="$(sudo docker image inspect "$IMAGE" --format '{{index .Config.Labels "isola.ancestry-verified"}}' 2>/dev/null || echo '')"
echo "  image commit label     : ${IMG_COMMIT}"
echo "  image ancestry-ref     : ${IMG_ANCESTRY_REF}"
echo "  image ancestry-verified: ${IMG_ANCESTRY_VERIFIED}"
if [ "$IMG_COMMIT" != "$DEPLOY_SHA" ]; then
  fail "image ${IMAGE}'s isola.commit label ('${IMG_COMMIT}') does not match DEPLOY_SHA ('${DEPLOY_SHA}') -- the image tag and its recorded commit disagree. Do not deploy a mislabeled image."
fi
if [ "$IMG_ANCESTRY_VERIFIED" != "YES" ]; then
  if [ -n "$OVERRIDE" ]; then
    echo "  NOT VERIFIED (value: '${IMG_ANCESTRY_VERIFIED:-<missing>}') -- OVERRIDDEN via ${OVERRIDE}. Proceeding because an explicit, entity-tied override was supplied. This is logged, not silent."
  else
    fail "image ${IMAGE} has no verified ancestry-verified=YES label (value: '${IMG_ANCESTRY_VERIFIED:-<missing>}'). This image was never confirmed reachable from ${IMG_ANCESTRY_REF:-<unknown ref>} by the release lane before being built. Refusing to deploy unreviewed/unmerged code. If this is a deliberate exception, re-run with --override AUTHORIZED:<port-entity-id>."
  fi
else
  echo "  VERIFIED -- proceeding."
fi

echo
echo "=== deploying stack isola360uat (image ${IMAGE_TAG}) ==="
sudo -E docker stack deploy \
  --resolve-image never \
  -c deploy/stack.yml isola360uat 2>&1 | sed 's/^/  /'

echo
echo "=== waiting for the app to converge and SERVE the new image ==="
CONVERGED=0
for i in $(seq 1 60); do
  rep=$(sudo docker service ls --filter name=isola360uat_app --format '{{.Replicas}}' 2>/dev/null)
  cid=$(sudo docker ps -q --filter label=com.docker.swarm.service.name=isola360uat_app | head -1)
  img=""
  code=""
  if [ -n "$cid" ]; then
    img=$(sudo docker inspect "$cid" --format '{{.Config.Image}}' 2>/dev/null)
    code=$(sudo docker exec "$cid" curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:3000/api/health 2>/dev/null)
  fi
  echo "  [${i}] replicas=${rep:-?} running_image=${img:-?} internal_health_http=${code:-?}"
  [ "${code:-}" = "200" ] && [ "${img#*:}" = "${SHORT}" ] && { echo "  SERVING THE NEW IMAGE"; CONVERGED=1; break; }
  [ "$i" = "60" ] && echo "  DID NOT CONVERGE ON THE NEW IMAGE"
  sleep 5
done

echo
echo "=== task state ==="
sudo docker service ps isola360uat_app --no-trunc --format '  {{.Name}} {{.CurrentState}} {{.Error}}' 2>/dev/null | head -8

echo
echo "=== last app logs ==="
sudo docker service logs isola360uat_app --tail 30 2>&1 | sed 's/^/  /' | tail -35

if [ "$CONVERGED" -eq 1 ]; then
  {
    echo "image=${IMAGE}"
    echo "commit=${DEPLOY_SHA}"
    echo "ancestry_ref=${IMG_ANCESTRY_REF}"
    echo "ancestry_verified=${IMG_ANCESTRY_VERIFIED}"
    echo "deployed_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "deployed_by=${DEPLOY_OPERATOR:-$(whoami)}"
    echo "override_used=${OVERRIDE:-none}"
  } > "$STATE_FILE"
  echo
  echo "=== state recorded: ${STATE_FILE} ==="
else
  echo
  echo "=== WARNING: did not converge -- state file NOT updated, baseline stays at prior value ==="
fi
