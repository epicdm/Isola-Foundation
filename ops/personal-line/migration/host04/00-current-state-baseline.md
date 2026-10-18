# host04 (66.118.37.29) - current-state read and exposure baseline

Read-only, 2026-10-11 22:29-22:49Z (host04 `date -u`; external probes from the Lane A workstation 66.118.37.10).
Nothing was changed on host04. No secret value was read or printed (service inspect was filtered with Go
templates that never touch `Env`; `docker exec` was limited to `package.json` version and `traefik version`).

## 1. What is on the box

| Item | Value (read, not assumed) |
|---|---|
| OS / kernel / uptime | Ubuntu 24.04, 6.8.0-146, up since 2026-10-11 21:39Z; load 0.1; 48 GB RAM, 44 GB free |
| Docker | 29.9.0, **firewall backend = iptables** (`docker info`), **containerd image store** (image ID == manifest digest), no `/etc/docker/daemon.json` |
| Swarm | active, 1 node / 1 manager, NodeAddr `127.0.0.1` (standalone) |
| Services | `easypanel` (`easypanel/easypanel:latest`), `easypanel-traefik` (`traefik:3.7.13`); nothing else; 0 local volumes |
| Interfaces | `ens160` 66.118.37.29/22 (public) + global IPv6 `2602:fc3a:1:0:250:56ff:fea4:b47d/64`; `ens192` 10.22.10.246/25 (private); `tailscale0` 100.116.115.19; `docker_gwbridge` 172.18.0.1/16 |
| Routes | **two default routes at metric 100** (ens160 via 66.118.36.1, ens192 via 10.22.10.134) - dual-homed, see deepseek precedent (reboot can flip the default route) |
| Host firewall | **none**: no ufw/firewalld/nftables service, INPUT policy ACCEPT, `DOCKER-USER` empty (only the `-N`), no `DOCKER-INGRESS`/`DOCKER-ISOLATION` chains exist (Docker 29 uses `DOCKER-FORWARD/-BRIDGE/-CT/-INTERNAL`), ip6tables INPUT ACCEPT |
| sshd | port 22 on 0.0.0.0 and [::]; `PermitRootLogin without-password`; **`PasswordAuthentication yes`** (finding, not changed); `KbdInteractive no` |
| Live ssh sessions | 2 from **66.118.37.10** (the Lane A workstation egress; ports 58016, 57074) + 2 local tty/pts |
| tailscale | up, 15 tailnet nodes (deepseek 100.117.210.117, host03 100.117.190.18 idle, voice/PBX peers); `ts-input` accepts everything arriving on `tailscale0` |

## 2. Which ports are reachable from the internet, and WHY

The published ports are `mode=host` (`docker service inspect`: `PublishMode: host`), **not** the Swarm routing
mesh. There is no ingress-mesh publication on this box. The mechanism per port:

| Port | Owner | Why it is reachable | Path through the kernel |
|---|---|---|---|
| tcp/22 | sshd | listens on all addresses; nothing filters | INPUT |
| tcp/3000 | `docker-proxy` -> EasyPanel container 172.18.0.3 | host-mode publish. nat/PREROUTING `-m addrtype --dst-type LOCAL -j DOCKER` then `DOCKER ! -i docker_gwbridge -p tcp --dport 3000 -j DNAT --to 172.18.0.3:3000` | **IPv4: PREROUTING DNAT -> FORWARD -> (DOCKER-USER) -> DOCKER-FORWARD. Never traverses INPUT** (why ufw would do nothing; Docker docs: "nat table ... bypasses INPUT"). **IPv6: no ip6 NAT rule exists; `docker-proxy` listens on `[::]:3000`, so IPv6 arrives in INPUT.** |
| tcp/80, tcp/443 | `docker-proxy` -> Traefik 172.18.0.4 | same mechanism (DNAT to 172.18.0.4:80/443), and `[::]:80/443` via proxy | as above |
| tcp/2377 | dockerd | Swarm manager API, bound `*:2377`; Swarm control plane | INPUT |
| tcp+udp/7946 | dockerd | Swarm gossip (node discovery), `*:7946` | INPUT |
| udp/4789 | kernel `vxlan` (no process) | overlay data path; listener appears because overlay networks exist | INPUT (kernel UDP socket) |

Docker's own docs say 2377/7946/4789 must only be open "between the hosts" and that 4789 (VXLAN, unauthenticated)
"should only be opened to a trusted network, and never at a perimeter firewall". This box has one node, so
**none of them has any legitimate public peer**.

### Baseline probe results (file `host04-exposure-baseline-20261011T224907Z.json`, from `20-host04-verify-external.ps1 -Phase Baseline`)

| Vantage | 22 | 80 | 443 | 2377 | 3000 | 7946 |
|---|---|---|---|---|---|---|
| local workstation 66.118.37.10, IPv4 | OPEN | OPEN | OPEN | OPEN | OPEN | OPEN |
| deepseek 66.118.37.12 (non-admin), IPv4 | OPEN | OPEN | OPEN | OPEN | OPEN | OPEN |
| deepseek, **IPv6** to `2602:fc3a:1:0:250:56ff:fea4:b47d` | OPEN | OPEN | OPEN | OPEN | OPEN | OPEN |
| over tailscale to 100.116.115.19 (local) | OPEN | | | | OPEN | |

HTTP: `http://66.118.37.29:3000/` = 200 (EasyPanel, plain HTTP); `http://66.118.37.29/` = 301 -> `https://66.118.37.29/`;
`https://66.118.37.29/` = 200 and its body title is **Easypanel** (cert `CN=Easypanel`, self-issued).

Caveat (law 6 / 14, host03 defect `defect-host03-easypanel-console-world-reachable-2026-08-12`): **both vantages
are inside 66.118.36.0/22 with host04**. They prove "no host firewall exists" and, after the guard, "the host refuses
a non-admin source". They do NOT prove the public internet can reach these ports. Host04's own record (2026-10-11
22:18Z) says the workstation probe saw 3000 open; an off-net confirmation is an owner/vantage step
(`20-host04-verify-external.ps1` prints the 30-second phone command).

### New finding not in the earlier record: the console is ALSO served on the bare IP over 443

`https://66.118.37.29/` returns the EasyPanel UI through Traefik (this is EasyPanel's "serve on IP" behaviour; the
API field is `serveOnIp` of `setPanelDomain`). So **closing tcp/3000 alone does NOT close the admin surface** - the
login page stays public on 80/443 until `serveOnIp` is switched off (see `30-easypanel-https-admin.md`). The same
panel is reachable on a hostname only after a panel domain is set.

## 3. What the proposed guard changes (and does not)

See `10-host04-firewall-owner-run.sh`. In one line: a separate nftables table `inet host04_guard` (priority -10)
that drops from `ens160` only: 22 and 3000 for non-admin sources, 2377/7946/4789 for everyone (standalone), and
optionally 80/443 (switch). Proof of semantics: `15-host04-firewall-netns-selftest.sh`, 33/33 on 2026-10-11
(namespaces, a Docker-style DNAT, fixture control OPEN before, sabotage control, established-SSH survival,
counters > 0). The ruleset also passes `nft -c` (dry run) on host04 itself in both `public` and `restricted`
modes. NOT yet tested: IPv6 inside the namespace harness (rules are the mirror of the v4 input rules) - the After
verification includes the deepseek IPv6 probes for that reason.

## 4. Other findings for the owner (not changed)

1. `PasswordAuthentication yes` with public sshd: after the guard 22 is admin-only, which neutralises the scan
   exposure; flipping to key-only is a one-line sshd change the owner can add (deliberately not bundled).
2. Two default routes at the same metric: return-path asymmetry risk after reboot (precedent
   `project_deepseek_dual_homed_asymmetric_return_path_2026-09-11`). The guard keys on the *ingress interface* and
   only drops, so asymmetry cannot lock anything in; but if ens192 ever carries the public default, the
   `PUB_IF` parameter must be updated.
3. No `daemon.json`: Docker's default `json-file` log driver has no size cap. Recommend
   `{"log-driver":"json-file","log-opts":{"max-size":"10m","max-file":"3"}}` (applies to new containers; needs a
   dockerd restart = owner-run, not part of this guard).
