# Odoo `res.users/context_get` live verification procedure — 2026-09-18

## Why this exists

`artifacts/isola/lib/workspace/business-briefing.ts`'s `resolveBearerUserId`
now derives the CCO's Odoo company scope from the bearer token's OWN
identity, via Odoo's documented External API mechanism:

> "It is still possible to retrieve the user's own ID by sending a JSON-2
> request to `res.users/context_get` with no ID (the current user is
> extracted from the API key)."
> — [Odoo External API docs](https://www.odoo.com/documentation/master/developer/reference/external_api.html),
>   "Migrating from XML-RPC/JSON-RPC > Common service"

This closes a real, confirmed defect: the prior code selected the
`res.users` row via `binding.login`, a Foundation-stored field never
verified against the credential's real Odoo identity (JSON-2 authenticates
purely by `Authorization: bearer <apiKey>` — see `engines/odoo.ts`).

## The one thing this session could NOT verify

Context7's docs confirm the **mechanism** exists but do not show a concrete
example response body for `context_get` specifically — only the analogous
frontend `user.context` shape (`{allowed_company_ids, lang, tz}`), which is
the ORM service's client-side representation, not necessarily byte-identical
to the raw RPC return value. The code assumes the response is a JSON object
with a `uid` field (the conventional Odoo internal shape,
`res.users.context_get()` → `{'lang':.., 'tz':.., 'uid': self.env.user.id}`
across Odoo versions), but **this has not been confirmed live against
`epic-communications-inc.odoo.com` (saas~19.2)** — this session had no Odoo
API credentials to do so.

`resolveBearerUserId` is defensively strict for exactly this reason: it
refuses (returns `null`, which fails the whole company-scope resolution
closed) on anything other than a single positive-integer `uid` field. If the
real field name differs, this fails CLOSED (the CCO briefing reports
`odoo_company_scope_unresolvable`), never open.

## Minimal verification procedure (read-only, one call)

Run by a session/operator WITH real Odoo API access for a tenant's
`OdooBinding` credential:

```bash
curl -s -X POST "https://<tenant-odoo-host>/json/2/res.users/context_get" \
  -H "Authorization: bearer <the tenant's real OdooBinding apiKey>" \
  -H "Content-Type: application/json" \
  -d '{}'
```

Expect a `200` JSON object. Confirm:

1. It contains a field named exactly `uid`, holding a positive integer.
2. That integer matches the real Odoo user id the credential is known to
   belong to (cross-check via the Odoo UI: Settings → Users → that user →
   the URL's `id` param, or an existing known-good `res.users` row for that
   login).

**If the field name differs** (e.g. `user_id`, or nested under another key):
update `resolveBearerUserId` in `business-briefing.ts` to read the correct
field — do not loosen its strictness in any other way, and do not accept
`context_get`'s absence as "unauthenticated is fine."

**Never** run this against a shared/ambiguous binding without confirming
which tenant it belongs to first, and never log or persist the response body
verbatim (it may not carry secrets, but treat any live Odoo response as
data, not for storage).

## Status

Not run. Named as the precise blocker per
`directive-isola-codex-review-gate-2026-09-18`: "If live verification
requires unavailable access, name that precise blocker and prepare the
verification procedure." This is that procedure.
