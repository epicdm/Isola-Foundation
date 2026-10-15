#!/bin/bash
# zz-launch-open-1767: OWNER DECISION 2026-10-14 ("Open signup, ads held"; queued senders left queued). Opens Personal Line signup to +1 767
# numbers by setting LITE_ADMISSION_OPEN_COUNTRY_PREFIXES=["1767"] in the plsvc runtime flags file, IN PLACE (the container bind-mounts this
# single file). Nothing else in the file changes. Queue: no code drains lite_admission_queue and schedulers are off, so queued senders get nothing.
#   sudo bash zz-launch-open-1767.sh          -> open (refuses unless the file is at the expected pre-change sha)
#   sudo bash zz-launch-open-1767.sh revert   -> write the pre-change bytes back in place
set -eu
F=/home/epicadmin/plprod/runtime-flags.json; B=/var/backups/launch-open-1767-20261014; EXPECT=e9dad18dd324
mkdir -p $B
if [ "${1:-}" = "revert" ]; then cat $B/runtime-flags.json.pre > $F; echo "reverted: $(sha256sum $F | cut -c1-12)"; exit 0; fi
[ "$(sha256sum $F | cut -c1-12)" = "$EXPECT" ] || { echo "flags file is not at the expected $EXPECT; refusing"; exit 3; }
[ -e $B/runtime-flags.json.pre ] || cp -p $F $B/runtime-flags.json.pre
python3 - "$F" > $B/runtime-flags.json.new <<'EOF'
import json, sys
f = json.load(open(sys.argv[1]))
before = {k: v for k, v in f.items()}
f["LITE_ADMISSION_OPEN_COUNTRY_PREFIXES"] = ["1767"]
changed = [k for k in set(f) | set(before) if f.get(k) != before.get(k)]
assert changed == ["LITE_ADMISSION_OPEN_COUNTRY_PREFIXES"], changed
assert f.get("LITE_ADMISSION_PAUSED") in (False, None)
print(json.dumps(f, indent=2))
EOF
cat $B/runtime-flags.json.new > $F
echo "opened: $(sha256sum $F | cut -c1-12) (was $EXPECT); backup $B/runtime-flags.json.pre"
