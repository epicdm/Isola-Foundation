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
