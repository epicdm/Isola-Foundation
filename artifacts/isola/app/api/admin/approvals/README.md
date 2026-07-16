# Permission gates — human-approval for money/prod/destructive actions

Two additive pieces, built on the existing `AuditLog` (no new tables/migration):

1. **`lib/permissions.ts`** — per-action authorization tied to `Membership.role`
   (`owner | admin | staff`), on top of the existing tenant-global
   `User.role` (`owner | admin`) checked via `SessionCtx.isOwner`/`isAdmin`
   in `lib/session.ts`. `can(ctx, action)` always authorizes an existing
   global admin/owner (today's behavior, unchanged); a `staff` Membership
   is authorized only for actions whose `minRoleForAction()` allows it
   (currently `agent.update`, `agent.takeover_toggle`). No existing route
   calls `can()` yet — adopting it per route is a separate, deliberate step.

2. **`lib/approval-gate.ts`** — `checkGate()` blocks a money-movement /
   prod-route-change / destructive-op action until a human explicitly
   approves it, via this route (`POST /api/admin/approvals`). Gated by
   `PERMISSION_GATES_ENABLED` (default unset/false = always allow, i.e. no
   behavior change) — same disabled-by-default kill-switch convention as
   `FISERV_CHARGE_ENABLED` / `VOICEMAIL_POLL_ENABLED` /
   `FLOWISE_AGENT_TOOLS_ENABLED` elsewhere in this app.

Wired into one reference call site: `POST /api/admin/tenants/[id]/credits`
(money movement — real Magnus funding). With the flag off, that route is
byte-for-byte the same behavior as before this PR.

## How the gate works

- A gated call site runs `checkGate({ tenantId, actorId, action, category, requestId, ... })`
  *after* its own idempotency check (so retries don't double-record) and
  *before* the side-effecting call.
- If `PERMISSION_GATES_ENABLED !== 'true'`: `{ allowed: true, reason: 'gate_disabled' }`.
- Else, looks for an `AuditLog` row `action: "<action>.approved"` matching
  `tenant_id` + `request_id`. If found: allowed.
- Otherwise records (once) `action: "<action>.pending_approval"` and
  returns `{ allowed: false, reason: 'awaiting_approval', auditId }`. The
  call site should surface this back to the caller (the credits route
  returns HTTP 202 with the reason + audit id) rather than proceeding.

## Approving a pending gate

```bash
# List open gates (optionally ?tenant_id=<id>)
curl -s "$APP_BASE_URL/api/admin/approvals" -H "Cookie: $ADMIN_COOKIE"

# Approve one
curl -s -X POST "$APP_BASE_URL/api/admin/approvals" \
  -H "Cookie: $ADMIN_COOKIE" -H "Content-Type: application/json" \
  -d '{"tenant_id":"...","action":"admin.credits.adjust","request_id":"..."}'
```

Both routes require `ctx.isAdmin`, matching every other `/api/admin/*` route.
Re-issuing the original request (same `request_id`) after approval lets
`checkGate()` find the `.approved` row and proceed.

## Enabling for real

`PERMISSION_GATES_ENABLED` is unset in every environment today. Turning it
on for a given category/route is a deliberate follow-up (needs an approver
UI or documented curl runbook, and sign-off on which actions actually need
a human gate vs. which just need the finer `Membership.role` check) — out
of scope for this PR, which lands the primitives and one proof-of-wiring
call site only.
