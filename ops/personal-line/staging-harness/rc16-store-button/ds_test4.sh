#!/bin/bash
# deepseek, isolated: final rc16 head d80fe724 - test image, typecheck vs base, rc16 unit tests, full suite failure-set vs base,
# realpg (rc16 + base, loopback-only throwaway Postgres).
Z=/home/epicdm/zz-lanea-rc16-20261011; L=$Z/test4.log; : > $L; say() { echo "$*" >> $L; }
B=$Z/tb-rc16c; mkdir -p $B && tar xf $Z/rc16c.tar -C $B
cp $Z/Dockerfile.rc16test $Z/Dockerfile.rc16test.dockerignore $B/
DOCKER_BUILDKIT=1 docker build --progress=plain -f $B/Dockerfile.rc16test -t zz-rc16-test:rc16c $B > $Z/tb-rc16c.out 2>&1; say "test image rc16c EXIT=$?"
docker run --rm --network none zz-rc16-test:rc16c npx tsc --noEmit -p tsconfig.json > $Z/tsc4.out 2>&1; say "tsc rc16c EXIT=$? errors=$(grep -c 'error TS' $Z/tsc4.out)"
sed -E 's/\([0-9]+,[0-9]+\)//' $Z/tsc4.out | grep 'error TS' | sort > $Z/tsc4.norm
say "tsc errors only in rc16c (not in base): $(comm -13 $Z/tsc3-base.norm $Z/tsc4.norm | wc -l)"; comm -13 $Z/tsc3-base.norm $Z/tsc4.norm | head >> $L
docker run --rm --network none zz-rc16-test:rc16c npx vitest run test/pl-store-button-payload.test.ts test/pl-store-button-dedupe.test.ts test/pl-signup-flow-store-step.test.ts > $Z/vt4-new.out 2>&1; say "vitest rc16 unit EXIT=$?"
sed -E 's/\x1b\[[0-9;]*m//g' $Z/vt4-new.out | grep -E "^ (✓|×|FAIL)|Test Files|Tests " >> $L
docker run --rm --network none zz-rc16-test:rc16c npx vitest run > $Z/vt4-full.out 2>&1; say "vitest FULL rc16c EXIT=$?"
sed -E 's/\x1b\[[0-9;]*m//g' $Z/vt4-full.out | grep -E "^ +(Test Files|Tests) " | tail -2 >> $L
sed -E 's/\x1b\[[0-9;]*m//g' $Z/vt4-full.out | grep -E "^ FAIL " | sed -E 's/ >.*//' | sort -u > $Z/vt4-fail.txt
say "failing test files only in rc16c (not in base): $(comm -13 $Z/vt3-fail-base.txt $Z/vt4-fail.txt | wc -l)"; comm -13 $Z/vt3-fail-base.txt $Z/vt4-fail.txt >> $L
bash $Z/ds_realpg.sh rc16c; cat $Z/realpg-rc16c.log | grep -v "prisma:error" >> $L
bash $Z/ds_realpg.sh base; echo "base:" >> $L; cat $Z/realpg-base.log | grep -v "prisma:error" >> $L
say "### DONE $(date -u +%T)"
