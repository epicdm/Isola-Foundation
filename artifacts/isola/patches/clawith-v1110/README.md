# Clawith / MCP escalation-ref patches — UNAPPLIED

Drafted per mandate items 4–6 (`def-clawith-escalation-shared-token-no-agent-principal-2026-07-21`
hardening chunk, 2026-07-21). Nothing here has been applied. No SSH-write, no
restart, no deploy was performed to produce these — both remote files were
only *read* (via read-only SSH) to draft an accurate additive diff.

## Targets

| File | Host | Path |
|---|---|---|
| `isola_bridge.py.diff` | deepseek (66.118.37.12) | `/home/epicdm/clawith-v1110/backend/app/api/isola_bridge.py` |
| `mcp-isola-customer-tools-server.py.diff` | deepseek (66.118.37.12) | `/opt/bff-v2/services/mcp-isola-customer-tools/server.py` |

Both diffs are additive-only: no upstream Clawith core file (`chat_intake.py`,
`run_state_reader.py`, `enqueue_chat_runtime`, `main.py`, etc.) is touched, and
no other tool in `mcp-isola-customer-tools/server.py` (`get_my_account`) is
changed.

## What each diff does

- **`isola_bridge.py.diff`** — adds `conversation_ref: str | None` and
  `correlation_id: str | None` to `BridgeMessageIn` (both optional, so any
  caller not yet sending them still validates); when `conversation_ref` is
  present, appends an escalation instruction to the existing per-turn
  `caller_directive` string (the same channel already used to hand the agent
  the verified caller phone number) telling the agent to use
  `escalate_to_human(conversation_ref=..., reason=...)` when appropriate, and
  to never repeat, explain, or disclose the ref; echoes `correlation_id` back
  in the bridge's JSON response for tracing.

- **`mcp-isola-customer-tools-server.py.diff`** — changes
  `escalate_to_human(reason)` to `escalate_to_human(conversation_ref, reason="")`.
  The new body POSTs `{"conversation_ref": ..., "summary": reason}` to
  Foundation's `/api/customer/escalate` (the field is `summary`, not `reason`,
  to match the endpoint's actual body shape in `app/api/customer/escalate/route.ts`
  — confirmed by reading that file, not assumed) using the existing
  `_CUSTOMER_TOKEN` bearer auth, and returns
  `{"escalated": bool, "status"|"error", "correlation_id"}` — never reporting
  `escalated: True` unless Foundation's response has `ok: true`.

## Error codes this patch must pass through honestly (from `escalate/route.ts`)

`bad_auth` (401) · `conversation_ref required` (400, tool-side pre-check
duplicates this) · `unknown_or_expired_conversation_ref` (404) ·
`malformed_conversation_ref` (400) · `unknown_conversation` (404) ·
`conversation_not_chatwoot_backed` (409) · `ref_scope_mismatch` (403,
covers wrong-tenant/wrong-binding/wrong-inbox/wrong-agent) ·
`binding_unresolved` (409) · `bot_token_not_configured` (500) · success
`status`: `"escalated"` or `"already_escalated"`.

## Tests

`test_sketches.py` in this directory — **NOT executed**. There is no local
Python/Clawith/MCP environment in this repo checkout to run them in. They
must be run for real inside each project's own test suite/CI (backend pytest
suite for `isola_bridge.py`; the MCP server's own test suite, or a new one if
none exists yet, for `server.py`) before either diff is applied.

## Deployment order (once separately approved — not performed here)

1. Apply the Foundation-side migration `20260721020000_harden_escalation_ref`
   (`prisma migrate deploy`, never `db push`/`migrate dev`) and deploy
   Foundation with the `EscalationRef` hardening + bridge/endpoint changes
   already in this branch.
2. Apply `isola_bridge.py.diff` on deepseek, run the backend's own test
   suite, restart only the `clawith-v1110` backend process.
3. Apply `mcp-isola-customer-tools-server.py.diff` on deepseek, run its test
   suite, restart only the `mcp-isola-customer-tools` MCP server process.
4. Smoke-test one non-production conversation end to end before any live
   Meta/Chatwoot traffic relies on the new tool signature.

Steps 1–3 must land in that order: the MCP tool calls
`/api/customer/escalate`, which requires the migrated `EscalationRef`
columns to exist; the bridge must be minting `conversation_ref`/
`correlation_id` before the MCP tool has any ref to forward.

## Rollback

Each step is independently revertible: redeploy the prior Foundation
release (endpoint tolerates a missing new bridge fields since they were
already optional pre-migration — but the migration itself is additive/
backward-compatible, so no down-migration is required to roll back
application code); revert `isola_bridge.py` to drop the two new
`BridgeMessageIn` fields and the directive/response additions (old callers
already work today with `external_conversation_id`, untouched by this
patch); revert `server.py`'s `escalate_to_human` to the prior
side-effect-free stub. None of the three steps requires reverting another.
