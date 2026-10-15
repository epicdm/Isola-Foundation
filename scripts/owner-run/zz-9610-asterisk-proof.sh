#!/bin/bash
# READ-ONLY on voice00: independent proof of the owner's registration and calls. Peer state, log lines for the peer and for the Asterisk uniqueid of the outgoing CDR (1791963481.184839), INVITEs to the DID ...5102; IPs masked. Positive control = the same greps for the old fixture CDR uniqueid-free pattern (peer count) and total log lines.
echo "== $(date -u +%T)  asterisk: $(asterisk -rx 'core show version' 2>&1 | head -1 | cut -c1-60)"
echo "-- sip show peer (new line):"; asterisk -rx "sip show peer lt_cgsnmg2jyf" 2>&1 | grep -E "not found|Status|Addr->IP|Useragent|Reg. Contact|Def. Username|Secret" | grep -v -i secret | tr -s ' ' | sed -E 's/[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}/<ip>/g'
echo "-- control: peers online/offline: $(asterisk -rx 'sip show peers' 2>&1 | tail -1)"
echo "-- peer in config files: $(grep -rl 'lt_cgsnmg2jyf' /etc/asterisk 2>/dev/null | tr '\n' ' ')"
L=/var/log/asterisk/full; echo "-- log control: lines today=$(grep -c "$(date -u +%Y-%m-%d)" $L 2>/dev/null) ; log first/last: $(head -1 $L | cut -c1-20) / $(tail -1 $L | cut -c1-20)"
echo "-- REGISTER/INVITE lines mentioning the peer (masked):"; grep -h "lt_cgsnmg2jyf" $L 2>/dev/null | sed -E 's/[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}/<ip>/g; s/(secret|password|response)[^ ]*/\1=<h>/g' | cut -c1-190 | tail -12
echo "-- lines for the outgoing uniqueid:"; grep -h "1791963481.184839" $L 2>/dev/null | sed -E 's/[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}/<ip>/g' | cut -c1-190 | head -6
echo "-- anything for DID 5102 (inbound):"; grep -h "17678185102" $L 2>/dev/null | sed -E 's/[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}/<ip>/g' | cut -c1-190 | tail -8
echo "-- CDR csv (Master.csv) tail for the peer / DID:"; for f in /var/log/asterisk/cdr-csv/Master.csv; do [ -f $f ] && grep -h -E "cgsnmg|17678185102" $f | tail -4 | sed -E 's/"[A-Za-z0-9+\/]{20,}"/"<h>"/g' | cut -c1-230; done
