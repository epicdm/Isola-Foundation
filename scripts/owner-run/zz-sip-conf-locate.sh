#!/bin/bash
# READ-ONLY on voice00: where are SIP peers defined, and is the new peer / the tester's peer present in the generated config (names and mtimes only; no secrets printed).
for f in /etc/asterisk/sip_magnus_user.conf /etc/asterisk/sip_magnus.conf /etc/asterisk/sip.conf; do
  [ -f $f ] && echo "$f mtime=$(stat -c %y $f | cut -c1-19) size=$(stat -c %s $f) has_new_peer=$(grep -c 'lt_cgsnmg2jyf' $f) has_tester_peer=$(grep -c 'lt_cmrayt5vj000' $f) has_old9610=$(grep -c 'lt_8rmb43kt5m' $f)"
done
echo "now=$(date -u +%T) ; last asterisk reload lines:"; grep -h -i -E "reload|Reloading" /var/log/asterisk/full 2>/dev/null | tail -3 | cut -c1-140
echo "cron/timers mentioning magnus/sip reload:"; (crontab -l 2>/dev/null; cat /etc/cron.d/* 2>/dev/null) | grep -i -E "magnus|sip|reload" | cut -c1-160 | head -5
