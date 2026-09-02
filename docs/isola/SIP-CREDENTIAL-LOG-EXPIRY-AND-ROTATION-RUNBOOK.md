# Log expiry (b) and `ep_308a3e75fad8` rotation — one reviewed pair

**Status:** PREPARED, NOT EXECUTED. Neither procedure is authorized by this document.
**Date:** 2026-08-12
**Defect:** `defect-emapro-acrobits-credential-surfaces-2026-08-12` (P0)
**Related:** `defect-host03-easypanel-console-world-reachable-2026-08-12` (provisional P1)

> These are presented together because they interact. Running the rotation before the
> URL fix is self-defeating — the handset re-provisions roughly every 40 minutes, so a
> new password lands in Traefik and Loki within one cycle. Running the expiry before the
> URL fix is equally pointless: the log refills.

## The only correct order

```
1. Owner fixes the Acrobits genericBrowserUrl        ← stops the credential leaving the handset
2. Confirm accumulation has stopped                   ← two poll cycles, ~80 minutes, measured not assumed
3. (b) expire the retained logs                       ← removes what is already written
4. Rotate ep_308a3e75fad8                             ← last, with the holder present
```

Nothing before step 1 removes the exposure; it only removes evidence of it.

---

# Part (b) — expiring the retained logs

## Exactly what is destroyed

Measured on host03, 2026-08-12:

| Store | Content | Window | Size |
|---|---|---|---|
| Traefik container log `3c17a7ac…-json.log` | **10,243 access lines**, all host03 HTTP ingress | `11:07:12Z` → `20:58:38Z` **today only** | 2.6 MB |
| Loki `loki-data` | all service + ingress streams | retention **168h / 7 days** | 14 MB total |

**The Traefik log covers ~9.9 hours, not weeks** — it begins at the container's start on
this morning's host reboot. So the cost of clearing it is one day's ingress history:
route, status, latency and client IP for every service on host03 for today. That is real
evidence loss, and it is the reason this is not pre-authorized — but it is bounded, and
it is not the multi-week corpus the phrase "expire the logs" might suggest.

## Meta-lane dependency check — **clean**

The owner asked specifically whether this touches anything the Meta confinement lane
depends on, given that lane is mid-flight and holding an undelivered workload token.

**Measured: `meta-egress` access lines in the Traefik log = 0.**

The Meta lane's confinement gate inspects **live** state — service tasks, desired vs
running replicas, network attachment, egress reachability from each task, and the
absence of credential-shaped env keys. It does not read Traefik ingress history. The
`meta-egress-*` services are not publicly routed through Traefik at all, which is why
they appear zero times.

**Conclusion: expiring the Traefik container log destroys no Meta-lane evidence.** The
Loki step below is scoped and does not touch `meta-egress` streams either.

## Procedure

### b.0 — Precondition

Do not start until step 1 and 2 of the order above are complete and accumulation is
confirmed stopped. Expiring a log that is still filling is theatre.

### b.1 — Record what is about to be lost

```bash
TR=$(sudo docker ps -q -f name=easypanel-traefik | head -1)
LOG=$(sudo docker inspect "$TR" --format '{{.LogPath}}')
sudo cp "$LOG" /root/traefik-preexpiry-$(date -u +%Y%m%dT%H%M%SZ).json.log
sudo chmod 600 /root/traefik-preexpiry-*.json.log
```

> **This copy contains the credential.** It exists so the deletion is reversible during
> the change window, and it must be removed at b.5. Root-only, never moved off-host,
> never attached to Port or a ticket.

### b.2 — Clear the container log **without restarting Traefik**

```bash
sudo truncate -s 0 "$LOG"
```

Zeroing the json log file frees the space and empties `docker logs` while the container
keeps writing to the same inode. **No restart, no ingress interruption** — which is what
makes this safe on a shared ingress, unlike the withdrawn mitigation (a).

Verify:

```bash
sudo docker logs "$TR" 2>&1 | grep -ac 'password=' || echo 0    # expect 0
sudo docker logs "$TR" 2>&1 | grep -ac 'HTTP/'                  # expect a small, growing number
curl -s -o /dev/null -w '%{http_code}\n' https://api01.epic.dm/health   # expect 200 — ingress unaffected
```

### b.3 — Delete the matching Loki lines, scoped

Loki's compactor is configured with `retention_enabled: true`, `retention_period: 168h`
and `delete_request_store: filesystem`, so **the delete API is available** and this can
be scoped to one stream and one line matcher rather than removing chunk files.

Submit a delete request restricted to the ingress stream and to lines containing the
leaked parameter — not to a whole service, and not to a whole day:

```
POST /loki/api/v1/delete
  query = {container="easypanel-traefik"} |= "/home/" |= "password="
  start = 2026-08-12T11:00:00Z
  end   = <the timestamp accumulation stopped>
```

Then confirm zero remain:

```
GET /loki/api/v1/query_range
  query = {container="easypanel-traefik"} |= "password="
```

Expect an empty result. If the delete API is unavailable on this build, **stop and
report** — do not fall back to removing files under `loki-data`, which would take
unrelated services' logs with it.

### b.4 — Prove it is gone from both stores

Re-run the original audit shape. Counts only; never print a matching line.

```bash
sudo docker logs "$TR" 2>&1 | grep -acE '[?&]password='     # expect 0
```

Plus the Loki `query_range` above returning empty.

### b.5 — Remove the b.1 safety copy

```bash
sudo shred -u /root/traefik-preexpiry-*.json.log
```

Leaving it defeats the entire exercise.

## Rollback

Between b.1 and b.5 the safety copy is the rollback: restore it if the change window is
abandoned. After b.5 there is no rollback, which is correct — the point is that the
credential is gone. Rollback is therefore a **decision to be made before b.5**, not a
recovery step afterwards.

## What this does not fix

Nothing. It removes recorded copies. If the URL fix has not landed, the log refills on
the next poll and the whole procedure must be repeated.

---

# Part 2 — rotating `ep_308a3e75fad8`

## The constraint that shapes this

`ep_308a3e75fad8` is **one of the four protected registrations** and is **actively
registered**. Rotation deliberately breaks a working phone. Someone has to be holding it.

Standing rule from the containment work applies unchanged: **no credential rotation while
new activation is unavailable, unless that specific device has an approved manual
recovery plan.** This runbook is that plan for this one device.

## Preconditions — all four, no exceptions

| # | Precondition |
|---|---|
| P-1 | The Acrobits `genericBrowserUrl` fix has landed and accumulation is confirmed stopped over two poll cycles |
| P-2 | Part (b) is complete — old copies removed, or the new password lands beside the old one |
| P-3 | The device holder is **physically present and reachable** for the whole window |
| P-4 | Owner authorization naming this specific account and accepting the de-registration |

## Expected interruption

| Phase | Duration | State |
|---|---|---|
| Secret changed in Magnus | instant | device still registered on the old credential until its next re-REGISTER |
| Device de-registers | **up to one SIP registration interval** | **inbound calls fail; outbound fails** |
| Device reconfigured | manual, minutes | holder-dependent |
| Re-registered | — | service restored |

**Calls in progress are not dropped** by a secret change; the break appears at the next
registration refresh. Do not schedule this during a period the holder needs the line.

## Procedure

### r.1 — Capture the before-state

```bash
ssh voice00 'sudo asterisk -rx "sip show peers"' | grep -E '^ep_308'
```

Record: registered yes/no, contact IP, latency. Also confirm the other three protected
registrations are present, so any collateral change is attributable.

### r.2 — Rotate in Magnus

Use the governed path — `enforceSipSecret()` against the SIP account — not a direct
database edit. One account only. Never print the new secret; never paste it into Port, a
ticket, chat, or a log.

### r.3 — Confirm de-registration

Poll `sip show peers` until `ep_308…` drops to unregistered. This confirms the rotation
took effect rather than assuming it did.

### r.4 — Reconfigure the handset

With the holder:

1. Open Cloud Softphone on the device.
2. Re-enter the SIP password for the existing account. **Do not** re-run activation —
   self-service activation is held, and the `csc:`/`/home/` paths are exactly what is
   being remediated.
3. The credential must be conveyed to the holder **out of band** — spoken, or through an
   already-approved channel. Never by a link, a QR, or anything that puts it in a URL.

> If the device cannot be reconfigured manually and only a provisioning link would work,
> **stop**. That is the case the secure activation flow exists for, and it is not ready.
> Restore service by rotating the secret back rather than stranding the holder.

### r.5 — Prove service restored

```bash
ssh voice00 'sudo asterisk -rx "sip show peers"' | grep -E '^ep_308'   # expect OK (…ms)
```

Then one real outbound and one real inbound call, each traced to a CDR — registration
alone is not proof that calling works.

### r.6 — Confirm no collateral damage

The other three protected registrations unchanged; Magnus object counts unchanged
(baseline **801** SIP accounts / **482** DIDs / **51** enabled trunks).

## Rollback

Rotate the secret **back** to the previous value and let the device re-register. This
requires the previous value to be known at r.2 — so **capture it before rotating**, hold
it root-only for the window, and remove it once r.5 passes. That is the only rollback,
and it is why the holder must be present: without them, a failed r.4 leaves a working
phone broken with no path back.

## What this does not cover

The **configured blast radius is still unknown**. If `genericBrowserUrl` lives in the
shared Acrobits profile rather than this handset's settings, other accounts are
configured to leak and will begin on their next poll. Rotating one account does not
address that. The real rotation scope comes from the Acrobits profile, which is
owner-only — see the defect.

---

## Severity decay path — recorded so nobody re-derives it

| Severity | Condition |
|---|---|
| **P0** | now — live, ongoing accumulation on a protected, actively-registered account |
| **P1** | once the Acrobits URL fix lands and accumulation is confirmed stopped |
| **P2** | once the retained Traefik and Loki copies are expired per Part (b) |
| Closed | once `ep_308a3e75fad8` is rotated and the configured blast radius is established as nil or fully rotated |
