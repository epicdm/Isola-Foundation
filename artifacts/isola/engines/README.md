# isola-platform-modules — Bucket 1 extraction

Five portable, self-contained TypeScript modules extracted from the proven
`/opt/bff-v2/app/lib` engine-client logic on `deepseek`, for drop-in use by a
fresh app (isola-platform, on Replit).

## Portability rules (verified)

- Each module imports **only** Node built-ins (`node:crypto` in `magnus.ts`;
  nothing else anywhere) and uses the global `fetch`.
- **Zero** imports of `@/...`, `../...`, Prisma, or any app-specific type —
  verified per file with:
  `grep -nE "from .@/|from ..\.|prisma|PrismaClient" <file>` → empty on all 5.
- Config (base URLs, keys, secrets) is a typed object **parameter** passed
  into every function. No module reads `process.env` itself — the calling
  app wires env → config.

## Modules

### 1. `magnus.ts` — Magnus Billing API
HMAC-SHA512-authenticated REST client.

- `magnusRequest(config, module, action, data)` — core POST + auth
- `getBalance(config, magnusUserId)`
- `getCalls(config, magnusUserId, limit?)`
- `addCredit(config, magnusUserId, credit)`
- `debitCredit(config, magnusUserId, amountEc, description)` — **⚠️ UNVERIFIED**: negative-credit debit via `refill/save` has never been proven live (no floor-at-zero / rejection check). Probe before relying on it for real money.

**Config — `MagnusConfig`**: `{ baseUrl, apiKey, apiSecret }`

**Caution**: the HMAC signing, the `process.hrtime()`-derived nonce, and the
`phpUrlencode()` quirks (space→`+`, RFC-3986 unreserved re-escaping) are
load-bearing — Magnus validates the signature against the exact encoded
string. Do not "clean up" the encoding.

### 2. `fiserv.ts` — EPIC Fiserv payment gateway
- `charge(config, input)` — card charge with hard success validation (HTTP ok AND approved-or-absent status AND non-empty ref)

**Config — `FiservConfig`**: `{ apiKey, baseUrl? }` (baseUrl defaults to `https://api01.epic.dm`)

**Caution**: the original `FISERV_CHARGE_ENABLED` disabled-by-default kill
switch was **removed** from this module — gating whether/when to call
`charge()` is now the **calling app's** responsibility. This module attempts
a real charge every time it's invoked. PAN/CVV/apiKey are never logged.
HTTP 200 is not proof of success (validated via status + non-empty ref) —
see the incident note in the file header before touching that logic.

### 3. `whatsapp.ts` — WhatsApp Cloud API sends
- `sendText(config, input)` — free-form text (only within 24h service window)
- `sendTemplate(config, input)` — pre-approved template (delivers any time)

**Config — `WhatsAppConfig`**: `{ graphVersion? }` (defaults to `v25.0`)

**Caution**: these are **raw send calls only**. The source's P0-0
consent/compliance gate (`wa-send-gate.ts`) and outbound mirror
(`paperclipMirrorOutbound`) are Bucket 2 — the app must implement its own
gate and call these functions **after** the gate passes. No gate is wired
in here; calling directly sends real messages with no compliance check.

### 4. `chatwoot.ts` — Chatwoot Application API
- `searchContactByPhone(config, phone)`
- `createContact(config, phone, name?)`
- `upsertContact(config, phone, name?)`
- `getContactConversations(config, chatwootContactId)`
- `createConversation(config, chatwootContactId, inboxId, label?)`
- `addMessage(config, chatwootConversationId, content, messageType?, contentAttributes?)`
- `addPrivateNote(config, chatwootConversationId, content)`

**Config — `ChatwootConfig`**: `{ baseUrl, accountId, token }` (per-tenant/account agent API token)

**Caution**: `upsertContact` normalizes phone to E.164 before search/create
(Chatwoot 422s on bare digits). `addPrivateNote` is fire-and-forget and
swallows all errors, matching source behavior exactly. Conversation labels,
status toggling, inbox/team management, and webhook registration were
**not** extracted (out of Bucket 1 scope) — see source file if needed later.

### 5. `odoo.ts` — Odoo JSON-2 transport
- `json2Call(config, model, method, params, timeoutMs?)` — canonical `POST {url}/json/2/{model}/{method}` with bearer auth + `X-Odoo-Database`
- `findCustomerByPhone(config, phone)` — `res.partner` search_read helper built on `json2Call`
- `OdooApiError`, `OdooNoApiError` — thrown error classes

**Config — `OdooConfig`**: `{ url, apiKey, db }`

**Caution**: this module implements **only the cloud/per-host fetch path**.
The source `transport.ts` has a second path (`node:http` with an explicit
`Host: <db>` header) for LOCAL self-hosted Odoo containers that route the DB
by HTTP Host header (`dbfilter = ^%d$` + `proxy_mode = True`) — global
`fetch` silently strips a custom `Host` header, so that path needs
`node:http`. That branch was **deliberately skipped** per extraction scope.
If isola-platform ever talks to such a container, `json2Call` will fail with
"No database is selected" and the local-routing branch must be re-added
(see `/opt/bff-v2/app/lib/odoo/transport.ts` lines 77-152 on deepseek for
reference).

## What was NOT extracted (flagged, not silently dropped)

- **magnus.ts**: DID provisioning/deprovisioning, SIP account creation, pool-DID
  draw/routing, deprovisioning flow — out of Bucket 1 scope (balance/calls/credit
  only, as specified).
- **whatsapp.ts**: interactive buttons/lists, media/document/video/sticker/location
  sends, business-profile get/set, Lite onboarding/topup Flow sends, typing
  indicators, read receipts, authentication-template send — out of scope
  (only sendText/sendTemplate were requested).
- **chatwoot.ts**: conversation labels, status toggling, inbox management, team
  management, webhook registration, agent-bot attach, custom attributes — out
  of scope (only the 7 requested functions were extracted).
- **odoo.ts**: the local self-hosted Host-header routing path (see Caution
  above) — explicitly instructed to skip and note as a caveat, not silently
  dropped.

Everything above was a scope decision per the extraction brief, not a
dependency that couldn't be severed — no function in the 5 requested lists
was left un-extractable.

