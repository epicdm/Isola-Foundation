# Security review — isola-port-control-plane-mcp

## Threat sketch

An external AI client (ChatGPT, or anyone who obtains the bearer token)
gets read access to Isola's Port.io control plane: release status,
build tasks, defects, requirements, decisions. The risks we care about,
in order:

1. **The client mutates Port data** (accidentally or via a compromised/
   malicious prompt injection) — e.g. closes a defect, deletes a
   build_task, edits a decision. This would corrupt the canonical
   project-tracking record that the whole team (and other automation)
   relies on.
2. **The client exfiltrates PII** — phone numbers, emails, customer
   names/content embedded in entity fields, or message transcripts that
   happen to have been pasted into a Port entity description.
3. **The client or an unauthenticated third party abuses the endpoint**
   — hammering it, using it as a probe against the wider Port
   organization, or reading data the operator never intended to expose
   (entities from blueprints outside the intended scope, e.g. a future
   `customer` or `contract` blueprint).
4. **Credential/token leakage** — the Port API credential or the MCP
   bearer token ending up in logs, commit history, or error messages.

## The real control: read-only enforcement in code, not Port permissions

**Do not rely on "the Port credential is scoped read-only" as the
control.** Port's permission model may or may not offer a truly
read-only credential type, and even if it does, credentials get
misconfigured, copy-pasted from a more privileged one, or rotated
incorrectly. The actual control in this system is structural:

- `src/portClient.ts` has exactly one function, `guardedRequest()`, that
  every network call in the entire client funnels through. It allows
  only: any GET, `POST /v1/auth/access_token` (token exchange, not a
  data mutation), and `POST /v1/entities/search` (Port's read-only
  search endpoint, which happens to be POST-shaped). Anything else — PUT,
  PATCH, DELETE, or POST to any other path — throws `ReadOnlyViolation`
  **before any network call is attempted.** There is no code path in this
  repository that constructs a mutating HTTP request to Port. This is
  verified by unit tests (`test/portClient.test.ts`) and can be
  independently re-verified by grepping `src/portClient.ts` for any
  `"PUT"`/`"PATCH"`/`"DELETE"` literal used as an outgoing request method,
  or any `"POST"` call to a path other than the two allowlisted ones —
  there are none (see the handoff report for the exact grep command +
  output).
- Even if the Port credential handed to this server had write scope,
  this server structurally cannot use it to write, because it never
  issues a write-shaped request.

## Entity-type allowlist

Only entities whose blueprint is one of `decision`, `requirement`,
`build_task`, `defect`, `evidence`, `capability`, `marketing_claim`,
`epic_project`, `uat_test_case`, `incident`, `risk` are ever returned
(`src/redact.ts`, `ALLOWLISTED_BLUEPRINTS`). Anything else — including
any future blueprint that might contain customer PII, contracts, or
financial data — is dropped, never passed through, regardless of what
Port's API returns. This is enforced at the redaction/sanitization layer
that every tool passes through before returning data.

## Redaction (defense in depth)

Even within allowlisted blueprints:

- Phone numbers are masked to only the last 4 digits.
- Emails are masked to first-char-of-local-part + TLD only (e.g.
  `eric@epic.dm` -> `e***@dm`) — domain/company name is not disclosed.
- Any object key matching `/(secret|token|key|password|credential)/i` is
  fully redacted to `"[REDACTED]"` regardless of type.
- Message-body-shaped fields (`body`, `message`, `transcript`, `content`,
  `text`) are stripped entirely to `"[STRIPPED]"` — this covers the case
  of a WhatsApp transcript or similar conversational content accidentally
  living inside a Port entity field.

This means even a Port entity that *is* on the allowlist, and *does*
contain some PII in a free-text field, gets that PII stripped before it
ever leaves this server.

## Auth + rate limiting

- Every request to `/mcp` requires `Authorization: Bearer
  <MCP_BEARER_TOKEN>`. No token configured -> every request rejected
  (fail closed, not fail open). Wrong/missing token -> `401`.
- In-memory fixed-window rate limiter: 60 requests/minute per token.
  Exceeding it does not crash the server, it just rejects further
  requests for that window.
- Responses are capped at 200KB; anything larger is truncated and
  explicitly flagged (`truncated: true`) rather than silently cut off
  mid-structure.
- Pagination `limit` defaults to 25, hard-clamped at 100 regardless of
  what the caller requests.

## Localhost-bind-only posture

The server binds to `127.0.0.1:8890` only. It is not reachable from
outside the host it runs on until a human adds a TLS-terminating reverse
proxy (nginx) in front of it and opens DNS for `portmcp.epic.dm` — see
`docs/CHATGPT-PORT-CONNECTION-HANDOFF.md`. This build does **not** do
that step, by design (the build task explicitly forbids touching
nginx/DNS).

## Residual risk

- **Port may not issue a truly read-only API credential.** If Port's
  credential model only offers broader scopes, the credential this
  server uses could technically have write capability at the Port-API
  level. This server's own `guardedRequest()` enforcement is what
  actually guarantees read-only behavior in that scenario — see above.
  This is a real residual risk in the sense that a *different* piece of
  code using the same credential could write; it is not a risk for this
  codebase specifically.
- **Recommendation:** scope the Port credential to the least privilege
  Port's permission model allows (ideally read-only; if not available,
  the most restricted role/team available), and rotate it on a 90-day
  cadence regardless. Track the rotation as a recurring calendar/ops
  task — this repo does not automate credential rotation.
- **No secrets exist anywhere in this repository.** `MCP_BEARER_TOKEN`,
  `PORT_CLIENT_ID`, and `PORT_CLIENT_SECRET` are read from environment
  variables only, at runtime. `.gitignore` excludes `.env*` files and
  `data/audit.log`. No credential value appears in source, tests, docs,
  or commit history for this repo.



## Addendum A - Internal Agent mode (stdio, content reads)

Added for an EPIC-internal Hermes agent that must give grounded status answers.
The read-only chokepoint, redaction rules, audit log and size caps are unchanged.

**Blueprint allowlist additions and residual risk**

| Blueprint | Why | Residual risk |
|---|---|---|
| `execution_plan` | Plan of record; the agent needs plan/current_state/next_gate | Prose may mention commercial detail (prices, partner names). Internal-only audience; value scrub still applies. |
| `execution_packet` | Objective/acceptance/evidence_needed/rollback per packet | Same as above; may reference host names/paths (not secrets). |
| `isola_launch_gate` | Launch criticality and gate state | Low; structured. |
| `isola_component` | Component inventory/version/status | Reveals topology (service names). Internal-only. |
| `agent_contract` | What each agent may do | Reveals agent powers/policy; a charter is documentation, not a control. |

**Free-text return (`read_record`)**: a whitelist of prose fields (description, plan,
current_state, next_action, next_gate, decision_text, rationale, objective, acceptance,
evidence_needed, rollback, root_cause, resolution, contract, ...) is returned instead of
stripped. `body/message/transcript/content/text` and secret-looking keys are never eligible.
Residual risk: a secret in prose that matches none of the value patterns would be returned.
Patterns are heuristic; mitigations are the internal-only audience, size/paging caps and audit.

**Value-level scrub** (all returned strings): Bearer tokens, `Authorization:` lines, JWTs,
`sk-`/`ghp_`/`github_pat_`/`xox*-`/`AKIA`/`AIza` shapes, PEM private keys, `password|secret|token|
api_key` assignments, connection strings with credentials, unlabelled >=32-char hex or
mixed alphanumeric runs (hex labelled sha256/hash/digest/commit passes; 32-hex UUIDs
without hyphens are scrubbed - fail closed). Known gaps: bare unseparated digit runs without
a leading `+` are not treated as phone numbers in free text (indistinguishable from ids/epochs);
secrets written as ordinary words are not detectable. Structured-field phone masking is
unchanged, except ISO dates/timestamps are no longer mis-masked as phone numbers.
Scrubbing runs on the whole field BEFORE paging so a secret cannot straddle a page boundary.

**stdio transport**: no listener, no bearer; the process boundary is the auth. Risk moves to
who can spawn the process and read the credential files (mode 600; the secret never appears in
logs, results or audit - tested). `search_port` rows clip long prose to 500 chars. The credential
is Port-API scoped; guardedRequest still prevents any write even if that credential has write scope.
