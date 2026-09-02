# Gateway binding control path — the substrate that is missing

**Packet 5B, 2026-08-20 — read-only investigation, no code changed.**
**Packet 5C, 2026-08-20 — the additive overlay implemented; see §6.**

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

---

# 6. The additive boot-time overlay — implemented, Packet 5C, 2026-08-20

## 6.1 Why bindings stay deploy-time during commissioning

§3 above establishes that a dynamic binding's *credential* cannot be dynamic
with today's substrate. The PM ruled accordingly: **bindings and credentials
remain deploy-time for Foundation Commissioning.** The overlay does not change
that. What it changes is the *blast radius of adding one*.

Before: adding a fifth binding meant re-minting the single secret that carries
the credentials of all four live bindings — including the 6737 front desk. That
operation was refused, and the refusal ratified, on 2026-08-18.

After: a new binding arrives as its own manifest entry plus its own secret
files. **The live bundle is never reopened.**

## 6.2 Base bundle versus additive overlay

| | base bundle | overlay |
|---|---|---|
| variable | `GATEWAY_BINDINGS_JSON` (`_FILE` supported) | `GATEWAY_BINDINGS_OVERLAY_JSON` (`_FILE` supported) |
| required | no — absent means zero bindings, boot succeeds, every webhook fails closed | no — absent means the overlay does not exist |
| carries credentials | yes, inline | **never** — references only |
| may replace a binding | n/a | **no, and the attempt refuses startup** |

The four current bindings **do not need converting**. The overlay is additive,
not a migration, and with no overlay configured the parse is byte-for-byte the
previous behaviour — proven by the 583 pre-existing tests continuing to pass
unchanged.

## 6.3 Secret-reference format

An overlay record is an ordinary binding with the two credential fields removed
and replaced by:

```json
{ "agentBotSecretRef": "canary-a", "agentBotAccessTokenRef": "canary-a.token" }
```

A reference is a **logical identifier**: `[A-Za-z0-9_.-]{1,64}`, and `..` is
refused explicitly. It is *not* a path, and no value from the manifest ever
reaches a filesystem call.

## 6.4 The fixed secret root, and one deliberate deviation — FOR PM REVIEW

Packet 5C specified that the application read the referenced secret files
directly from a fixed root. **It does not, and this is the one place the
implementation departs from the dispatch.**

`src/app.ts` advertises *"no filesystem access at all (nothing imports
node:fs)"*, and `test/no-direct-network.test.ts` **enforces it** — one of a
table of forbidden primitives alongside `child_process`, `vm`, `worker_threads`
and MCP clients. `entrypoint.sh` exists precisely so a deployment concern never
buys its convenience with that guarantee.

So the credential still arrives as its own secret file under the deployment's
fixed root, and `entrypoint.sh` materialises it by the convention that already
governs every other secret in this service:

```
GATEWAY_BINDING_SECRET_CANARY_A_FILE=/run/secrets/<name>
  ->  GATEWAY_BINDING_SECRET_CANARY_A=<contents>
```

`canary-a` → `GATEWAY_BINDING_SECRET_CANARY_A` (uppercased; `.` and `-` become
`_`).

This satisfies every security requirement the packet listed, and satisfies two
of them **more strictly than the specified design would have**:

- *"must not become a way to select arbitrary host files"* — it cannot select
  any file at all. There is no file selection in the application.
- *"validate the resolved location remains inside the root"* — there is no
  resolved location to validate. **Traversal is impossible by construction
  rather than by validation**, and a validation that never has to run is worth
  more than one that does.

The trade: a credential referenced this way sits in the process environment.
That is **the existing, ratified posture** — `GATEWAY_BINDINGS_JSON` already
carries all four live credentials the same way — so this is not a regression.
If the PM still prefers a direct file read, only the resolver changes:
`envSecretResolver` is a one-function seam behind the `SecretResolver` type, and
the manifest contract above would not change at all.

## 6.5 Startup merge order

1. Parse and validate the base bundle **exactly as before** — unchanged code.
2. Parse the overlay: reject inline credentials, validate every reference,
   resolve each one, strip only a terminal newline.
3. Validate overlay records against the **same** `parseBindings` schema, so an
   overlay binding can never be laxer than a boot binding.
4. Merge, **boot bindings first**.
5. Hand the combined, frozen list to the same `StaticBindingStore`.

## 6.6 Collision policy

An overlay record refuses startup if it collides with a boot binding — or with
another overlay record — on either key:

- `tenantId`, the binding identifier;
- `(chatwootAccountId, chatwootInboxId)`, the routing key.

**The overlay may add a binding. It may never replace one.** A mechanism that
could silently substitute the live front desk's credentials would be a
different and far more dangerous mechanism than the one this packet was asked
for.

## 6.7 Failure behaviour

Every overlay problem is a **boot refusal**, never a skipped binding: a missing
reference, an unconfigured secret, a blank secret, an oversized secret, an
invalid reference, an inline credential, a collision, or any schema violation.
`server.ts` already exits non-zero on `!config.bindings.ok`, so this inherits
the existing gate with no change.

A binding that silently vanished because its secret was missing would look
identical to a binding nobody configured, and the operator would debug the
wrong thing.

Error strings name the **field, the index and the variable to set** — never a
value. Tests assert that no refusal quotes the credential it refused.

## 6.8 What deployment will later require

Not performed here; no deploy is authorised by this packet.

- one secret file per credential, mounted under the deployment's fixed root;
- `GATEWAY_BINDING_SECRET_<REF>_FILE` per credential;
- `GATEWAY_BINDINGS_OVERLAY_JSON` (or its `_FILE`) carrying the manifest, which
  is **not** secret material and may be reviewed in the open;
- **the existing live binding secret is not touched.**

No real secret name or value appears in this document, deliberately.

## 6.9 Rollback

Code-only, and independently reversible. Reverting the commit removes the
overlay parse and restores `bindings: parseBindings(...)`. Operationally the
overlay is inert until `GATEWAY_BINDINGS_OVERLAY_JSON` is set, so **unsetting
one variable is a complete rollback** with no code change at all.

## 6.10 There is still no runtime binding API

`GET /v1/bindings` remains **GET-only**; every write verb still answers 405.
The overlay is read once at startup. There is no hot reload, no CRUD endpoint,
no second writable store and no Postgres binding metadata. Adding a binding is
still a deploy — it is simply no longer a deploy that reopens the live bundle.
