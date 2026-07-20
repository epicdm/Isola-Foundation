/**
 * Founding-pilot lead-pipeline scaffold (Lane 1 Task 3) — Chatwoot-native,
 * scoped to the sales tenants only (SALES_TENANT_IDS, both on account 5).
 *
 * Two independent dimensions, both stored as Chatwoot conversation
 * custom_attributes:
 *
 *   pilot_stage — the single stage an operator moves a lead through by hand
 *   from the Chatwoot UI: New · Qualified · Demo · Proposal · Commitment
 *   pending · Won · Lost. A conversation CUSTOM ATTRIBUTE (not a label)
 *   because stage is mutually exclusive — a lead is in exactly one stage at
 *   a time, unlike labels, which are a multi-select tag set (already used
 *   here for `ai-handoff`, see chatwoot-handoff.ts).
 *
 *   source / campaign / offer / requested_assistant — context captured once
 *   on the FIRST inbound message of a new conversation, from whatever is
 *   actually available. A wa.me click carries no URL params into Chatwoot,
 *   only the prefilled message text, so today only `source` can be derived
 *   this way (from the one known apply-link prefill in app/page.tsx).
 *   campaign/offer stay unset until per-offer apply links exist to carry a
 *   utm-bearing short link or a distinct prefill into WhatsApp;
 *   requested_assistant is left for the operator to fill by hand.
 *
 * ONE-TIME SETUP (already done for account 5, 2026-07-20 — see
 * scripts/setup-lead-pipeline-chatwoot-attrs.sql): the 5 conversation custom
 * attribute definitions (pilot_stage: list; source/campaign/offer/
 * requested_assistant: text) were created directly against Chatwoot's own
 * Postgres, matching the exact shape of account 5's 9 pre-existing
 * conversation-attribute definitions. Chatwoot's custom_attributes API
 * accepts and stores arbitrary keys regardless of whether a definition
 * exists (the jsonb column has no FK to custom_attribute_definitions) — the
 * definitions only drive the Chatwoot UI (dropdown vs. text box, whether the
 * field appears in the sidebar at all), not API-level enforcement.
 */

export const PILOT_STAGES = [
  'New',
  'Qualified',
  'Demo',
  'Proposal',
  'Commitment pending',
  'Won',
  'Lost',
] as const;
export type PilotStage = (typeof PILOT_STAGES)[number];

export const NEW_STAGE: PilotStage = 'New';

// Known apply-link prefill texts → source tag. Keyed by exact match (after
// trimming) against the inbound content — WhatsApp lets a customer edit the
// prefilled text before sending, so a loose/partial match risks tagging a
// customer's own unrelated message as an "apply" lead.
const KNOWN_APPLY_PREFILLS: { text: string; source: string }[] = [
  {
    text: "Hi, I'd like to apply for the founding pilot for my business.",
    source: 'founding-pilot-apply',
  },
];

/**
 * Best-effort parse of a first-inbound message for a known apply-link
 * prefill. Returns null when the text doesn't match any known prefill —
 * most first-inbound messages are not from an apply link (a customer typing
 * their own opener, or a non-apply entry point), and those must stay
 * unlabeled rather than guessed at.
 */
export function detectApplySource(content: string): string | null {
  const trimmed = content.trim();
  const match = KNOWN_APPLY_PREFILLS.find((p) => p.text === trimmed);
  return match?.source ?? null;
}

/**
 * Stamps initial lead-pipeline context onto a brand-new sales-tenant
 * conversation: pilot_stage=New always, plus source when the first inbound
 * message matches a known apply-link prefill. campaign/offer/
 * requested_assistant are intentionally omitted here (left null/unset) —
 * populated later by a per-offer apply link or by the operator.
 *
 * Never throws — best-effort enrichment, same failure posture as
 * surfaceHandoff()/toggleTypingStatus() in this file's siblings. A Chatwoot
 * hiccup here must never block the reply path.
 */
export async function stampLeadContext(
  baseUrl: string,
  accountId: string,
  cwConvId: number,
  botToken: string,
  firstMessageContent: string,
): Promise<void> {
  const customAttributes: Record<string, string> = { pilot_stage: NEW_STAGE };
  const source = detectApplySource(firstMessageContent);
  if (source) customAttributes.source = source;

  try {
    const res = await fetch(
      `${baseUrl}/api/v1/accounts/${accountId}/conversations/${cwConvId}/custom_attributes`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', api_access_token: botToken },
        body: JSON.stringify({ custom_attributes: customAttributes }),
        signal: AbortSignal.timeout(10000),
      },
    );
    if (res.ok) {
      console.log(`[agent-bot] Lead context stamped for conv cw#${cwConvId}:`, JSON.stringify(customAttributes));
    } else {
      console.warn(`[agent-bot] stampLeadContext failed (${res.status}):`, await res.text().catch(() => ''));
    }
  } catch (e: any) {
    console.warn('[agent-bot] stampLeadContext error:', e?.message);
  }
}
