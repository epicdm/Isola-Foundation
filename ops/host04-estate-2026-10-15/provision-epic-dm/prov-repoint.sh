#!/bin/bash
# deepseek: repoint provision.epic.dm's Acrobits locations from the STOPPED local bff-v2 (127.0.0.1:3005 -> 502 since ~08:59Z)
# to host04 plsvc via bff.epic.dm. Backup first; nginx -t gates the reload; automatic restore on failure.
# Rollback: sudo cp -p "$B" "$F" && sudo nginx -t && sudo systemctl reload nginx
set -u
F=/etc/nginx/sites-available/provision.epic.dm
B=$F.bak-$(date -u +%Y%m%dT%H%M%SZ)-pre-host04-plsvc
cp -p "$F" "$B" || exit 2
echo "backup: $B ($(sha256sum "$B" | cut -c1-12))"
python3 - "$F" <<'PY'
import sys, re
p = sys.argv[1]; s = open(p).read()
blocks = re.split(r'(?=\n    location )', s)
n = 0
for i, b in enumerate(blocks):
    if 'proxy_pass http://127.0.0.1:3005' not in b: continue
    b = b.replace('proxy_pass http://127.0.0.1:3005', 'proxy_pass https://66.118.37.29')
    b = b.replace('proxy_set_header Host $host;', 'proxy_set_header Host bff.epic.dm;\n        proxy_ssl_server_name on;\n        proxy_ssl_name bff.epic.dm;')
    blocks[i] = b; n += 1
s2 = ''.join(blocks)
assert n == 4, ('expected 4 blocks to repoint, found', n)
assert '127.0.0.1:3005' not in s2
open(p, 'w').write(s2); print('repointed blocks:', n)
PY
[ $? -eq 0 ] || { cp -p "$B" "$F"; echo "edit failed; restored"; exit 3; }
if nginx -t 2>&1 | tail -2; then :; fi
nginx -t >/dev/null 2>&1 || { cp -p "$B" "$F"; nginx -t >/dev/null 2>&1; echo "nginx -t FAILED; restored backup"; exit 4; }
systemctl reload nginx && echo "reloaded at $(date -u +%T)"
grep -nE 'proxy_pass|proxy_ssl_name|proxy_set_header Host' "$F" | cut -c1-110
