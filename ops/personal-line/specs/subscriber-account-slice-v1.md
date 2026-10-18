# Personal Line subscriber account slice (2a) — design v1 (Lane A, 2026-10-11)

Packet: `xp-seldonframe-workspace-as-product-personal-line-2026-10-11` · PM: `coord-pm-phase1-finish-settings-and-own-contact-account-slice-2026-10-11`.

## Outcome (owner-visible)
A Personal Line subscriber opens **their own** account in the EPIC Personal Line customer portal and sees their line
number, plan, included minutes, wallet credit and setup state, with a working "Manage my line" action — and can never see
anyone else's. The CRM pipeline moves on real Personal Line events.

## Authorities (unchanged)
- plsvc (Personal Line service) = engine: lines, plans, minutes, wallet, registration. Odoo SaaS = ledger.
- SeldonFrame (Uplink fork) = contact, deal projection, portal session, presentation.
- Meta-verified WhatsApp sender (wa_id) = the identity root. **Self-entered phone numbers and bare emails never grant access.**

## 1. Trusted subscriber → contact identity
- New fork table `external_identities(org_id, provider='personal_line', external_id=<plsvc liteAccount id>, contact_id,
  created_at)`, unique (org_id, provider, external_id) and (org_id, provider, contact_id).
- Only the signed plsvc → SeldonFrame ingress (below) can create/attach it. Intake forms, chat, email and phone fields can
  never create or change this link.
- Contact phone = the verified wa_id supplied by plsvc (server-to-server), stored masked in logs.

## 2. Event ingress (plsvc → SeldonFrame), minimal and durable
- `POST /api/v1/integrations/personal-line/events` on the fork. Auth: HMAC-SHA256 over `ts.body` with a dedicated shared
  secret (name only: `PL_SF_EVENTS_KEY`), ±300 s, key id header; refuse everything else.
- Payload: `{event_id (uuid), type, occurred_at, version, pl_account_id, wa_id, did, facts{plan, trial_end, registration_now,
  activated_at, first_call_at}}`.
- Durable: `pl_event_inbox(event_id PK, pl_account_id, type, occurred_at, version, received_at, applied)`; duplicate
  event_id = no-op 200; an older `version` than the last applied for that account never overwrites newer facts.
- Types: `pl.signup_started`, `pl.line_created`, `pl.app_activated`, `pl.registration_changed`, `pl.first_call`,
  `pl.trial_ending`, `pl.trial_expired`, `pl.plan_purchased`.
- Projection: upsert contact via the identity table; move the PL deal forward only (Lead → Signup started → Line created →
  App activated → First call → Paid plan/Lost) — never backwards from a stale event. `registration_now` (live) is kept
  separate from historical `activated_at` / `first_call_at`; app-link opened is NOT activation.
- plsvc side: an outbox (`sf_event_outbox`) written in the same transaction as the engine change, delivered with retry +
  backoff; rebuildable (a backfill command replays current state as events).

## 3. Portal access for the subscriber (no email required)
- In WhatsApp, the subscriber asks for their account (concierge tool `pl_account_link`, or a "My account" button).
- plsvc calls SeldonFrame `POST /api/v1/integrations/personal-line/portal-link` (same HMAC) with `pl_account_id`;
  SeldonFrame resolves the contact via the identity table, enables portal access for that contact only, and mints a
  one-time, short-lived portal magic link (existing portal magic-link machinery, `lib/portal/auth.ts`).
- The link is delivered **only** to the verified WhatsApp sender. Email can be added later from inside the portal and is
  verified there (code) before it is used for sign-in.

## 4. "Your Personal Line" in the portal
- The stored composite portal sections have no renderer in `app/customer` (to be re-verified on the serving image before
  relying on them), so the card is a native built-in on portal Home: `app/customer/[orgSlug]/(client)/page.tsx`.
- Server-side only: session contact → identity table → `pl_account_id` → signed request to plsvc
  `GET /api/internal/pl-concierge/v1/account/summary?account=<id>` (new; same HMAC family as the relay context) →
  line number, plan + end, minutes left, wallet, setup state (registration now). No contact or account id comes from the
  browser.
- Actions: "Send me a fresh setup link" (plsvc sends via WhatsApp) and "Get help on WhatsApp". No payment action until the
  Fiserv provider exists.

## 5. Tests (positive twin for every negative)
- Ingress: bad/old signature refused + a correctly signed one accepted; replayed event_id no-op; older version ignored.
- Identity: an intake form with someone's phone creates NO identity link; ingress does.
- Portal: contact A's session never returns contact B's summary (and A's does); a contact without an identity link sees
  no line card; magic link single-use + expiry.
- plsvc summary endpoint: unsigned / wrong account refused; correct one answers.

## 6. Delivery
- Fork (EPIC SeldonFrame `epicdm/isola-seldonframe`): migration + ingress route + identity/projection + portal card +
  portal-link route + timezone-sync fix for `updateWorkspaceSettingsAction` (blueprint `workspace.contact.timezone`).
- plsvc (isolav2, on the rc15 branch): outbox + emitter + summary endpoint + `pl_account_link` support.
- Adapter: `pl_account_link` tool. Agent skill: offer "My account" when asked.
- Build on deepseek isolated copies; staging first (plstg + uplinkstg); production by owner promotion; PRs per protocol.
