#!/bin/bash
# deepseek BUILD ONLY, isolated dir (never /opt, never a live checkout). plsvc STAGING image for rc16 = isolav2 9c5d8439 (rc15 16cefa3c + rc16).
# Same recipe as zz-lanea-acctsum-20261011/b1.sh: synthetic staging build env (build-rc6.env), staging app URL.
Z=/home/epicdm/zz-lanea-rc16-20261011
TAG=${1:?tag}
export GIT_CEILING_DIRECTORIES=$Z
ENVF=/home/epicdm/zz-lanea-plsvc-20261009/build-rc6.env
B=$Z/build-$TAG
[ -e $B ] && { echo "exists $B"; exit 1; }
mkdir -p $B && cd $B && tar xf $Z/${2:-rc16.tar}
echo "build start $(date -u +%T) env=$(basename $ENVF) tag=$TAG" > $Z/build-$TAG.log
DOCKER_BUILDKIT=1 docker build --progress=plain --secret id=bff_env,src=$ENVF --build-arg NEXT_PUBLIC_APP_URL=https://app.staging.epic.dm -t plsvc-staging-synthetic:$TAG . > $Z/build-$TAG.out 2>&1
echo "EXIT=$? $(date -u +%T)" >> $Z/build-$TAG.log
docker image inspect plsvc-staging-synthetic:$TAG --format 'IMAGE {{.Id}} {{.Size}}' >> $Z/build-$TAG.log 2>&1
grep -nE " error |Error:|Failed to compile|Type error" $Z/build-$TAG.out | tail -8 >> $Z/build-$TAG.log
echo "### BUILD DONE" >> $Z/build-$TAG.log
