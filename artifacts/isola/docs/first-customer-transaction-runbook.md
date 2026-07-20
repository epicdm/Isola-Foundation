# First-customer transaction path — config assertion + operator runbook

Lane 1 Task 5. This is **not** a payment build — no code in this repo mints,
displays, or sends a customer-facing checkout/payment link anywhere in the
apply -> proposal -> pay sales flow. Payment for the founding pilot is
**EPIC-issued invoice + NBD/manual only**.

## Assertion: no customer-facing payment link is reachable

Verified two ways, both re-checkable at any time:

1. **`scripts/assert-no-payment-path.ts`** — live config check against the
   running deployment. Confirms (a) `FISERV_CHARGE_ENABLED` is OFF via the
   public `/api/setup-status` checklist (the same one the in-app setup
   banner reads, so it can't drift from what's actually deployed), and
   (b) `lib/agent-tools.ts`'s `TOOL_NAMES` exposes no payment/checkout tool.
   Run: `npx tsx scripts/assert-no-payment-path.ts`. Last run
   (2026-07-20, against `https://isola-foundation.replit.app`): **PASSED**
   — `FISERV_CHARGE_ENABLED` off, `TOOL_NAMES` = `odoo.read`,
   `odoo.create_lead`, `wa.send` (no payment tool).

2. **`lib/agent-tools.test.ts`** — unit tests proving
   `checkOdooPolicy()` (the gate every Odoo call in this repo passes
   through) always holds `account.payment` over policy and never executes
   it, regardless of method — defense in depth even if the tool set is
   widened later.

Supporting facts (static, from the code):
- `app/api/wallet/topup/route.ts` is the **only** place in the codebase that
  can ever initiate a live Fiserv charge, and it is session-auth gated (401
  before the kill-switch check is even reached) — it is the **consumer
  prepaid-wallet top-up flow**, a different product surface, not reachable
  from the B2B founding-pilot sales path (Chatwoot A2 webhook, agent-tools,
  or the landing page).
- No Stripe integration exists anywhere in this repo.
- Nothing in `app/api/chatwoot/agent-bot/route.ts` (the sales conversation
  path) or `lib/agent-tools.ts` (the only tool surface an external brain can
  reach) ever constructs or sends a checkout/payment URL.

## Reconciliation record shape

```
{ customer, offer, amount, currency, NBD_reference, date, invoice_id }
```

**Authoritative store — resolves the R0 baseline's open question**
("authoritative manual-billing ledger location"):

- **Odoo invoice (`account.move`) = record-of-truth for the invoice
  itself** — the actual EPIC-issued invoice document, its line items, and
  its amount live in Odoo, the system EPIC already uses for CRM/leads
  (`engines/odoo.ts`).
- **`AuditLog` row = the manual reconciliation ledger entry.** One row per
  payment event, written with:
  - `action: 'pilot.invoice.reconciled'`
  - `entity: 'invoice'`, `entity_id: '<Odoo invoice id>'`
  - `tenant_id`: the sales tenant (`ema_sales_tenant` /
    `43b006e4-33e0-42a8-bec7-4422ba290d79`)
  - `actor_id`: the operator's user id (a human action, not a system one)
  - `meta: { customer, offer, amount, currency, NBD_reference, date,
    invoice_id }`

This mirrors the existing, already-shipped pattern for real-money ledger
events — `scripts/reconcile-ledger-vs-magnus.ts` writes drift to `AuditLog`
(`action: 'ledger.reconcile.drift'`) rather than silently correcting a
real-money balance, and the claim-guard writes `claim_guard.blocked` the
same way. No new Prisma model is introduced — `AuditLog`'s existing
`meta: Json` field is a direct fit, per the "minimal code" scope for this
task.

Writing the `AuditLog` row is a manual operator action for now (step 3
below) — no code in this PR automates it. A follow-on script (e.g.
`scripts/record-pilot-invoice-reconciliation.ts`, modeled on
`reconcile-ledger-vs-magnus.ts`) is a natural next step once the first real
invoice exists, but is out of scope here per the "not a payment build"
instruction.

## Operator runbook

1. **Issue EPIC invoice.** Once a lead reaches `pilot_stage = Proposal` /
   `Commitment pending` (see the Task 3 lead pipeline) and agrees to an
   offer, the operator manually creates an Odoo invoice (`account.move`)
   for the ratified offer amount from the Claim Register (`app/page.tsx`
   `OFFERS`, cross-checked against `lib/claim-guard.ts`
   `RATIFIED_EC_AMOUNTS`). No code in this repo issues an invoice
   automatically.
2. **Customer pays via NBD / manual.** The customer wires or deposits
   payment via NBD (or hands over payment by another manual, in-person/bank
   means) directly to EPIC — never through a code-driven checkout link,
   since none exists in this flow.
3. **Record the reconciliation row.** Once payment clears, the operator
   writes one `AuditLog` row (shape above) tying the Odoo invoice to the
   NBD reference and date. This is the durable, queryable proof that a
   given invoice was paid and reconciled.
4. **Recurring begins at go-live/acceptance.** The recurring monthly charge
   (the offer's `monthly` figure) only starts once the pilot is live and
   accepted by the customer — not before. Each subsequent recurring payment
   repeats steps 1-3 (a new invoice, a new NBD payment, a new
   reconciliation row).

## Non-goals of this task

- No invoice-issuance automation, no Odoo `account.move` write helper, no
  reconciliation-row-writing script — all deliberately out of scope
  ("minimal code... config assertion + the documented record shape").
- No change to `FISERV_CHARGE_ENABLED` or any payment-engine code — the
  kill-switch stays exactly as-is; this task only asserts and documents its
  current state.
