# Gateway binding control path — the substrate that is missing

**Packet 5B, 2026-08-20. Read-only investigation. NO CODE WAS CHANGED, and this
document explains why that is the correct outcome rather than an incomplete one.**

---

## 1. The mandatory security fix was already implemented

Packet 5B required that `GET /v1/bindings` never return `agentBotSecret`,
`agentBotAccessToken`, authorization headers, token-bearing URLs or equivalent
material under another name.

**It already does not.** `src/bindings.ts` exports `redactBinding`, and
`src/app.ts` is the only route that serialises bindings:

```
app.ts:928   bindings: bindingStore.list().map(redactBinding)
bindings.ts  agentBotSecret: "[redacted]",
             agentBotAccessToken: "[redacted]",
             agentBotSecretConfigured: binding.agentBotSecret.length > 0,
             agentBotAccessTokenConfigured: binding.agentBotAccessToken.length > 0,
```

`chatwootBaseUrl` is omitted from the audit view **entirely**, so the
token-bearing-URL case has no route to the response either.

Three other call sites use `bindingStore.list()` without redaction. All three
were checked and none serialises:

| site | use | serialises? |
|---|---|---|
| `app.ts:542` | `decideDelivery` — needs the HMAC key to verify the signature | no |
| `app.ts:615` | `resolveBinding` — internal lookup | no |
| `app.ts:867` | `/healthz` — emits `total` / `active` / `retired` counts only | no |

### The regression tests the packet asked for already exist

- `test/admin.test.ts:82-83` — scans the **raw response text** of
  `GET /v1/bindings` for both sentinels, not merely the field value.
- `test/admin.test.ts:38-41` — same scan on `/healthz`, plus the internal
  hostname.
- `test/no-content-logged.test.ts` — drives a **successful and a failed**
  delivery and scans every emitted log line for `BOT_SECRET`,
  `BOT_ACCESS_TOKEN`, `RUNTIME_SECRET` and `ADMIN_TOKEN`.
- `test/ledger-no-content.test.ts` — proves the ledger schema **declares no
  column** that could hold such material. A structural proof, which is stronger
  than scanning rows.
- `test/binding-audit-view.test.ts` — asserts the audit view exposes *enough*
  to be auditable and *not more*, in the same file, "because either one alone
  is a defect".

**Correction owed.** Packet 5A reported that `/v1/bindings` "returns
`agentBotSecret` and `agentBotAccessToken` in plaintext". That was wrong. The
read printed **field names only**; the fields are present carrying the literal
string `[redacted]`. No secret value was ever seen. This is §2.27(a) — *a
field's name is a claim; its write-site is the truth* — committed by the lane
that had just cited it.

---

## 2. The registry seam already exists

Packet 5B asked for an abstraction separating boot bindings, dynamic metadata
and credential resolution. The first half is already there:

```ts
export interface BindingStore { list(): readonly Binding[]; }
export class StaticBindingStore implements BindingStore { /* Object.freeze */ }
```

A dynamic store is a **second implementation of an interface that already
exists**. Introducing a parallel abstraction would duplicate it, so none was
added.

---

## 3. The substrate that is actually missing

A dynamic binding must reference credential material without holding it. The
gateway has **no in-code secret-reference facility**. `grep -rn "_FILE" src/`
returns nothing.

The only mechanism on this estate is `entrypoint.sh`, and it runs **once, at
container start**:

```sh
eval "export ${name}=\"\$(cat \"\$secret_path\")\""
unset "${name}_FILE"
```

It reads each `*_FILE` into the environment, then deliberately unsets the path
so a later reader cannot believe the value is still retrievable from disk.

### Why that closes the door on Phase D

1. Docker secrets are mounted read-only and are **immutable for the life of the
   task**. A new secret cannot appear without a service update.
2. A service update is a **restart** — forbidden by this packet, and the very
   cost the dynamic path exists to avoid.
3. Letting the API name a filesystem path is explicitly forbidden (traversal).
4. So a dynamic binding could only reference a secret **already mounted at
   boot** — which means a deploy happened anyway.

**Therefore: binding METADATA can be dynamic. The CREDENTIAL cannot.** And a
dynamic binding whose credential still requires a deploy delivers nothing,
because if you are deploying you can edit the boot configuration instead. This
is the whole finding, and it is why implementing Phase D now would produce a
control path that looks complete and cannot be used.

Building a credential table or a reversible encryption scheme to close this gap
was explicitly rejected by the packet, and rightly: it would put a decryptable
copy of every live bot credential in a database to save a deploy.

---

## 4. The decision this needs

Dynamic bindings require dynamic **credential provisioning**. Three routes, none
executed, none cheap enough to pick without a ruling:

- **(a) A secret manager the gateway can read at runtime** — the only route that
  makes a dynamic binding genuinely dynamic. Largest change; introduces a new
  runtime dependency on the customer-traffic path, so its failure mode has to be
  designed before its happy path.
- **(b) Accept that credentials are deploy-time and make BINDINGS deploy-time
  too** — no new substrate; the control path becomes a reviewed configuration
  change with tests, which is close to what exists today. Honest, and cheapest.
- **(c) Split the two** — dynamic metadata (status, lifecycle, labels,
  escalation team) in Postgres, credentials remaining boot-mounted. Delivers
  most of the operational value: enable/disable, retire, relabel and re-route an
  existing binding **without a deploy**, while creating a genuinely new binding
  still needs one.

**(c) is the recommendation.** It matches the substrate that already exists —
the gateway already has durable Postgres persistence via the ownership store —
and it makes the common operations dynamic without putting a single credential
in a database.

---

## 5. What was NOT done, deliberately

- No change to `redactBinding` — it is correct.
- No new registry abstraction — `BindingStore` already is one.
- No dynamic binding write path — its precondition fails.
- No credential store, no encryption scheme.
- No production, Docker, secret, Chatwoot or binding mutation of any kind.
