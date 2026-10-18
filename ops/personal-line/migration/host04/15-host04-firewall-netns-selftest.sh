#!/usr/bin/env bash
# 15-host04-firewall-netns-selftest.sh -- LOCAL TEST HARNESS (run on a Linux dev box / WSL as root, NEVER on host04).
# Proves the ruleset in 10-host04-firewall-owner-run.sh does what it claims, in throw-away network
# namespaces, with a POSITIVE CONTROL for every negative (CLAUDE.md laws 19/23/28):
#   srv  = "host04": iface ens160 (public side), a DNAT of tcp/3000 -> container (mimics Docker's
#          nat/DOCKER rule), local listeners 22, 2377, 7946, 443
#   ctr  = the "container" behind the DNAT, listening on 3000
#   adm  = admin source (10.0.0.10), ext = non-admin source (10.0.0.20)
# Asserts: BEFORE the guard everything is reachable from both (so a later timeout is the guard, not a
# broken fixture); AFTER: admin keeps 22+3000, non-admin loses 22/3000/2377/7946, 443 stays open for
# both (control), an ESTABLISHED ssh session from the non-admin source survives, and `revert` restores.
set -u
[ "$(id -u)" -eq 0 ] || { echo "root required"; exit 2; }
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PASS=0; FAIL=0
ok()  { echo "PASS  $*"; PASS=$((PASS+1)); }
bad() { echo "FAIL  $*"; FAIL=$((FAIL+1)); }

cleanup() { for n in srv ctr adm ext sw; do ip netns pids "$n" 2>/dev/null | xargs -r kill 2>/dev/null; ip netns del "$n" 2>/dev/null; done; }
cleanup; trap cleanup EXIT
for n in srv ctr adm ext sw; do ip netns add $n; ip -n $n link set lo up; done
# switch
ip -n sw link add br0 type bridge; ip -n sw link set br0 up
mk() { # ns ip  -> veth into sw bridge
  ip link add "v$1" type veth peer name "p$1"; ip link set "v$1" netns "$1"; ip link set "p$1" netns sw
  ip -n sw link set "p$1" master br0; ip -n sw link set "p$1" up
}
mk srv; mk adm; mk ext
ip -n srv link set vsrv name ens160; ip -n srv link set ens160 up; ip -n srv addr add 10.0.0.1/24 dev ens160
ip -n adm link set vadm up; ip -n adm addr add 10.0.0.10/24 dev vadm
ip -n ext link set vext up; ip -n ext addr add 10.0.0.20/24 dev vext
# srv <-> ctr (docker_gwbridge stand-in)
ip link add gw type veth peer name gwc; ip link set gw netns srv; ip link set gwc netns ctr
ip -n srv link set gw up; ip -n srv addr add 172.18.0.1/24 dev gw
ip -n ctr link set gwc up; ip -n ctr addr add 172.18.0.3/24 dev gwc; ip -n ctr route add default via 172.18.0.1
ip netns exec srv sysctl -qw net.ipv4.ip_forward=1
# Docker-like DNAT (separate table so the guard's own table is the only thing under test)
ip netns exec srv nft -f - <<'EOF'
table ip fakedocker {
  chain pre { type nat hook prerouting priority -100; iifname != "gw" tcp dport 3000 dnat to 172.18.0.3:3000; }
}
EOF
# listeners (python echo)
cat > /tmp/echo.py <<'EOF'
import socket,sys,threading
port=int(sys.argv[1]); s=socket.socket(); s.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1); s.bind(("0.0.0.0",port)); s.listen(16)
def h(c):
    try:
        while True:
            d=c.recv(1024)
            if not d: break
            c.sendall(d)
    finally: c.close()
while True:
    c,_=s.accept(); threading.Thread(target=h,args=(c,),daemon=True).start()
EOF
for p in 22 2377 7946 443; do ip netns exec srv python3 /tmp/echo.py $p & done
ip netns exec ctr python3 /tmp/echo.py 3000 &
sleep 1
probe() { # ns port -> OPEN|BLOCKED
  ip netns exec "$1" python3 -c "
import socket,sys
s=socket.socket(); s.settimeout(2)
try: s.connect(('10.0.0.1',$2)); print('OPEN')
except Exception as e: print('BLOCKED')
"; }
expect() { local got; got="$(probe "$1" "$2")"; [ "$got" = "$3" ] && ok "$1 -> :$2 = $got ($4)" || bad "$1 -> :$2 = $got, wanted $3 ($4)"; }

echo "== BEFORE guard (fixture control: everything must be reachable from both)"
for who in adm ext; do for p in 22 3000 2377 7946 443; do expect $who $p OPEN "fixture control"; done; done

# long-lived ssh session from the NON-admin source, opened before the guard
ip netns exec ext python3 - <<'EOF' &
import socket,time
s=socket.socket(); s.connect(("10.0.0.1",22)); s.settimeout(30)
open("/tmp/sess.log","w").write("")
for i in range(20):
    time.sleep(1)
    try:
        s.sendall(b"ping"); d=s.recv(16)
        open("/tmp/sess.log","a").write("ok\n" if d==b"ping" else "bad\n")
    except Exception as e:
        open("/tmp/sess.log","a").write("dead\n")
EOF
sleep 2

echo "== APPLY guard (script's own ruleset, ADMIN=10.0.0.10/32)"
ADMIN_CIDRS4=10.0.0.10/32 bash "$HERE/10-host04-firewall-owner-run.sh" print-ruleset | ip netns exec srv nft -f - && ok "ruleset loaded" || bad "ruleset load"
ip netns exec srv nft list table inet host04_guard | grep -c 'ct original' | grep -q . && ok "ct-original rules present in loaded table"
echo "== AFTER guard"
expect adm 22 OPEN "admin ssh"
expect adm 3000 OPEN "admin console through DNAT"
expect adm 2377 BLOCKED "swarm manager closed even to admin (standalone)"
expect adm 7946 BLOCKED "swarm gossip closed"
expect adm 443 OPEN "web control"
expect ext 22 BLOCKED "non-admin ssh"
expect ext 3000 BLOCKED "non-admin console via DNAT path (forward hook, ct original dport)"
expect ext 2377 BLOCKED "non-admin swarm"
expect ext 7946 BLOCKED "non-admin gossip"
expect ext 443 OPEN "web control (public mode)"
sleep 3
echo "== established non-admin ssh session survived? (sess.log)"
if grep -q '^ok' /tmp/sess.log && ! grep -q 'dead' /tmp/sess.log; then ok "established ssh session from non-admin source survived the apply ($(grep -c ok /tmp/sess.log) echoes)"; else bad "session did not survive: $(sort /tmp/sess.log | uniq -c | tr '\n' ' ')"; fi
echo "== counters prove the DROP rules (not a fixture accident) fired"
ip netns exec srv nft list chain inet host04_guard forward | grep -E 'proto-dst 3000 counter packets [1-9]' >/dev/null && ok "forward drop for 3000 has packets > 0" || bad "forward 3000 counter is 0"
ip netns exec srv nft list chain inet host04_guard input | grep -E 'dport 22 counter packets [1-9]' >/dev/null && ok "input drop for 22 has packets > 0" || bad "input 22 counter is 0"

echo "== NEGATIVE control of the instrument: a deliberately WRONG admin set must lock admin out"
ADMIN_CIDRS4=192.0.2.9/32 bash "$HERE/10-host04-firewall-owner-run.sh" print-ruleset | ip netns exec srv nft -f -
expect adm 3000 BLOCKED "sabotage: admin not in set -> blocked (instrument can see a block)"
echo "== REVERT (delete table)"
ip netns exec srv nft delete table inet host04_guard && ok "table deleted"
for who in adm ext; do for p in 22 3000 2377; do expect $who $p OPEN "after revert"; done; done
echo; echo "SELFTEST: $PASS passed, $FAIL failed"; [ "$FAIL" -eq 0 ]
