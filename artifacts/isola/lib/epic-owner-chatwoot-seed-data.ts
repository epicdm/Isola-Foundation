/**
 * EPIC's own Chatwoot mirror bindings — inboxes 7, 8, 12 on account 2.
 *
 * ── Where these numbers/values came from ──────────────────────────────────
 * Confirmed live against isola-chat.saas00.epic.dm (== inbox.epic.dm, same
 * backend) 2026-09-04: account 2 is "EPIC Communications Inc", and its
 * inboxes are:
 *   7  → EPIC 295-6737 WhatsApp        (Channel::Whatsapp) — Front Desk
 *   8  → EPIC 818-3742 WhatsApp        (Channel::Whatsapp) — sole public front door
 *   12 → EPIC 818-0001 Personal Line concierge (mirror) (Channel::Api)
 *
 * EPIC_OWNER_TENANT_ID is the tenant already holding the live inbox-7 (and
 * inbox-6) ChatwootBinding registrations for this exact account — read
 * directly from the database, not derived — so migrating inbox 7 and adding
 * 8/12 land on the SAME tenant a real, already-working registration uses.
 * This is a fixed id, not resolveAdminTenantId(), deliberately: that
 * resolver's target can differ from this tenant, and the existing inbox-7
 * row is the proof of which tenant is actually correct here.
 *
 * ── Mode: mirror, not a2, for all three ────────────────────────────────────
 * Verified against the code, not the label: app/api/chatwoot/agent-bot/
 * route.ts only ever acts on `mode: 'a2'` bindings (`findMany({ where: {
 * inbox_id, mode: 'a2' } })`) — a `mirror` binding is invisible to inbound
 * webhook processing, so it can never make Foundation a second processor for
 * a number bff-v2 (or anything else) already owns. Confirmed no
 * WhatsAppNumber row and no existing 'a2' ChatwootBinding exists for 3742 or
 * 6737 in this database either, so `mirror` cannot collide with anything.
 *
 * ── Token: a credential reference, not a literal ───────────────────────────
 * `env:CHATWOOT_SERVICE_TOKEN` — resolved by lib/engines.ts's
 * getChatwootConfig() at use time, from a dedicated service identity
 * (isola-service@epic.dm, Chatwoot user 17, administrator on account 2 only)
 * rather than any person's own login-linked token. Required env addition:
 * CHATWOOT_SERVICE_TOKEN.
 */

export const EPIC_OWNER_TENANT_ID = 'cmtblqq870000pg44a2ed1hvz';
export const EPIC_OWNER_AGENT_NAME = 'Isola Assistant';

export const EPIC_CHATWOOT_BASE_URL = 'https://inbox.epic.dm';
export const EPIC_CHATWOOT_ACCOUNT_ID = '2';

/** env:VAR_NAME reference — see lib/engines.ts's resolveChatwootToken(). */
export const EPIC_CHATWOOT_SERVICE_TOKEN_REF = 'env:CHATWOOT_SERVICE_TOKEN';

export interface EpicChatwootDoor {
  label: string;
  inboxId: string;
}

export const EPIC_CHATWOOT_DOORS: readonly EpicChatwootDoor[] = [
  { label: 'EPIC 6737 (Front Desk)', inboxId: '7' },
  { label: 'EPIC 3742 (public front door)', inboxId: '8' },
  { label: 'EPIC 0001 (Personal Line concierge)', inboxId: '12' },
];
