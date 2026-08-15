# isola-sentinel

Tells a human when the estate stops answering.

```
deploy:  sudo docker stack deploy -c /opt/isola/isola-sentinel-stack.yml isolasentinel
service: isolasentinel_sentinel
logs:    sudo docker service logs isolasentinel_sentinel
alerts:  email via SMTP2GO -> SENTINEL_ALERT_TO
```

## Why it does not lead with "is the container up"

The customer line has died twice — **eleven hours, then twenty-four** — and both times
it was found by someone looking at something else. `docker service ls` said `1/1` for
every minute of both outages. Container liveness was TRUE the whole time and told
nobody anything.

So the first-class signal is the one that was actually missing:

> **A delivery was accepted and no reply was posted within N seconds.**

It is a SQL question about `delivery_ledger`, which the gateway already writes on the
reply path — durable and authoritative, not inferred from logs. A delivery is
`reserved` when the gateway accepts a webhook and `completed` once Chatwoot has the
reply. Anything sitting between those past `SENTINEL_STUCK_DELIVERY_MS` is a customer
who spoke and heard nothing, whatever else is green.

It also covers the other silent failure: **expected output absent**. The receivables
agent fires 11:00 UTC on weekdays; if its issue is not in Paperclip after the grace
window, that absence is the alert. A scheduled job that dies quietly is
indistinguishable from one that succeeded unless something looks for the artefact.

## Checks

| key | meaning |
|---|---|
| `stuck_delivery` | accepted delivery with no reply posted (**the priority signal**) |
| `ledger_unreachable` | cannot read `delivery_ledger` — treated as **blind, not healthy** |
| `ar_run_missing` | the receivables action list was not published today |
| `down_<name>` | an HTTP target did not answer, or answered non-2xx |

Alerts fire on transition, re-send at most every `SENTINEL_RENOTIFY_MS`, and send a
`RECOVERED` notice when the condition clears. State lives on a volume so a restart
does not re-announce everything.

## Targets not yet covered — deliberately

`isola-portal`, `fiserv-api` and Odoo reachability are **not** configured yet. Their
endpoints were not reachable from `easypanel-isola` when verified: `portal.epic.dm`
does not resolve (curl 000), `isola-portal.saas00.epic.dm` returns 404 on every health
path tried, and the portal services expose no published port and did not answer on
their service names.

They are omitted on purpose. **A check that can never pass is worse than no check** —
it trains the reader to ignore the mail, and then a real alert arrives into a habit of
ignoring. Add each one only once a healthy response has actually been observed.

### What each one needs to become checkable

This is a handover, not a to-do for this service. **Do not build a health endpoint
inside someone else's service** — the owning lane provides the endpoint; the sentinel
adds the check once it answers.

| target | measured 2026-08-15 | what it needs |
|---|---|---|
| **isola-portal (web + api)** | `portal.epic.dm` does not resolve (curl exit, HTTP 000). `isola-portal.saas00.epic.dm` answers but returns **404** on `/`, `/api/`, `/healthz`, `/api/health/`. The Swarm services publish **no port** (`.Endpoint.Ports` empty) and did not answer on `isola_isola-portal-api:8000/3000` or `isola_isola-portal-web:3000/80` from `easypanel-isola`. | **One** of: (a) an unauthenticated health path that returns 2xx on the existing public hostname — say `GET /api/health/` on `isola-portal.saas00.epic.dm`; or (b) a resolvable in-cluster name + port the sentinel can reach. Then add `portal=<url>` to `SENTINEL_HTTP_TARGETS`. |
| **fiserv-api** | Not on `easypanel-isola`; there is a separate `easypanel-fiserv` network. Not reachable from where the sentinel runs. | Either attach the sentinel to `easypanel-fiserv` (one line in the stack) **or** a public health URL. Needs a decision on which, since joining another network widens the sentinel's reach. |
| **Odoo reach** | Not attempted from host03. The ledger of record is the SaaS at `epic-communications-inc.odoo.com`. | An unauthenticated liveness probe. `POST /jsonrpc {service:"common",method:"version"}` needs no auth and is the cheapest honest check; confirm it is acceptable to poll a SaaS endpoint on a schedule before adding it. |

**Why this matters beyond monitoring:** the portal's health cannot currently be
checked from anywhere except Docker or the EasyPanel console. It was deployed without
any external way to tell whether it came up.

## Delivery

SMTP, **not** the SMTP2GO HTTP API. The value stored as `SMTP2GO_API_KEY` on this
estate is a 12-character SMTP password; the HTTP API rejects it outright
(`"wasn't in the correct format 'api-[A-Za-z0-9]{32}'"`). That was discovered by
sending a real alert and reading the 403 — which is exactly why an alert channel must
be fired on purpose before it is believed.

The sender must be the authenticated address (`bff@epic.dm`) or SMTP2GO refuses it.

## Firing it on purpose

A monitor nobody has fired is a monitor that reports success. To exercise the priority
signal end to end without touching customer traffic, inject one synthetic stalled
delivery and then remove it:

```sql
-- tenant_id makes it unmistakable; lease_expires_at far in the future keeps the
-- gateway's recovery sweeper from adopting it.
INSERT INTO delivery_ledger (tenant_id, binding_id, chatwoot_account_id,
  chatwoot_inbox_id, event_id, action_type, payload_digest, delivery_ref,
  correlation_id, delivery_state, conversation_id, attempts, lease_owner,
  lease_expires_at, created_at, updated_at)
VALUES ('sentinel-selftest','selftest',0,0,'selftest-1','delivery','selftest',
  'selftest-ref','selftest-corr','reserved',999999,0,'sentinel-selftest',
  now() + interval '1 day', now() - interval '10 minutes', now() - interval '10 minutes');

-- afterwards
DELETE FROM delivery_ledger WHERE tenant_id='sentinel-selftest';
```

Verified 2026-08-15: alert delivered (`accepted: 1`), then `RECOVERED` delivered after
the row was removed.
