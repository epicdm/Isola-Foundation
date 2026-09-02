# Lane 2 contract pack — v1

Foundation publishes these. Lane 2 implements against them.

**The boundary in one line:** Foundation supplies business context and executes governed
actions; Lane 2 runs the message and the agent turn.

## Contracts

| file | direction | meaning |
|---|---|---|
| `events.ingest.schema.json` | Lane 2 → Foundation | Report what happened. One way. |
| `provisioning.channel.request.schema.json` | Foundation → Lane 2 | Please configure this channel. |
| `provisioning.channel.result.schema.json` | Lane 2 → Foundation | Here is what exists now. |
| `health.schema.json` | Lane 2 → Foundation | Channel/agent health, carried as an event. |
| `error.schema.json` | both | Rejection shape. |

## Rules that are not negotiable

1. **Provider-safe identifiers only.** Foundation refuses tokens, keys, bearer headers, JWTs
   and anything over 200 characters — and refuses the **whole** message rather than redacting.
   A partially-redacted secret is still a secret.
2. **Lane 2 does not classify.** `customer_facing` vs `internal_private` is a business
   decision made by a person in Foundation. Echo it unchanged or omit it.
3. **Ingestion cannot steer.** Posting an event returns a receipt. There is no reply, resend,
   retry or ownership command on that endpoint, by construction.
4. **Order by occurrence.** Foundation folds ownership and health by `occurredAt`, so
   out-of-order delivery is safe. Send the real time it happened.
5. **Idempotency is yours to honour.** `idempotencyKey` on provisioning, `dedupeKey` on
   events. Foundation dedups its own read model; it does not dedup your transport.

## Running the contract tests

Fixtures are executed against Foundation's real validators, not against a schema copy:

```
npx vitest run lib/contracts
```

Fixture keys beginning `_` are test metadata (`_expectedRejection`,
`_existingClassification`) and are not part of the wire contract.

## Not in this pack, deliberately

`send-a-message`, provider transport, AgentBot processing and Clawith session execution are
Lane 2's, and Foundation publishes no schema for them. If Foundation ever needs one, the
boundary has moved and that is a decision, not an implementation detail.
