#!/bin/bash
# Install pl-watch v2 over the running v1 (timer unchanged). Backup first; ROLLBACK: cp /usr/local/lib/pl-watch/pl-watch.py.v1 /usr/local/lib/pl-watch/pl-watch.py
set -eu
D=/usr/local/lib/pl-watch
[ -f $D/pl-watch.py.v1 ] || cp -p $D/pl-watch.py $D/pl-watch.py.v1
echo "v1 backup sha: $(sha256sum $D/pl-watch.py.v1 | cut -c1-16) (expect 035a35b82731ceb5)"
python3 -c "import ast;ast.parse(open('/tmp/pl-watch-v2.py').read())"
install -m 750 -o root -g root /tmp/pl-watch-v2.py $D/pl-watch.py
# known test identities (digits): the owner-declared test numbers and the ratified synthetic fixture from scripts/ops/lib/fixture-allowlist.ts; their rows never alert
printf '%s\n' 17672859610 17675550911 14158408440 18633994961 > /var/lib/pl-watch/known-test-identities
chmod 640 /var/lib/pl-watch/known-test-identities
echo "installed sha: $(sha256sum $D/pl-watch.py | cut -c1-16)"
python3 $D/pl-watch.py --dry-run 2>&1 | grep -E "^(FAIL|OK   (no |signup)|dry)"
