/**
 * Chatwoot handoff-surfacing helpers, extracted from
 * app/api/chatwoot/agent-bot/route.ts so surfaceHandoff() is unit-testable
 * (Next.js App Router route.ts files may only export HTTP method handlers).
 */

export async function toggleConvStatus(
  baseUrl:   string,
  accountId: string,
  cwConvId:  number,
  status:    string,
  botToken:  string,
) {
  try {
    const res = await fetch(
      `${baseUrl}/api/v1/accounts/${accountId}/conversations/${cwConvId}/toggle_status`,
      {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', api_access_token: botToken },
        body:    JSON.stringify({ status }),
        signal:  AbortSignal.timeout(10000),
      },
    );
    if (res.ok) {
      console.log(`[agent-bot] Conv cw#${cwConvId} toggled to ${status}`);
    } else {
      console.warn(`[agent-bot] toggle_status failed (${res.status}):`, await res.text().catch(() => ''));
    }
  } catch (e: any) {
    console.warn('[agent-bot] toggle_status error:', e?.message);
  }
}

/**
 * Surfaces a brain's needs_handoff signal (currently only Clawith emits this,
 * plus the claim-guard in lib/claim-guard.ts, which forces needsHandoff=true
 * on every block) INTO Chatwoot for a human to notice — never a separate
 * owner ping. Three best-effort actions, each independently caught so one
 * failing never blocks the others or the caller: a private note (visible to
 * human agents only, never sent to the customer), a label, and a status
 * toggle to 'open' — the SAME status value the outgoing-reply handler in
 * route.ts uses when a human actually takes over, i.e. "needs a human's
 * eyes". This never touches Conversation.human_handling; that flag stays the
 * single authority for whether the bot may keep replying.
 *
 * SINGLE-FIRE: the existing label set is fetched FIRST and gates the whole
 * sequence, not just the label POST. Previously only the label add was
 * deduped, so the private note re-posted on every needs_handoff=true message
 * in a conversation (P1 dispatch bug) — now the whole surfacing sequence
 * fires at most once per conversation.
 */
export const HANDOFF_LABEL = 'ai-handoff';

export async function surfaceHandoff(
  baseUrl:   string,
  accountId: string,
  cwConvId:  number,
  botToken:  string,
): Promise<void> {
  let existing: string[] = [];
  try {
    const getRes = await fetch(
      `${baseUrl}/api/v1/accounts/${accountId}/conversations/${cwConvId}/labels`,
      { headers: { api_access_token: botToken }, signal: AbortSignal.timeout(10000) },
    );
    existing = getRes.ok ? ((await getRes.json().catch(() => ({})))?.payload ?? []) : [];
  } catch (e: any) {
    console.warn('[agent-bot] handoff label fetch error:', e?.message);
  }

  if (existing.includes(HANDOFF_LABEL)) {
    console.log(`[agent-bot] Handoff already surfaced for conv cw#${cwConvId} — skipping duplicate`);
    return;
  }

  try {
    const noteRes = await fetch(
      `${baseUrl}/api/v1/accounts/${accountId}/conversations/${cwConvId}/messages`,
      {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', api_access_token: botToken },
        body:    JSON.stringify({
          content:      '🤖 Clawith flagged this conversation for human review.',
          message_type: 'outgoing',
          private:      true,
        }),
        signal: AbortSignal.timeout(10000),
      },
    );
    if (!noteRes.ok) {
      console.warn(`[agent-bot] handoff private note failed (${noteRes.status}):`, await noteRes.text().catch(() => ''));
    }
  } catch (e: any) {
    console.warn('[agent-bot] handoff private note error:', e?.message);
  }

  try {
    // Chatwoot's label endpoint REPLACES the conversation's full label set —
    // reuse the `existing` set fetched above so this only adds, never clobbers.
    const labelRes = await fetch(
      `${baseUrl}/api/v1/accounts/${accountId}/conversations/${cwConvId}/labels`,
      {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', api_access_token: botToken },
        body:    JSON.stringify({ labels: [...existing, HANDOFF_LABEL] }),
        signal:  AbortSignal.timeout(10000),
      },
    );
    if (!labelRes.ok) {
      console.warn(`[agent-bot] handoff label failed (${labelRes.status}):`, await labelRes.text().catch(() => ''));
    }
  } catch (e: any) {
    console.warn('[agent-bot] handoff label error:', e?.message);
  }

  await toggleConvStatus(baseUrl, accountId, cwConvId, 'open', botToken);
  console.log(`[agent-bot] Handoff surfaced for conv cw#${cwConvId}`);
}
