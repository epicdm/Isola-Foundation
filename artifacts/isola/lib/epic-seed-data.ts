/**
 * EPIC business-facing WhatsApp numbers (main + FB-linked) — seed data.
 *
 * Both numbers live on the SAME WABA as the EMA sales number
 * (272252189309178) and are routed to the admin/tenant-zero Tenant
 * (resolved dynamically via resolveAdminTenantId() in instrumentation.ts,
 * NOT hardcoded — see EMA_SALES_TENANT_ID for why a fixed id would be wrong
 * here: the admin tenant's id differs per environment/database).
 *
 * ── Numbers ─────────────────────────────────────────────────────────────
 *   3742 (main):       +1 767-818-3742, phone_number_id 975632242309171
 *   1568 (FB-linked):  +1 767-285-1568, phone_number_id 294957850360835
 *
 * ── Why direct-webhook, no separate WhatsAppNumber-per-token setup ──────
 * Same "3742 trap" WABA as EMA (272252189309178) — the Meta app already
 * subscribed there delivers webhooks straight to this deployment's
 * `/api/webhooks/whatsapp`, keyed by phone_number_id. A plain WhatsAppNumber
 * row per number is sufficient; handleInboundWhatsApp() in lib/agent.ts
 * already routes strictly by phone_number_id and no-ops for any number with
 * no matching row.
 *
 * ── Outbound token ───────────────────────────────────────────────────────
 * token_env: 'WHATSAPP_TOKEN' — the same system-user token already used to
 * send from the EMA number on this WABA. It is a business-scoped token
 * (whatsapp_business_messaging), not phone-number-scoped, so it is valid
 * for any phone_number_id on this WABA, including these two.
 *
 * ── 1568 proactive-outbound nuance (2026-04-11 BFF policy) ───────────────
 * Replies to inbound messages ON 1568 are fine — the customer already
 * messaged 1568, so seeing a reply from it is expected. What the policy
 * blocks is PROACTIVE / unrecognized outbound FROM 1568 (a business
 * initiating contact on a number the recipient didn't reach out to first).
 * This module does not grant any proactive-send capability — the inbound
 * webhook reply path (lib/agent.ts) always replies from the SAME
 * phone_number_id the inbound message arrived on, which satisfies the
 * "inbound-reply only" rule by construction. See
 * EPIC_PROACTIVE_OUTBOUND_BLOCKED_PHONE_NUMBER_IDS in lib/agent-tools.ts for
 * the explicit guard on the one tool-driven send path that could otherwise
 * pick any tenant number.
 */

export const EPIC_MAIN_PHONE_NUMBER_ID = '975632242309171'; // 3742
export const EPIC_MAIN_PHONE_NUMBER = '+17678183742';
export const EPIC_MAIN_WA_NUMBER_ID = 'epic_main_wa_num';

export const EPIC_FB_LINKED_PHONE_NUMBER_ID = '294957850360835'; // 1568
export const EPIC_FB_LINKED_PHONE_NUMBER = '+17672851568';
export const EPIC_FB_LINKED_WA_NUMBER_ID = 'epic_fb_linked_wa_num';

export const EPIC_WABA_ID = '272252189309178'; // same WABA as EMA (0001) and 3742/1568
