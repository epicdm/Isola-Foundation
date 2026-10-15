#!/bin/bash
# Replays REAL-BROWSER navigation headers (what a phone sends) against the live host. Prints status and only the Location HOST+PATH (no query). No secrets.
UA="Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
N=$(printf 'a1b2c3d4%.0s' 1 2 3 4)
probe() { # label path expect
  curl -sS -m 20 -o /tmp/br.body -D /tmp/br.hdr -A "$UA" -H "Sec-Fetch-Dest: document" -H "Sec-Fetch-Mode: navigate" -H "Accept: text/html,application/xhtml+xml" "https://bff.epic.dm$2" -w "%{http_code}" > /tmp/br.code
  code=$(cat /tmp/br.code); loc=$(grep -i '^location:' /tmp/br.hdr | sed -E 's/^[Ll]ocation: (https?:\/\/[^\/?]+)(\/[^?]{0,50}).*/\1\2/' | tr -d '\r'); clerk=$(grep -ci '^x-clerk-auth-status: handshake' /tmp/br.hdr)
  printf '%-34s %-4s handshake=%s %s\n' "$1" "$code" "$clerk" "${loc:+-> $loc}"
}
echo "== customer pages: expect 200, handshake=0"
probe "/go/<nonce-shaped>"         "/go/$N"
probe "/go/back"                   "/go/back"
probe "/join"                      "/join"
probe "/api/lite/acrobits/tab-entry (no creds)" "/api/lite/acrobits/tab-entry"
echo "== CONTROL: non-exempt pages must STILL reach Clerk (handshake=1) - proves the probe can see a handshake"
probe "/dashboard"                 "/dashboard"
probe "/sign-in"                   "/sign-in"
echo "== service state"
ssh -o ConnectTimeout=15 epicadmin@host04 "sudo docker service ls --format '{{.Name}} {{.Replicas}}' | grep plsvc-app; P=\$(sudo docker ps -q -f name=uplink_plsvc-app | head -1); sudo docker exec \$P node -e \"fetch('http://127.0.0.1:3005/api/health').then(r=>console.log('health',r.status))\"" 2>/dev/null | grep -v '^#'
