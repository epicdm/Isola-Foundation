#!/bin/bash
echo "no-delivery proof (from inside a relay container): the Meta Graph host and a public site must be unreachable; the fake Chatwoot sink reachable (control)"
docker exec relay-new node -e 'for (const u of ["https://graph.facebook.com/","https://example.com/"]) { const c=new AbortController(); setTimeout(()=>c.abort(),4000); fetch(u,{signal:c.signal}).then(()=>console.log(u,"REACHED")).catch(e=>console.log(u,"unreachable:",e.cause?.code||e.name)) } ; fetch("http://world-m:3000/__sink").then(r=>console.log("control: world-m sink HTTP",r.status))' 2>&1 | cut -c1-140
for L in rc10l rc10m; do
  C=relay-old; [ $L = rc10m ] && C=relay-new
  echo; docker exec -e LABEL=$L $C node /d/driver.mjs 2>&1 | cut -c1-330
done
