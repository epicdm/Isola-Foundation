#!/bin/bash
# deepseek, isolated: realpg tests for image $1 against a throwaway Postgres with NO network (loopback only); the test container joins
# its network namespace, so 127.0.0.1:5432 is that throwaway database and nothing else.
Z=/home/epicdm/zz-lanea-rc16-20261011; T=${1:?tag}; L=$Z/realpg-$T.log; : > $L
N=zzrc16pg$$
docker run -d --name $N --network none -e POSTGRES_PASSWORD=pgtest -e POSTGRES_DB=lockvoid_rc16 postgres:16 > $Z/pg-$T.out 2>&1
for i in $(seq 1 60); do docker exec $N pg_isready -h 127.0.0.1 -U postgres -d lockvoid_rc16 >/dev/null 2>&1 && break; sleep 1; done
echo "pg ready after ${i}s" >> $L
docker run --rm --network container:$N -e LOCK_TEST_PG_URL=postgresql://postgres:pgtest@127.0.0.1:5432/lockvoid_rc16 zz-rc16-test:$T npx vitest run test/pl-store-button-claim.realpg.test.ts test/pl-concierge.realpg.test.ts > $Z/vt-realpg-$T.out 2>&1
echo "vitest realpg $T EXIT=$?" >> $L
sed -E 's/\x1b\[[0-9;]*m//g' $Z/vt-realpg-$T.out | grep -E "Test Files|Tests |FAIL|✓|×|↓|skipped|Error|error" | head -50 >> $L
docker rm -f $N >/dev/null 2>&1
echo "### DONE" >> $L
