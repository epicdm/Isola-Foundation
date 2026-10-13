#!/bin/bash
R=/var/tmp/plstage-n; N=plj-net2
RELAY=localhost:5000/pl/sf-relay-ctx@sha256:636a0af88cdc0db223925b708de342174b98ee9f32098af1261e41a6dc3adde5
echo "no-delivery proof (from the driver container): graph.facebook.com / example.com reachable?"
docker run --rm --network $N --user root $RELAY node -e 'for (const u of ["https://graph.facebook.com/","https://example.com/"]) { const c=new AbortController(); setTimeout(()=>c.abort(),4000); fetch(u,{signal:c.signal}).then(()=>console.log(u,"REACHED")).catch(e=>console.log(u,"unreachable:",e.cause?.code||e.name)) } ; fetch("http://world-n:3000/__sink").then(r=>console.log("control: world-n sink HTTP",r.status))' 2>&1 | cut -c1-160
docker run --rm --network $N --user root -v $R:/k:ro -v $R/driver.mjs:/d/driver.mjs:ro -w /app $RELAY node /d/driver.mjs 2>&1 | cut -c1-330
