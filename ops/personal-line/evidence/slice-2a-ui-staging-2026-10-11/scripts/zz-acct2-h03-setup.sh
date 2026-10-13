#!/bin/bash
# zz-acct2 host03 STAGING setup: dirs, throwaway CA/cert, random keys (never printed). Target assertion first.
set -e
[ "$(hostname)" != "" ] || exit 1
D=/home/epicadmin/zz-acct2-20261011
mkdir -p $D/tls $D/keys $D/mock
umask 077
cd $D/tls
if [ ! -f ca.crt ]; then
  openssl req -x509 -newkey rsa:2048 -nodes -keyout ca.key -out ca.crt -days 2 -subj "/CN=zzacct2-throwaway-ca" 2>/dev/null
  openssl req -newkey rsa:2048 -nodes -keyout sink.key -out sink.csr -subj "/CN=api.smtp2go.com" 2>/dev/null
  printf 'subjectAltName=DNS:api.smtp2go.com,DNS:api.resend.com\n' > san.ext
  openssl x509 -req -in sink.csr -CA ca.crt -CAkey ca.key -CAcreateserial -out sink.crt -days 2 -extfile san.ext 2>/dev/null
  chmod 644 ca.crt sink.crt sink.key
fi
for k in events summary; do [ -f $D/keys/$k ] || head -c 36 /dev/urandom | base64 -w0 | tr '+/' 'ab' > $D/keys/$k; chmod 644 $D/keys/$k; done
chmod 755 $D $D/tls $D/keys $D/mock
echo "keys present:"; for k in events summary; do echo " $k len=$(wc -c < $D/keys/$k) prefix=$(cut -c1-4 $D/keys/$k)"; done
echo tls: $(ls $D/tls | tr '\n' ' ')
