#!/bin/bash
# READ-ONLY on voice00: Asterisk-side traces of the owner's calls in the last 3 hours (file names, counts and masked lines only).
echo "== $(date -u +%T) host local tz: $(date +%Z)"
echo "-- recently modified files under /var/log/asterisk and /var/spool/asterisk (last 180 min):"; find /var/log/asterisk /var/spool/asterisk -type f -mmin -180 -printf '%TY-%Tm-%Td %TH:%TM %s %p\n' 2>/dev/null | head -10
for f in /var/log/asterisk/messages /var/log/asterisk/magnus; do echo "-- $f: lines mentioning the peer=$(grep -c cgsnmg $f 2>/dev/null) DID=$(grep -c 17678185102 $f 2>/dev/null) total=$(wc -l < $f 2>/dev/null)"; done
echo "-- last 6 lines of messages (masked):"; tail -6 /var/log/asterisk/messages 2>/dev/null | sed -E 's/[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}/<ip>/g; s/[0-9]{9,}/<n>/g' | cut -c1-180
echo "-- sip show peers matching 5102-era names or online count: $(asterisk -rx 'sip show peers' 2>&1 | grep -c -E 'cgsnmg|lt_')"
echo "-- CDR backends: $(asterisk -rx 'cdr show status' 2>&1 | head -6 | tr '\n' ';' | cut -c1-200)"
