#!/bin/bash
# READ-ONLY on voice00: where does the NEW peer name appear anywhere in Asterisk/Magnus config, and which Asterisk files changed in the last 3 days (names + mtimes only).
echo "files containing the new peer name (paths only):"; grep -rl "lt_cgsnmg2jyf" /etc/asterisk /var/lib/asterisk /var/www/html/mbilling/resources 2>/dev/null | head -5
echo "asterisk config files modified in the last 3 days:"; find /etc/asterisk -maxdepth 1 -type f -mtime -3 -printf '%TY-%Tm-%Td %TH:%TM %p\n' 2>/dev/null | sort | tail -8
echo "voice00 hosts Magnus? $( [ -d /var/www/html/mbilling ] && echo yes || echo no ) ; sip.conf includes:"; grep -E "^#include|^\[general\]|^registrar|realm|allowguest" /etc/asterisk/sip.conf | head -6
echo "peers present in sip_magnus_user.conf: $(grep -c '^\[' /etc/asterisk/sip_magnus_user.conf) ; the 10 most recent section names by position (names only):"; grep '^\[' /etc/asterisk/sip_magnus_user.conf | tail -3
echo "REGISTER lines in the last asterisk log containing 'cgsnmg' or the previous owner peer (count): $(grep -c -E 'cgsnmg|8rmb43kt5m' /var/log/asterisk/full 2>/dev/null)"
