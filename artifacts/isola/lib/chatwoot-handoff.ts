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
): Promise<boolean> {
  // Returns whether the toggle actually landed. It previously returned
  // `undefined` on EVERY path — success and failure alike — so no caller could
  // tell. That is the same defect as surfaceHandoff's old `void` return, one
  // level down, and it is why a handoff could fail silently in three places at
  // once while Foundation recorded success.
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
      return true;
    }
    console.warn(`[agent-bot] toggle_status failed (${res.status}):`, await res.text().catch(() => ''));
    return false;
  } catch (e: any) {
    console.warn('[agent-bot] toggle_status error:', e?.message);
    return false;
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

/**
 * What surfacing ACTUALLY achieved. Previously this function returned `void`
 * and swallowed every failure into a console warning, so the caller advanced
 * ownership to HUMAN_OWNED whether or not anything reached Chatwoot — see
 * `defect-handoff-assignment-performed-by-chatwoot-automation-not-foundation-2026-08-13`.
 *
 * `surfaced` is the honest answer to "can a person actually see this handoff",
 * and is the ONLY field a caller should gate a state transition on. The parts
 * are exposed so a caller can be more specific without re-deriving them.
 *
 * NOTE ON WHAT IS NOT HERE: there is no `assigned` field, because Foundation
 * issues no Chatwoot assignment call anywhere. The team assignment observed in
 * production is performed by Chatwoot automation rule #3 reacting to the status
 * reopen below. Do not add an `assigned` field until Foundation actually assigns.
 */
export interface HandoffSurfaceResult {
  /** A person can see this handoff in Chatwoot. Gate transitions on this. */
  surfaced:        boolean;
  /** A prior handoff was already surfaced — idempotent no-op, still visible. */
  alreadySurfaced: boolean;
  notePosted:      boolean;
  labelApplied:    boolean;
  statusOpened:    boolean;
}

export async function surfaceHandoff(
  baseUrl:   string,
  accountId: string,
  cwConvId:  number,
  botToken:  string,
  noteText:  string = '🤖 Clawith flagged this conversation for human review.',
): Promise<HandoffSurfaceResult> {
  let notePosted   = false;
  let labelApplied = false;
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
    return { surfaced: true, alreadySurfaced: true, notePosted: false, labelApplied: false, statusOpened: false };
  }

  // The label may be absent because it was never successfully written, not
  // because this is the first handoff — so check for the note itself before
  // posting another one.
  if (await hasExistingHandoffNote(baseUrl, accountId, cwConvId, botToken)) {
    console.log(`[agent-bot] Handoff note already present on conv cw#${cwConvId} — skipping duplicate`);
    return { surfaced: true, alreadySurfaced: true, notePosted: false, labelApplied: false, statusOpened: false };
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
    } else {
      notePosted = true;
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
    } else {
      labelApplied = true;
    }
  } catch (e: any) {
    console.warn('[agent-bot] handoff label error:', e?.message);
  }

  const statusOpened = await toggleConvStatus(baseUrl, accountId, cwConvId, 'open', botToken);

  // A handoff is surfaced if ANY of the three landed: the note is what a human
  // reads, the label is the fast-path gate, and the reopen is what puts it back
  // in the open queue. All three failing means nothing reached Chatwoot and no
  // person can see this conversation — the caller must NOT record HUMAN_OWNED.
  const surfaced = notePosted || labelApplied || statusOpened;
  if (surfaced) {
    console.log(`[agent-bot] Handoff surfaced for conv cw#${cwConvId}`);
  } else {
    console.error(
      `[agent-bot] HANDOFF NOT SURFACED for conv cw#${cwConvId} — note, label and status ` +
      `reopen all failed. No person can see this conversation.`,
    );
  }
  return { surfaced, alreadySurfaced: false, notePosted, labelApplied, statusOpened };
}
