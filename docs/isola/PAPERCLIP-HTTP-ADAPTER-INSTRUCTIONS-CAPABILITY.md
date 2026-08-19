# Paperclip `http` adapter — instructions-bundle capability

**Scoped 2026-08-19. NOT BUILT, deliberately. Ruling: upstream request first, by itself.**

---

## The problem, in one line

Paperclip's console refuses to edit an agent's instructions bundle when the agent runs on
the `http` adapter — *"Instructions bundles are only available for local adapters"* — so the
owner cannot edit his own agents' charters in the UI. **The API supports it fully.**

## What is actually true, measured against `ghcr.io/paperclipai/paperclip:sha-8af38fb`

| Claim | Status |
|---|---|
| Paperclip stores the bundle for `http` agents | **True** — `/paperclip/instances/default/companies/…/agents/{id}/instructions/AGENTS.md` |
| Paperclip serves it over the bundle API | **True** — isola-runtime logs `charterSource: "paperclip"`, `charterMs: 297` |
| Paperclip accepts writes for an `http` agent | **True** — `agent_config_revisions` holds `instructions_bundle_file_put`, 2026-08-18 01:31, on `a60770e9` (an `http` agent) |
| `adapterConfig` bundle fields are honoured | **True** — `instructionsBundleMode: "managed"`, `instructionsRootPath`, `instructionsEntryFile`, `instructionsFilePath` all present and used |
| The UI gates on an adapter capability flag | **True** — `buildAdapterCapabilities()`: `supportsInstructionsBundle: adapter.supportsInstructionsBundle ?? false` |
| `httpAdapter` declares that flag | **FALSE — it declares nothing.** `/app/server/dist/adapters/http/index.js` has zero references to `instructions` |

**So the missing piece is a capability declaration, not a capability.**

Two claims that were made and are wrong, recorded so they are not repeated:
- *"There is no custom-adapter path."* False — it was a bad grep. The concept is `ServerAdapterModule` / `createServerAdapter`, and this build ships `adapters/plugin-loader.js`, `services/adapter-plugin-store.js`, `loadExternalAdapterPackage`, `registerServerAdapter`, and `POST /api/adapters/install`.
- *"Every adapter with bundle support is local."* False — `cursor_cloud` declares `supportsInstructionsBundle: true` in this exact build. Bundle support is a capability, not a locality property.

---

## RULING 1 — the upstream request, first and by itself

One line upstream removes the entire risk and the entire build. Draft text:

> **Subject: `supportsInstructionsBundle` on the built-in `http` adapter**
>
> We run agents on Paperclip with `adapterType: "http"`, pointed at our own runtime, which
> fetches each agent's instructions bundle from Paperclip at reply time
> (`GET /api/agents/{id}/instructions-bundle/file?path=AGENTS.md`).
>
> The bundle works end to end for these agents today: Paperclip stores it, serves it, and
> accepts writes — we have a successful `PUT /api/agents/{id}/instructions-bundle/file`
> recorded in `agent_config_revisions` on an `http`-adapter agent, and our runtime logs
> `charterSource: "paperclip"` on every reply.
>
> But the console shows *"Instructions bundles are only available for local adapters"*,
> because `httpAdapter` declares no `supportsInstructionsBundle` and
> `buildAdapterCapabilities` defaults it to `false`. The result is that an owner cannot edit
> his own agent's instructions in the UI, even though the API fully supports it.
>
> **Request:** declare `supportsInstructionsBundle: true` and
> `instructionsPathKey: "instructionsFilePath"` on the built-in `http` adapter — or expose
> the capability per-agent via `adapterConfig`, since `instructionsBundleMode`,
> `instructionsRootPath`, `instructionsEntryFile` and `instructionsFilePath` are already
> honoured there.
>
> Build: `ghcr.io/paperclipai/paperclip:sha-8af38fb`.

**Owner sends it.** Outward-facing, and it is EPIC's relationship with the vendor.

---

## RULING 2 — the adapter package design (scoped, not built)

### What it would be

An external adapter package exporting `createServerAdapter()`, overriding the built-in type:

```typescript
export function createServerAdapter(): ServerAdapterModule {
  return {
    type: "http",                                    // overrides the built-in
    execute: faithfulHttpExecute,                    // THE RISK — see below
    supportsInstructionsBundle: true,
    instructionsPathKey: "instructionsFilePath",
  };
}
```

Agents stay `adapterType: "http"`, still pointed at isola-runtime. Exposure enforcement,
budget ceiling, tool policy, egress policy and audit are untouched. `sessionManagement`
inherits from the built-in automatically (`registry.js` ~line 355).

### Why this is a large risk bought with a convenience

**The fallback covers `sessionManagement` ONLY — not `execute`.** So the package must
reimplement the HTTP execution contract of the adapter currently serving real members of the
public on 6737.

And the thing being reimplemented is the boundary itself. **Hermes is the brain;
isola-runtime is the policy and execution boundary — and the boundary is the product's
safety.** A divergence in `execute` is a divergence in how that boundary is reached.

### Acceptance bar — all five, before it touches `isola_ai`

1. **Differential test against the built-in.** Same `adapterConfig`, same run context; capture
   the outbound request from both — URL, method, headers, body after `payloadTemplate`
   rendering, timeout behaviour. **Byte-identical or it does not ship.**
2. **Negative cases equally.** Timeout, non-2xx, malformed response, unreachable host. The
   built-in's failure semantics are what the runtime's fail-closed ladder rests on;
   divergence there is invisible until an incident.
3. **Proven on the deepseek Paperclip first.** The plugin runtime has NEVER executed on
   `isola_ai`, which serves 6737 and 9043. Zero plugins are installed there.
4. **Positive control.** An agent that still ANSWERS CORRECTLY through the override — not
   merely an override that loads. A plugin that installs cleanly and breaks replies would
   pass every check but the one that matters.
5. **Rollback rehearsed, not assumed.** `setOverridePaused` → prove the built-in resumes
   serving. The machinery exists (`builtinFallbacks`, `isOverridePaused`,
   `setOverridePaused`, `POST /adapters/:type/reload|reinstall`, `DELETE /adapters/:type`)
   and is genuinely good — but a rollback nobody has performed is a hypothesis (CLAUDE.md
   §2.17).

Package is version-pinned; no floating dependency on an alpha runtime.

---

## RULING 3 — the build is NOT justified by the editor alone

It becomes justified only if **both**:
- (a) upstream refuses, **and**
- (b) charter editing proves frequent enough that the API path is a real operational burden.

**Neither is established. As of 2026-08-19 we have edited a charter zero times.**

The capability already exists and the owner already holds the board auth for it. What is
missing is a nicer surface for it.

## RULING 4 — explicitly not doing

- **A privileged portal editor.** It would need a board credential held server-side, and
  `defect-paperclip-board-key-privilege-inheritance-2026-08-12` records that a board key on
  this instance still reports `isInstanceAdmin=true`. That concentrates instance-admin in the
  portal to save a few clicks.
- **Migrating production agents to `hermes_local`.** That would bypass isola-runtime and with
  it exposure enforcement, tool restrictions, spend limits, egress policy and audit. Also
  pointless here: `hermes_local` declares `supportsInstructionsBundle: false` in this build,
  so it would not even deliver the editor.

---

## How the charter is edited until any of this changes

`PUT /api/agents/{id}/instructions-bundle/file`, board-authenticated. **The owner holds that
auth; no lane has been shown to.** Every write is attributable — `agent_config_revisions`
carries `createdByUserId` — and the activity log records `agent.instructions_file_updated`.

**Snapshot first.** That endpoint versions the agent RECORD, not the bundle text, so a bundle
edit is irreversible. Verified snapshots exist for both live agents in
`artifacts/isola/charters/`.
