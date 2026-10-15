#!/bin/bash
# READ-ONLY on voice00: poll up to ${1:-100}s for the owner's NEW SIP peer (lt_cgsnmg2jyf, Magnus sip 793) to register. Prints status fields only (no secrets).
end=$((SECONDS+${1:-100}))
while [ $SECONDS -lt $end ]; do
  out=$(asterisk -rx "sip show peer lt_cgsnmg2jyf" 2>&1)
  ip=$(echo "$out" | grep -E "Addr->IP" | head -1)
  echo "$(date -u +%T) $(echo "$out" | grep -E "not found|Status|Addr->IP|Useragent" | tr -s ' ' | tr '\n' ';' | sed -E 's/[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}/<ip>/g' | cut -c1-200)"
  if echo "$ip" | grep -qv "Unspecified" && [ -n "$ip" ]; then break; fi
  sleep 5
done
echo "-- control (peers online/offline): $(asterisk -rx 'sip show peers' 2>&1 | tail -1)"
echo "-- recent log lines mentioning the peer:"; grep -h "lt_cgsnmg2jyf" /var/log/asterisk/full 2>/dev/null | tail -4 | sed -E 's/[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}/<ip>/g' | cut -c1-200
