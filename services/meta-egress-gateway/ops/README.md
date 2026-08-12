# Host-level operational artefacts (host03)

These files run the Meta egress boundary and, until this commit, **existed only
on host03 with no copy in any repository**. A host rebuild would have removed
them silently: the verifier would simply stop running, and nothing would say so.

They are captured here verbatim from the live host at 2026-08-12T22:00Z.

## Deployed locations

| Repo path | Deployed to | Mode |
|---|---|---|
| `meta-egress-enforce.sh` | `/usr/local/sbin/meta-egress-enforce.sh` | `0755` |
| `meta-topology-verify.sh` | `/usr/local/sbin/meta-topology-verify.sh` | `0755` |
| `systemd/meta-egress-enforce.service` | `/etc/systemd/system/` | `0644` |
| `systemd/meta-egress-enforce.timer` | `/etc/systemd/system/` | `0644` |
| `systemd/meta-topology-verify.service` | `/etc/systemd/system/` | `0644` |
| `systemd/meta-topology-verify.timer` | `/etc/systemd/system/` | `0644` |
| `etc/protected-services.conf` | `/etc/meta-egress/` | `0644` |
| `etc/credential-free-services.conf` | `/etc/meta-egress/` | `0644` |
| `etc/retired-services.conf` | `/etc/meta-egress/` | `0644` |

Reinstall: copy to the paths above, `systemctl daemon-reload`, then
`systemctl enable --now meta-egress-enforce.timer meta-topology-verify.timer`.

## What these are NOT

They are **not** the boundary. The boundary is structural: Docker `--internal`
networks, which have no external path at all and survive the loss of every file
here. `meta-egress-enforce.sh` maintains a supplementary `DOCKER-USER` rule set;
`meta-topology-verify.sh` is the gate that decides whether a service is confined.

Losing these files loses *detection*, not *isolation*.

## Known defect, not fixed

`meta-topology-verify.sh` counts running tasks with
`docker ps --filter "name=$SVC"`, which Docker matches by **substring**. For
`isola_chat` this returns containers from four distinct services
(`isola_chat`, `isola_chatwoot-sidekiq`, `isola_chatwoot-db`,
`isola_chatwoot-redis`), producing a false "4 running tasks but 1 desired"
failure.

The fix is to match `^${SVC}\.[0-9]+\.` against `{{.Names}}` at both call sites.
It is diagnosed but deliberately **not applied**, because the instruction under
which this commit was made was status-and-park only.

This defect caused an incorrect claim of reboot-churn orphans in two earlier
Port records; both are corrected in
`bt-autonomous-meta-6737-cutover-2026-08-12`.

## Not captured here, by design

The Swarm secret `meta_gateway_v2` and the workload tokens under
`/root/.meta-gateway/` are credentials and are deliberately absent. Only their
non-secret identities appear in Port.
