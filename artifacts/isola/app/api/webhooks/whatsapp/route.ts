/**
 * WhatsApp Cloud API webhook.
 *
 * GET  — Meta challenge verification (returns hub.challenge on token match).
 * POST — Inbound message processing. Routes by phone_number_id to the correct
 *         tenant and calls the native AI agent runtime (lib/agent.ts).
 *
 * Signature verification accepts a valid HMAC-SHA256 from EITHER:
 *   • META_APP_SECRET (or META_WA_APP_SECRET) — production app
 *   • META_TEST_APP_SECRET — Meta developer test app (app id 1691114308580807)
 * Primary secret is tried first; test secret is the fallback.
 * If neither is configured the signature check is skipped in dev only.
 *
 * GET verify token: META_WA_VERIFY_TOKEN (unchanged).
 */

import crypto from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { handleInboundWhatsApp } from '@/lib/agent';
import { prisma } from '@/lib/prisma';
import { claimInboundMessageId } from '@/lib/inbound-dedup';
import type { MenuRendering } from '@/lib/staff-ops/staff-menu';

// ── Signature helpers ─────────────────────────────────────────────────────────

/** Constant-time HMAC-SHA256 check. Returns true iff sig matches. */
function verifyHmac(raw: ArrayBuffer, sig: string, secret: string): boolean {
  const expected =
    'sha256=' +
    crypto.createHmac('sha256', secret).update(Buffer.from(raw)).digest('hex');
  if (sig.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  } catch {
    return false;
  }
}

// ── GET — verification ────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const mode = searchParams.get('hub.mode');
  const token = searchParams.get('hub.verify_token');
  const challenge = searchParams.get('hub.challenge');

  const verifyToken = process.env.META_WA_VERIFY_TOKEN;
  if (!verifyToken) {
    console.error('[webhook/wa] META_WA_VERIFY_TOKEN not set');
    return new Response('Server not configured', { status: 500 });
  }
  if (mode === 'subscribe' && token === verifyToken) {
    return new Response(challenge ?? '', { status: 200 });
  }
  return new Response('Forbidden', { status: 403 });
}

// ── POST — inbound messages ────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  // Primary secret: production Meta app
  const primarySecret = process.env.META_WA_APP_SECRET ?? process.env.META_APP_SECRET;
  // Fallback secret: Meta developer test app (signed with a different app secret)
  const testSecret = process.env.META_TEST_APP_SECRET;

  const hasAnySecret = !!(primarySecret || testSecret);
  let body: unknown;

  // In production, reject webhook calls that arrive without a verified signature.
  // In development (NODE_ENV !== 'production'), allow through with a warning.
  if (!hasAnySecret && process.env.NODE_ENV === 'production') {
    console.error('[webhook/wa] No app secret configured (META_APP_SECRET / META_TEST_APP_SECRET) — rejecting in production');
    return new Response('Service not configured', { status: 503 });
  }

  if (hasAnySecret) {
    const raw = await req.arrayBuffer();
    const sig = req.headers.get('x-hub-signature-256') ?? '';

    // Try primary first
    let sigValid = primarySecret ? verifyHmac(raw, sig, primarySecret) : false;

    // Fall back to test secret ONLY when explicitly opted in via env flag.
    // This prevents the test app's secret from granting write access to
    // production webhooks unless the operator has consciously enabled it.
    if (!sigValid && testSecret && process.env.ACCEPT_TEST_WEBHOOK_SECRET === 'true') {
      sigValid = verifyHmac(raw, sig, testSecret);
      if (sigValid) {
        console.log('[webhook/wa] Signature verified via META_TEST_APP_SECRET (test fallback active)');
      }
    }

    if (!sigValid) {
      console.warn('[webhook/wa] Signature mismatch (tried all configured secrets)');
      return new Response('Unauthorized', { status: 401 });
    }
    body = JSON.parse(Buffer.from(raw).toString('utf-8'));
  } else {
    // No app secret set — dev mode, trust all incoming webhooks
    console.warn('[webhook/wa] No app secret set — skipping signature check (dev mode)');
    body = await req.json();
  }

  // Await processing before returning — on Autoscale/serverless the instance is
  // frozen immediately after the response is sent, so fire-and-forget promises
  // never complete. Meta allows several seconds; a queue is a future hardening step.
  // Always return 200 so Meta doesn't disable the webhook subscription on our errors.
  try {
    await processWebhook(body as Record<string, unknown>);
  } catch (err) {
    console.error('[webhook/wa] processing error:', err);
  }

  return NextResponse.json({ ok: true });
}

// ── Per-number ignore and status-passthrough lists ────────────────────────────
//
// Foundation and bff-v2 (EPIC_BFF) are BOTH subscribed to the same WABA, so
// Meta delivers every event to both. The two lists below govern what Foundation
// does with each phone_number_id.
//
// INBOUND MESSAGES — any number in the ignore list is acknowledged and dropped:
// no tenant resolution, no Flowise/agent invocation, no DB writes, no send.
// 1029700810228517 (Hermes 9043, +1 767-818-9043) is a HARDCODED permanent
// floor and is never solely dependent on the env var — that number leaked
// through once already because an env var was set without any code reading it.
// WEBHOOK_IGNORE_PHONE_IDS adds further ids on top but cannot remove 9043.
//
// DELIVERY-STATUS CALLBACKS — a number on the ignore list can still have its
// status events ingested by adding it to WEBHOOK_STATUS_PASSTHROUGH_PHONE_IDS.
// That env var defaults to empty, so this change turns nothing on by itself.
// A number not in the passthrough list keeps today's behaviour: all events
// (messages and statuses alike) are dropped.
//
// Cutover procedure for 9043:
//   • Inbound messages stay ignored permanently — BFF owns that path.
//   • Status callbacks: add 1029700810228517 to WEBHOOK_STATUS_PASSTHROUGH_PHONE_IDS
//     in the same owner-gated window that BFF's staff processor is disabled.
//     Never before, or both platforms will ingest the same status event.
//
// Both lists are read fresh per request so an env change takes effect on the
// next request without a code deploy.
const HERMES_9043_PHONE_NUMBER_ID = '1029700810228517';

function getIgnoredPhoneNumberIds(): Set<string> {
  const fromEnv = (process.env.WEBHOOK_IGNORE_PHONE_IDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return new Set([HERMES_9043_PHONE_NUMBER_ID, ...fromEnv]);
}

/** Phone number ids whose delivery-status callbacks are ingested even when the
 *  number is on the ignore list. Inbound messages from those numbers are still
 *  dropped. Defaults to empty. */
function getStatusPassthroughPhoneNumberIds(): Set<string> {
  return new Set(
    (process.env.WEBHOOK_STATUS_PASSTHROUGH_PHONE_IDS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

// ── Staff-operations inbound path ─────────────────────────────────────────────
//
// When a phone_number_id appears in STAFF_INBOUND_PHONE_NUMBER_IDS its inbound
// text messages are handled exclusively by the staff-operations resolution
// logic. The customer-facing agent (handleInboundWhatsApp) is NEVER called for
// these numbers — not on a recognised command, not on an unrecognised sender,
// not on an exception. Silence is the correct outcome when the staff path
// cannot resolve a message; a wrong brain replying is not.
//
// Defaults to empty: when the env var is unset, behaviour is byte-for-byte
// identical to today for every number. Read fresh per request.

function getStaffInboundPhoneNumberIds(): Set<string> {
  return new Set(
    (process.env.STAFF_INBOUND_PHONE_NUMBER_IDS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

/** Short confirmation sent back to a staff member after their action is applied. */
function buildStaffAckReply(action: string, deduped: boolean): string {
  if (deduped) return '✓ Already recorded.';
  switch (action) {
    case 'ack':     return '✓ Acknowledged.';
    case 'done':    return '✓ Done recorded.';
    case 'update':  return '✓ Update recorded.';
    case 'blocked': return '✓ Blocked status recorded.';
    case 'correct': return '✓ Correction recorded.';
    case 'start':   return '✓ Started.';
    default:        return '✓ Recorded.';
  }
}

/** Reply when the sender is a known staff member but sent help / a non-command. */
function buildStaffHelpReply(openWork: { odooId: number; label?: string; projectName?: string | null }[]): string {
  const cmds =
    'ACK — acknowledge receipt\n' +
    'START [note] — begin working (RESUME is an alias)\n' +
    'DONE [note] — mark complete\n' +
    'UPDATE <note> — progress update\n' +
    'BLOCKED <note> — report a blocker\n' +
    'CORRECT <note> — correction\n' +
    'MY TASKS — list your open tasks\n' +
    'HELP — show this list';

  if (openWork.length === 0) {
    return `Commands:\n${cmds}\n\nNo open tasks right now.`;
  }

  const taskLines = openWork.slice(0, 10).map((w, i) => {
    const label = w.label ?? '(untitled)';
    const proj  = w.projectName ? ` · ${w.projectName}` : '';
    return `${i + 1}. ${label}${proj} #${w.odooId}`;
  });
  if (openWork.length > 10) taskLines.push(`… and ${openWork.length - 10} more`);

  return `Commands:\n${cmds}\n\nYour open tasks:\n${taskLines.join('\n')}\n\nTo act: ACK #<id>  or  DONE #<id>`;
}

/**
 * Reply to MY TASKS — the open-work list on its own.
 *
 * Deliberately NOT the help text. Someone who asked what they are holding wants
 * the answer, not the command contract wrapped around it.
 */
function buildStaffTaskListReply(
  openWork: { odooId: number; label?: string; projectName?: string | null; stageName?: string | null }[],
): string {
  if (openWork.length === 0) return 'You have no open tasks right now.';

  const lines = openWork.slice(0, 10).map((w, i) => {
    const label = w.label ?? '(untitled)';
    const proj = w.projectName ? ` · ${w.projectName}` : '';
    const stage = w.stageName ? ` [${w.stageName}]` : '';
    return `${i + 1}. ${label}${proj}${stage} #${w.odooId}`;
  });
  if (openWork.length > 10) lines.push(`… and ${openWork.length - 10} more`);

  return `Your open tasks (${openWork.length}):\n${lines.join('\n')}\n\nTo act: ACK #<id>  ·  START #<id>  ·  DONE #<id>`;
}

/** Reply when the command is clear but we cannot tell which task it refers to. */
function buildStaffDisambiguationReply(action: string, candidates: { odooId: number; label?: string }[]): string {
  const list = candidates.slice(0, 10).map((c, i) => {
    const label = c.label ?? '(untitled)';
    return `${i + 1}. ${label} #${c.odooId}`;
  });
  if (candidates.length > 10) list.push(`… and ${candidates.length - 10} more`);
  return `Which task? Resend ${action.toUpperCase()} #<id>:\n${list.join('\n')}`;
}

/**
 * Reply when the sender typed a task reference we do not have on their list.
 * Shown instead of the generic command list so the person knows exactly what
 * went wrong and can immediately pick the correct id from their open work.
 */
function buildStaffUnknownRefReply(
  originalText: string,
  openWork: { odooId: number; label?: string; projectName?: string | null }[],
): string {
  // Echo back the second token (the ref they typed, e.g. "#2292" or "project.task#999").
  const ref = originalText.trim().split(/\s+/)[1] ?? '(unknown)';

  const taskLines =
    openWork.length === 0
      ? ['No open tasks right now.']
      : openWork.slice(0, 10).map((w, i) => {
          const label = w.label ?? '(untitled)';
          const proj  = w.projectName ? ` · ${w.projectName}` : '';
          return `${i + 1}. ${label}${proj} #${w.odooId}`;
        });
  if (openWork.length > 10) taskLines.push(`… and ${openWork.length - 10} more`);

  return `"${ref}" is not on your open task list.\n\nYour open tasks:\n${taskLines.join('\n')}`;
}

/** Reply when the action was recognised but could not be written to the record. */
function buildStaffApplyFailedReply(): string {
  return "⚠️ Couldn't record that — please try again.";
}

/**
 * Reply when a START/RESUME is refused (e.g. not assigned, record not found).
 * Shows the actions that ARE valid right now, derived from the Odoo record,
 * so the sender knows what they can actually do without a back-and-forth.
 */
function buildStaffInvalidStartReply(validNextActions: string[]): string {
  const actions = validNextActions.map((a) => a.toUpperCase()).join(' · ');
  return `⚠️ Can't start that task right now.\n\nValid actions: ${actions}`;
}

async function handleStaffInboundMessage(params: {
  phoneNumberId: string;
  from: string;
  body: string;
  waMessageId: string;
  /** Developer id echoed back by a menu tap, or null for a typed message. */
  tapId?: string | null;
}) {
  const { phoneNumberId, from, body, waMessageId, tapId } = params;

  // Cross-path inbound idempotency gate — must be the first operation.
  // Two Meta apps are subscribed to the same WABA, so every inbound message
  // is delivered twice. The gate claims the wamid on a unique-constrained
  // table; the second delivery finds it already claimed and returns true.
  // This is the same gate the customer-facing handler uses (lib/inbound-dedup.ts).
  if (await claimInboundMessageId(waMessageId)) {
    console.log(
      `[webhook/wa][staff] duplicate wamid=${waMessageId} sender=${from} — already claimed, dropped`,
    );
    return;
  }

  // Resolve the tenant that owns this channel.
  const channelNumber = await prisma.whatsAppNumber.findUnique({
    where: { phone_number_id: phoneNumberId },
    select: { tenant_id: true },
  });
  if (!channelNumber) {
    console.error(
      `[webhook/wa][staff] phone_number_id=${phoneNumberId} not in WhatsAppNumber — cannot resolve tenant, message dropped`,
    );
    return;
  }
  const tenantId = channelNumber.tenant_id;

  // Resolve inbound route (reads only — apply is an explicit separate step).
  //
  // A menu tap carries its own action and correlation id, so it bypasses the
  // text grammar entirely — but NOT the authority check, which is identical.
  // `decodeMenuId` fails closed: a foreign or malformed id decodes to null and
  // falls through to text resolution rather than being guessed at.
  const {
    resolveInboundStaffMessage,
    resolveInboundStaffTap,
    applyStaffAction,
    buildStaffReplyMenu,
  } = await import('@/lib/staff-ops/service');
  const { decodeMenuId } = await import('@/lib/staff-ops/staff-menu');

  const tap = decodeMenuId(tapId);
  const resolved = tap
    ? await resolveInboundStaffTap({
        waId: from,
        action: tap.action,
        correlationId: tap.correlationId,
        channelTenantId: tenantId,
      })
    : await resolveInboundStaffMessage({
        waId: from,
        text: body,
        channelTenantId: tenantId,
      });

  const r = resolved.route;

  // ── Identity failures: silence is correct, nothing to reply to. ─────────────
  if (r.route === 'exception') {
    console.error(
      `[webhook/wa][staff] unresolved phone_number_id=${phoneNumberId} sender=${from} route=exception why=${r.why} — dropped, no reply`,
    );
    return;
  }

  // ── Determine reply text for all other outcomes. ─────────────────────────────
  // The send path is shared by all three; it runs once, below.
  let replyText: string;

  // Only a successfully applied action earns a menu. It is the one outcome
  // where the record's stage may have just moved, and therefore the one where
  // the next actions are known rather than guessed.
  let replyMenu: MenuRendering = { kind: 'none' };

  if (r.route === 'staff_help') {
    console.log(
      `[webhook/wa][staff] help route phone_number_id=${phoneNumberId} sender=${from} why=${r.why} openWork=${resolved.openWork.length}`,
    );
    // unknown_reference: they typed a valid command but with a task id we don't
    // have on their list. Show a targeted message echoing the bad ref plus their
    // actual open tasks — not the generic command list, which would be noise here.
    replyText =
      r.why === 'task_list'
        ? buildStaffTaskListReply(resolved.openWork)
        : r.why === 'unknown_reference'
          ? buildStaffUnknownRefReply(body, resolved.openWork)
          : buildStaffHelpReply(resolved.openWork);

  } else if (r.route === 'staff_disambiguation') {
    console.log(
      `[webhook/wa][staff] disambiguation phone_number_id=${phoneNumberId} sender=${from} action=${r.action} candidates=${r.candidates.length}`,
    );
    replyText = buildStaffDisambiguationReply(r.action, r.candidates);

  } else {
    // staff_action — apply then decide text based on outcome.
    const applied = await applyStaffAction({
      binding:           r.binding,
      action:            r.action,
      workRefModel:      r.target.odooModel,
      workRefId:         r.target.odooId,
      correlationId:     r.target.correlationId,
      note:              r.note,
      providerMessageId: waMessageId,
      source:            'whatsapp',
    });

    if (!applied.ok) {
      console.error(
        `[webhook/wa][staff] apply failed phone_number_id=${phoneNumberId} sender=${from} action=${r.action} reason=${applied.reason}`,
      );
      // START/RESUME failures carry validNextActions derived from the Odoo
      // record so the sender learns what they can do instead of getting
      // a bare refusal.
      const validNextActions = 'validNextActions' in applied ? applied.validNextActions : undefined;
      replyText = validNextActions?.length
        ? buildStaffInvalidStartReply(validNextActions)
        : buildStaffApplyFailedReply();
    } else {
      console.log(
        `[webhook/wa][staff] applied phone_number_id=${phoneNumberId} sender=${from} action=${r.action} deduped=${applied.deduped} actionId=${applied.actionId}`,
      );
      replyText = buildStaffAckReply(r.action, applied.deduped);
      // Fresh read, after the write: a START has already moved the stage, so
      // the menu that comes back is the NEW stage's menu, not the old one's.
      replyMenu = await buildStaffReplyMenu({ binding: r.binding, target: r.target });
    }
  }

  // ── Single shared send path. ─────────────────────────────────────────────────

  // Reply with free-form text if the service window is open.
  // The inbound message itself opens/refreshes the 24-hour window, so
  // lastInboundAt = now gives age = 0 — hasOpenServiceWindow returns true.
  // Respecting the predicate regardless guards against clock skew or any
  // future change to the window rule.
  const { hasOpenServiceWindow } = await import('@/lib/staff-ops/staff-notification');
  const now = new Date();
  if (!hasOpenServiceWindow({ lastInboundAt: now, now })) {
    console.log(`[webhook/wa][staff] service window closed for sender=${from} — reply suppressed`);
    return;
  }

  // Resolve FROM number and token — mirrors the logic in notify-whatsapp.ts,
  // including the STAFF_NOTIFICATION_PHONE_NUMBER_ID pinned-number behaviour.
  // A pinned number that does not belong to this tenant is a hard stop with no
  // fallback — same rule as the drain.
  const pinnedId = process.env.STAFF_NOTIFICATION_PHONE_NUMBER_ID;
  const fromNumber = await (pinnedId
    ? prisma.whatsAppNumber.findFirst({
        where: { phone_number_id: pinnedId, tenant_id: tenantId },
        select: { phone_number_id: true, access_token: true, token_env: true },
      })
    : prisma.whatsAppNumber.findFirst({
        where: { tenant_id: tenantId },
        orderBy: { created_at: 'asc' },
        select: { phone_number_id: true, access_token: true, token_env: true },
      }));

  if (!fromNumber) {
    const why = pinnedId
      ? `STAFF_NOTIFICATION_PHONE_NUMBER_ID=${pinnedId} not found for tenant ${tenantId} — refusing to fall back`
      : `no WhatsAppNumber for tenant ${tenantId}`;
    console.error(`[webhook/wa][staff] reply suppressed — ${why}`);
    return;
  }

  const token = fromNumber.token_env
    ? process.env[fromNumber.token_env]
    : fromNumber.access_token;
  if (!token) {
    console.error(
      `[webhook/wa][staff] reply suppressed — no token for phone_number_id=${fromNumber.phone_number_id} tenant=${tenantId}`,
    );
    return;
  }

  const { sendText, sendInteractiveButtons, sendInteractiveList } = await import('@/engines/whatsapp');
  const { getWhatsAppConfig } = await import('@/lib/engines');
  const waConfig = getWhatsAppConfig();
  const sendCtx = {
    phoneId: fromNumber.phone_number_id,
    token,
    to: from.replace(/^\+/, ''), // Meta expects E.164 digits without '+'
  };

  // Interactive when there is a menu, plain text otherwise.
  let replyResult =
    replyMenu.kind === 'buttons'
      ? await sendInteractiveButtons(waConfig, {
          ...sendCtx,
          body: replyText,
          buttons: replyMenu.items.map((i) => ({ id: i.id, title: i.title })),
        })
      : replyMenu.kind === 'list'
        ? await sendInteractiveList(waConfig, {
            ...sendCtx,
            body: replyText,
            buttonText: 'Choose action',
            rows: replyMenu.items.map((i) => ({
              id: i.id,
              title: i.title,
              description: i.description,
            })),
          })
        : await sendText(waConfig, { ...sendCtx, body: replyText });

  // A menu problem must never cost the staff member their confirmation — the
  // text is the part that carries the fact, so it is the floor, not the extra.
  if (!replyResult.ok && replyMenu.kind !== 'none') {
    console.error(
      `[webhook/wa][staff] interactive reply failed kind=${replyMenu.kind} sender=${from} status=${replyResult.status} error=${replyResult.error} — falling back to text`,
    );
    replyResult = await sendText(waConfig, { ...sendCtx, body: replyText });
  }

  if (!replyResult.ok) {
    console.error(
      `[webhook/wa][staff] reply failed phone_number_id=${fromNumber.phone_number_id} sender=${from} status=${replyResult.status} error=${replyResult.error}`,
    );
  } else {
    console.log(
      `[webhook/wa][staff] reply sent phone_number_id=${fromNumber.phone_number_id} sender=${from} wamid=${replyResult.messageId}`,
    );
  }
}

async function processWebhook(body: Record<string, unknown>) {
  const entries = (body?.entry as any[]) ?? [];
  const ignoredPhoneNumberIds = getIgnoredPhoneNumberIds();

  for (const entry of entries) {
    for (const change of (entry.changes as any[]) ?? []) {
      if (change.field !== 'messages') continue;

      const value = change.value as Record<string, any>;
      const phoneNumberId: string = value?.metadata?.phone_number_id ?? '';

      // Ignore guard — filtered per-change so a batched webhook containing
      // both an ignored and an allowed change still processes the allowed one.
      //
      // "Ignored" means "not handled by the customer-facing agent". It does NOT
      // mean "silently discarded in all cases". Two explicit redirections can
      // keep a change alive past this guard:
      //
      //   • WEBHOOK_STATUS_PASSTHROUGH_PHONE_IDS — delivery-status callbacks for
      //     this number are ingested by Foundation even though its inbound
      //     messages are not owned here.
      //   • STAFF_INBOUND_PHONE_NUMBER_IDS — inbound messages are redirected to
      //     the staff-operations handler. This is NOT a hole in the ignore rule:
      //     the staff handler is a completely different destination, not the
      //     customer agent. The customer agent is permanently unreachable for any
      //     ignored number regardless of which other lists it appears in.
      //
      // A change that qualifies for neither redirection is fully dropped here.
      // See the block comment above for the cutover procedure for each list.
      const isIgnored = !!(phoneNumberId && ignoredPhoneNumberIds.has(phoneNumberId));
      const isStaffInbound = !!(phoneNumberId && getStaffInboundPhoneNumberIds().has(phoneNumberId));
      if (isIgnored) {
        const hasStatuses = Array.isArray(value?.statuses) && value.statuses.length > 0;
        const statusPassthrough = hasStatuses && getStatusPassthroughPhoneNumberIds().has(phoneNumberId);
        if (!statusPassthrough && !isStaffInbound) {
          console.log('[webhook/wa] ignore-phone-id', phoneNumberId, '— acknowledged, zero downstream processing (not owned by Foundation)');
          continue;
        }
        // At least one redirection is active — fall through. The status block
        // below is guarded so it only fires when statusPassthrough is active,
        // preventing staff-inbound membership from accidentally enabling status
        // ingestion. The second guard below ensures messages never reach the
        // customer agent regardless of which lists the number is on.
      }

      // ── Wave 1: delivery-status callbacks ────────────────────────────────
      //
      // Meta delivers `statuses` on the same `messages` field as inbound
      // messages. Foundation previously read only `messages` and dropped every
      // status on the floor — which is the same shape of gap that let a failed
      // send keep reading as though it had gone out.
      if (Array.isArray(value?.statuses) && value.statuses.length > 0 &&
          (!isIgnored || getStatusPassthroughPhoneNumberIds().has(phoneNumberId))) {
        try {
          const { ingestDeliveryStatuses } = await import('@/lib/staff-ops/status-ingest');
          const { createStatusIngestPorts } = await import('@/lib/staff-ops/status-ingest-ports');
          const outcome = await ingestDeliveryStatuses(
            { entry: [{ changes: [{ field: 'messages', value: { statuses: value.statuses } }] }] },
            createStatusIngestPorts(),
          );
          console.log(
            `[webhook/wa][status] phone_number_id=${phoneNumberId} events=${outcome.events} applied=${outcome.applied} ignored=${outcome.ignored} unmatched=${outcome.unmatched}`,
          );
        } catch (err) {
          // A status-ingestion failure must not stop inbound messages in the
          // same batch from being processed.
          console.error('[webhook/wa][status] ingestion error:', err);
        }
      }

      // Inbound messages from an ignored number never reach the customer agent.
      // Staff-inbound numbers are exempt from this drop — their messages
      // continue to the staff routing block below, which is the only other
      // destination. The customer agent remains unreachable for all ignored
      // numbers regardless of staff-inbound membership.
      if (isIgnored && !isStaffInbound) continue;

      const messages: any[] = value?.messages ?? [];

      // Staff-operations path — mutually exclusive with the customer-agent
      // path below. A number in STAFF_INBOUND_PHONE_NUMBER_IDS NEVER reaches
      // handleInboundWhatsApp. The explicit `continue` below is the hard
      // barrier; it is there intentionally and must not be removed.
      if (phoneNumberId && getStaffInboundPhoneNumberIds().has(phoneNumberId)) {
        for (const msg of messages) {
          // A menu tap arrives as type `interactive`, echoing back the
          // developer id minted in the menu. Extract it here and let it
          // through.
          //
          // NOTE THE ORDER. This block does NOT act on the tap — it only
          // classifies it. The cross-path idempotency gate inside
          // handleStaffInboundMessage still runs first, because a tap carries
          // a wamid like any other inbound and two Meta apps remain subscribed
          // to this WABA, so taps are delivered twice as well. Branching to a
          // handler ahead of that gate would reproduce cutover defect 4 on the
          // exact number where it was already solved once.
          const tapId =
            msg.type === 'interactive'
              ? String(
                  msg.interactive?.button_reply?.id ??
                    msg.interactive?.list_reply?.id ??
                    '',
                )
              : '';

          if (msg.type !== 'text' && !tapId) {
            console.log('[webhook/wa][staff] ignoring non-actionable message type:', msg.type);
            continue;
          }

          await handleStaffInboundMessage({
            phoneNumberId,
            from: String(msg.from ?? ''),
            body: String(msg.text?.body ?? ''),
            waMessageId: String(msg.id ?? ''),
            tapId: tapId || null,
          });
        }
        continue; // hard barrier — never fall through to customer-agent path
      }

      for (const msg of messages) {
        // Only handle text messages in Build 1
        if (msg.type !== 'text') {
          console.log('[webhook/wa] Ignoring non-text message type:', msg.type);
          continue;
        }
        await handleInboundWhatsApp({
          phoneNumberId,
          from: String(msg.from ?? ''),
          body: String(msg.text?.body ?? ''),
          waMessageId: String(msg.id ?? ''),
        });
      }
    }
  }
}
