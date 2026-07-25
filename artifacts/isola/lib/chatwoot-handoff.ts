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
 *
 * `noteText` defaults to the generic needs_handoff wording above; callers with
 * a more specific reason (e.g. the governed escalate_to_human endpoint) may
 * override it. This never changes the single-fire gate itself — if the
 * ai-handoff label is already present (from an earlier call, with either
 * note), this still no-ops.
 */
export const HANDOFF_LABEL = 'ai-handoff';

/**
 * Openings that identify a handoff note we have already posted. The card
 * wording (lib/escalation-card.ts) comes first; the legacy fixed string is
 * kept so notes written before the card existed still suppress a duplicate.
 */
export const HANDOFF_NOTE_MARKERS = [
  '🔔 **Human help needed**',
  '🤖 Clawith flagged',
] as const;

/**
 * Second line of defence for the single-fire gate.
 *
 * The label-based gate only works if the label WRITE succeeds, and it silently
 * did not: no `ai-handoff` tag exists on the live instance, while conversation
 * 156 accumulated six identical handoff notes in a single day. Gating on a
 * write we never verified meant the P1 this function documents as fixed was
 * still live.
 *
 * Fails OPEN on any error. If we cannot determine whether a note exists, we
 * surface anyway: a duplicate note is noise, but a handoff that never reaches
 * a human is a customer waiting on nobody.
 */
async function hasExistingHandoffNote(
  baseUrl:   string,
  accountId: string,
  cwConvId:  number,
  botToken:  string,
): Promise<boolean> {
  try {
    const res = await fetch(
      `${baseUrl}/api/v1/accounts/${accountId}/conversations/${cwConvId}/messages`,
      { headers: { api_access_token: botToken }, signal: AbortSignal.timeout(10000) },
    );
    if (!res.ok) return false;
    const payload = (await res.json().catch(() => ({})))?.payload;
    if (!Array.isArray(payload)) return false;
    return payload.some(
      (m: any) =>
        m?.private === true &&
        typeof m?.content === 'string' &&
        HANDOFF_NOTE_MARKERS.some((marker) => m.content.startsWith(marker)),
    );
  } catch (e: any) {
    console.warn('[agent-bot] handoff note lookup error:', e?.message);
    return false;
  }
}

export async function surfaceHandoff(
  baseUrl:   string,
  accountId: string,
  cwConvId:  number,
  botToken:  string,
  noteText:  string = '🤖 Clawith flagged this conversation for human review.',
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

  // The label may be absent because it was never successfully written, not
  // because this is the first handoff — so check for the note itself before
  // posting another one.
  if (await hasExistingHandoffNote(baseUrl, accountId, cwConvId, botToken)) {
    console.log(`[agent-bot] Handoff note already present on conv cw#${cwConvId} — skipping duplicate`);
    return;
  }

  try {
    const noteRes = await fetch(
      `${baseUrl}/api/v1/accounts/${accountId}/conversations/${cwConvId}/messages`,
      {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', api_access_token: botToken },
        body:    JSON.stringify({
          content:      noteText,
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
      // Loud, not a warn: a failed label write is what let the duplicate-note
      // P1 stay live while appearing fixed. The note-presence check above is
      // now the real gate, but this must never fail quietly again.
      console.error(
        `[agent-bot] handoff label WRITE FAILED (${labelRes.status}) for conv cw#${cwConvId} — ` +
        `the '${HANDOFF_LABEL}' fast-path gate will not engage for this conversation:`,
        await labelRes.text().catch(() => ''),
      );
    }
  } catch (e: any) {
    console.warn('[agent-bot] handoff label error:', e?.message);
  }

  await toggleConvStatus(baseUrl, accountId, cwConvId, 'open', botToken);
  console.log(`[agent-bot] Handoff surfaced for conv cw#${cwConvId}`);
}
