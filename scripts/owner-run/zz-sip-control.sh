#!/bin/bash
# READ-ONLY control for the SIP instrument: does `sip show peer` find KNOWN peers (tester lt_cmrayt5vj000, owner's previous lt_8rmb43kt5m) and the new one? Name + found/not found + Status only.
for p in lt_cmrayt5vj000 lt_8rmb43kt5m lt_cgsnmg2jyf; do
  echo "$p: $(asterisk -rx "sip show peer $p" 2>&1 | grep -E "not found|Status|Addr->IP" | tr -s ' ' | tr '\n' ';' | sed -E 's/[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}/<ip>/g' | cut -c1-160)"
done
echo "peers whose name contains cgsnmg: $(asterisk -rx 'sip show peers' 2>&1 | grep -c cgsnmg)"
asterisk -rx 'sip show settings' 2>&1 | grep -i -E "realtime|rtcachefriends|rtupdate|rtautoclear" | head -4
