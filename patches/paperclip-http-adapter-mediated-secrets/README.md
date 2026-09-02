# Paperclip HTTP adapter — mediated secret references in headers

**Upstream base, pinned and unchanged: `ghcr.io/paperclipai/paperclip:sha-8af38fb`.**

This is an **overlay**, not a fork. Two files are replaced in a derived image; every
other byte of the pinned upstream release is untouched, and the deepseek Paperclip
copy is not modified or retired.

## Why

A planted-canary redaction control on 2026-08-24 proved that a literal value in
`adapterConfig.headers` is returned **in plaintext** from:

- `GET /api/agents/{id}`
- `GET /api/companies/{id}/agents`

with three controls confirming the reading (a non-secret marker from the same object
was found in those same responses; grep provably finds the canary in a known-positive
string; the log window provably covered the agent). Filed as
`def-paperclip-http-adapter-header-secret-exposed-via-api-2026-08-24`.

Storing an upstream bearer there hands it to any actor with configuration-read
permission — including, per Isola Runtime's own `auth.js`, **the agent itself**, which
can read and PATCH its own `adapterConfig`.

## What changed

Paperclip already had the right mechanism; this adapter simply could not reach it.
`secretService.resolveAdapterConfigForRuntime` resolves `adapterConfig.env` bindings
(`{type:"secret", secretId, version}`) into plaintext **at execution time only** and
emits an audit manifest. The execution path already does this:

```
resolveExecutionRunAdapterConfig → resolvedConfig → runtimeConfig
  → adapter.execute({ config: runtimeConfig })          (heartbeat.ts:7659)
```

So `config.env` already holds resolved values when the adapter runs, and
`context.paperclipSecrets = { manifest }` already carries the audit trail. **No new
resolution machinery and no new audit plumbing were added.**

A header value may now be either:

| Form | Behaviour |
|---|---|
| `"literal-string"` | used verbatim — unchanged for every existing agent |
| `{"$env": "NAME"}` | replaced by `config.env.NAME` (mediated, resolved at execution time) |

The stored configuration therefore contains only the **name**. The secret lives in
`company_secrets`, encrypted and provider-backed, and no API surface can return it.

## Deliberate non-goals

- **`process.env` is never a source.** Only the mediated, already-resolved `config.env`.
  A host-process reference would reintroduce an unaudited credential path, which is
  the entire point of not having one. Proven by planting a real `process.env` variable
  and asserting the adapter refuses it.
- **No second secret store.** It reuses the existing one.
- **No resolved value in errors, logs, audit, API responses, run records or config.**
  Failures name the header and the env **key**, never the value.
- **Nothing lazy.** Headers resolve *before* the request is built, so a missing or
  malformed reference fails closed with **no outbound call at all**.
- Scope is the HTTP adapter only.

## Ambiguity is refused, not resolved

`{"$env":"A","value":"b"}` has two plausible readings. Picking one silently is exactly
the kind of guess that puts the wrong credential on the wire, so it throws. Same for
nested references, arrays, numbers, `null`, an empty name, and a mis-spelled key.

## Proof

`adapter-security.test.mjs` — 25 assertions, runnable with no Paperclip dependency:

```bash
node adapter-security.test.mjs      # expects: 25 passed, 0 failed
```

It covers literal passthrough, mediated resolution, the `process.env` refusal, every
malformed shape, absence of the value from error text, non-mutation of config, the
upstream receiving the correct header, and — the one that matters most — that a bad
reference produces **zero** outbound requests. It ends with a control asserting the
canary is findable in a string that contains it, so the absence checks are not vacuous.

`utils-stub.js` stands in for `@paperclipai/adapter-utils` so the pure logic can be
proven without the Paperclip tree; it is **test scaffolding and is not shipped**.

## Files

| File | Deployed path in the derived image |
|---|---|
| `execute.ts` | `/app/server/src/adapters/http/execute.ts` (provenance/review) |
| `execute.js` | `/app/server/dist/adapters/http/execute.js` (**the artifact that runs**) |

Both are kept semantically identical. The `dist` file is what executes; the `src` file
is overlaid so the shipped source matches the running behaviour rather than silently
diverging.

## What this does NOT close

`def-paperclip-http-adapter-header-secret-exposed-via-api-2026-08-24` stays **open**.
This change provides a *safe alternative*; it does not remove the unsafe literal path,
and `GET /api/agents/{id}` still returns whatever literal a caller stores there. That
path needs its own verified disposition.
