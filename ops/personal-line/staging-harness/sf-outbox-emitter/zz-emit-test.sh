#!/bin/bash
# deepseek, isolated (never /opt, never a live checkout). Lane A lifecycle emitter: TEST image from a git-archive tar ($1 = tag, $2 = tar file name in $Z).
# Mirrors zz-lanea-rc16-20261011/ds_test6.sh + ds_realpg.sh. Unit/realpg containers run on --network none (loopback to a throwaway postgres only); nothing is deployed.
Z=/home/epicdm/zz-lanea-emitter-20261011; TAG=${1:?tag}; TAR=${2:?tar}; MODE=${3:-all}; L=$Z/zz-emit-test-$TAG.log
[ "$MODE" = "all" ] && : > $L
say() { echo "$*" >> $L; }
B=$Z/tb-$TAG
if [ "$MODE" = "all" ]; then
  rm -rf $B 2>/dev/null; mkdir -p $B && tar xf $Z/$TAR -C $B
  cp /home/epicdm/zz-lanea-rc16-20261011/Dockerfile.rc16test /home/epicdm/zz-lanea-rc16-20261011/Dockerfile.rc16test.dockerignore $B/
  DOCKER_BUILDKIT=1 docker build --progress=plain -f $B/Dockerfile.rc16test -t zz-emit-test:$TAG $B > $Z/tb-$TAG.out 2>&1; say "test image $TAG EXIT=$?"
fi
R="docker run --rm --network none zz-emit-test:$TAG"
if [ "$MODE" = "all" ] || [ "$MODE" = "unit" ]; then
  $R npx vitest run test/pl-sf-outbox.test.ts test/pl-sf-outbox-cron-route.test.ts > $Z/vt-new-$TAG.out 2>&1; say "vitest NEW unit EXIT=$?"
  sed -E 's/\x1b\[[0-9;]*m//g' $Z/vt-new-$TAG.out | grep -E "^ (✓|×|FAIL)|Test Files|Tests |AssertionError|Error:|expected" | head -80 >> $L
  $R npx vitest run test/pl-concierge-account-summary.test.ts test/pl-concierge-route.test.ts test/pl-concierge-operator-surface.test.ts test/pl-concierge-assertion.test.ts test/pl-concierge-offer.test.ts test/cron-header-auth.test.ts > $Z/vt-exist-$TAG.out 2>&1; say "vitest EXISTING pl-concierge+cron EXIT=$?"
  sed -E 's/\x1b\[[0-9;]*m//g' $Z/vt-exist-$TAG.out | grep -E "Test Files|Tests |FAIL" | head -20 >> $L
  $R npx tsc --noEmit -p tsconfig.json > $Z/tsc-$TAG.out 2>&1
  sed -E 's/\([0-9]+,[0-9]+\)//' $Z/tsc-$TAG.out | grep 'error TS' | sort > $Z/tsc-$TAG.norm; say "tsc errors total=$(wc -l < $Z/tsc-$TAG.norm)"
fi
if [ "$MODE" = "all" ] || [ "$MODE" = "full" ]; then
  $R npx vitest run > $Z/vt-full-$TAG.out 2>&1; say "vitest FULL EXIT=$?"
  sed -E 's/\x1b\[[0-9;]*m//g' $Z/vt-full-$TAG.out | grep -E "^ +(Test Files|Tests) " | tail -2 >> $L
  sed -E 's/\x1b\[[0-9;]*m//g' $Z/vt-full-$TAG.out | grep -E "^ FAIL " | sed -E 's/ >.*//' | sort -u > $Z/vt-fail-$TAG.txt; say "failing files total=$(wc -l < $Z/vt-fail-$TAG.txt)"
fi
if [ "$MODE" = "all" ] || [ "$MODE" = "realpg" ]; then
  N=zzemitpg$$; docker run -d --name $N --network none -e POSTGRES_PASSWORD=pgtest -e POSTGRES_DB=lockvoid_emit postgres:16 > /dev/null
  for i in $(seq 1 60); do docker exec $N pg_isready -h 127.0.0.1 -U postgres -d lockvoid_emit >/dev/null 2>&1 && break; sleep 1; done
  docker run --rm --network none -e DATABASE_URL=postgresql://dummy:dummy@127.0.0.1:1/dummy zz-emit-test:$TAG npx prisma migrate diff --from-empty --to-schema prisma/schema.prisma --script > $Z/schema-$TAG.sql 2> $Z/schema-$TAG.err; say "schema diff EXIT=$? lines=$(wc -l < $Z/schema-$TAG.sql)"
  docker exec $N psql -q -U postgres -d lockvoid_emit -c 'create extension if not exists pgcrypto' > /dev/null 2>&1
  docker exec -i $N psql -v ON_ERROR_STOP=1 -q -U postgres -d lockvoid_emit < $Z/schema-$TAG.sql > $Z/schema-apply-$TAG.out 2>&1; say "schema apply EXIT=$?"
  docker run --rm --network container:$N -e LOCK_TEST_PG_URL=postgresql://postgres:pgtest@127.0.0.1:5432/lockvoid_emit zz-emit-test:$TAG npx vitest run test/pl-sf-outbox.realpg.test.ts > $Z/vt-realpg-$TAG.out 2>&1; say "vitest NEW realpg EXIT=$?"
  sed -E 's/\x1b\[[0-9;]*m//g' $Z/vt-realpg-$TAG.out | grep -E "Test Files|Tests |FAIL|✓|×|↓|skipped|Error|expected|\[realpg\]" | head -60 >> $L
  docker run --rm --network container:$N -e LOCK_TEST_PG_URL=postgresql://postgres:pgtest@127.0.0.1:5432/lockvoid_emit zz-emit-test:$TAG npx vitest run test/pl-concierge.realpg.test.ts test/lite-provision-lock.realpg.test.ts > $Z/vt-realpg-exist-$TAG.out 2>&1; say "vitest EXISTING realpg EXIT=$?"
  sed -E 's/\x1b\[[0-9;]*m//g' $Z/vt-realpg-exist-$TAG.out | grep -E "Test Files|Tests |FAIL|skipped" | head -20 >> $L
  docker rm -f $N >/dev/null 2>&1
fi
say "### DONE $(date -u +%T)"
