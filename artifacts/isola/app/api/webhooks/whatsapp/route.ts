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
import {
  buildStaffNoteFlow,
  isTextBearingAction,
  type StaffFlowPrompt,
} from '@/lib/staff-ops/staff-flow';

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
function buildStaffAckReply(
  action: string,
  deduped: boolean,
  odooResult?: Record<string, unknown> | null,
): string {
  if (deduped) return '✓ Already recorded.';
  switch (action) {
    case 'ack':     return '✓ Acknowledged.';
    case 'done':    return '✓ Done recorded.';
    case 'update':  return '✓ Update recorded.';
    case 'blocked': return '✓ Blocked status recorded.';
    case 'correct': return '✓ Correction recorded.';
    case 'start':   return buildStartReply(odooResult);
    default:        return '✓ Recorded.';
  }
}

/**
 * START must never claim a transition that did not happen.
 *
 * The live round on 2026-07-29 replied "✓ Started." while Odoo task 2292 stayed
 * in `In Development`, because the configured stage name did not exist on that
 * board. The chatter note was true; the stage sentence was not. This reads
 * `stageMove` and says only what actually occurred.
 */
function buildStartReply(odooResult?: Record<string, unknown> | null): string {
  const move = (odooResult?.stageMove ?? null) as
    | { moved?: boolean; noop?: boolean; stageName?: string }
    | null;

  if (!move?.moved) return '✓ Started — logged on the task.';

  const stage = move.stageName ? ` ${move.stageName}` : ' the active stage';
  return move.noop ? `✓ Started — already in${stage}.` : `✓ Started — moved to${stage}.`;
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

/**
 * The sentence above the form.
 *
 * Says what is being asked and NOTHING about what has been recorded, because
 * at this point nothing has been: the action applies when the form comes back,
 * not when the button was tapped. A message here reading "Blocked" would be the
 * same defect class as reporting a stage move that did not happen.
 */
function buildStaffFlowPromptReply(action: string): string {
  switch (action) {
    case 'blocked':
      return 'Tap below and tell me what the blocker is — the task is not flagged until you send it.';
    case 'done':
      return 'Tap below and tell me what the result was — it goes to your manager for verification.';
    case 'update':
      return 'Tap below and write your update.';
    default:
      return 'Tap below to add the detail.';
  }
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

/**
 * Normalise every shape a staff TAP can arrive in to one developer-defined id.
 *
 * Three envelopes, one fact:
 *   • `interactive.button_reply.id` — free-form inline buttons (24h window)
 *   • `interactive.list_reply.id`   — free-form list rows      (24h window)
 *   • `button.payload`              — a TEMPLATE quick reply
 *
 * The third is the one that was silently dropped. A template quick-reply tap
 * does not arrive as `interactive.button_reply`, so interactive-only
 * extraction let it fall into the non-text guard and die there — which is why
 * `isola_staff_task_v1` was deliberately submitted text-only. Normalising here
 * rather than branching to a second handler is the point: one dedup gate, one
 * resolver, one authority check, one reply.
 *
 * `msg.button.text` is deliberately NOT used as a fallback command. The whole
 * value of a developer-defined id is that the tapped path never does label
 * matching; treating a visible label as typed text would reintroduce exactly
 * the ambiguity the id was minted to remove — and template labels are frozen
 * copy an approver chose, not a command vocabulary this system controls. A
 * payload that will not decode falls through to text resolution with an empty
 * body and earns help, which is the honest answer, rather than a guess.
 */
function extractStaffTapId(msg: any): string {
  if (msg?.type === 'interactive') {
    // A COMPLETED FLOW is a fourth envelope for the same fact. Its
    // `flow_token` is the very id `buildStaffNoteFlow` minted — the same
    // `encodeMenuId` string a button tap would have carried — so normalising
    // it here means a Flow completion resolves through `decodeMenuId`,
    // `resolveInboundStaffTap` and the authority check with no new branch
    // anywhere downstream. The only thing a Flow adds is the note, extracted
    // separately by `extractStaffFlowNote`.
    if (msg.interactive?.type === 'nfm_reply') {
      const parsed = parseFlowResponseJson(msg);
      return typeof parsed?.flow_token === 'string' ? parsed.flow_token : '';
    }
    return String(msg.interactive?.button_reply?.id ?? msg.interactive?.list_reply?.id ?? '');
  }
  if (msg?.type === 'button') {
    return String(msg.button?.payload ?? '');
  }
  return '';
}

/**
 * `nfm_reply.response_json` is a STRINGIFIED JSON blob, not an object.
 * Parsing it is not optional, and it is user-influenced data arriving over a
 * webhook, so every malformed shape resolves to null rather than throwing
 * inside the message loop.
 */
function parseFlowResponseJson(msg: any): Record<string, unknown> | null {
  const raw = msg?.interactive?.nfm_reply?.response_json;
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * The words the tap could not carry.
 *
 * Whitespace-only is treated as absent: a form submitted with three spaces in
 * it is not a blocker reason, and recording it as one would put an empty line
 * in front of a manager who has to decide something.
 */
function extractStaffFlowNote(msg: any): string | null {
  const note = parseFlowResponseJson(msg)?.note;
  return typeof note === 'string' && note.trim() ? note.trim() : null;
}

/**
 * The ONE outbound path for the staff WhatsApp channel.
 *
 * Extracted verbatim out of `handleStaffInboundMessage` so that a second caller
 * — the manager-verification notice — cannot become a second send path. Two
 * send paths is how "exactly one reply" quietly becomes two, and that is the
 * defect class this packet exists to eliminate. The alternative considered and
 * rejected was duplicating these ~90 lines at the manager call site.
 *
 * REACTIVE vs PROACTIVE (fixes a real defect: this function used to hardcode
 * `lastInboundAt: now` for every caller, i.e. treat EVERY recipient's window
 * as open — correct for a reactive reply, silently wrong for a proactive
 * send to a THIRD PARTY who has not themselves just written in):
 *   - `proactive` unset/false (the default; every reply-to-sender call site):
 *     the inbound message that triggered this whole request just opened this
 *     recipient's window, so `lastInboundAt: now` is not a hardcoded lie here
 *     — it is the real, current fact. Goes out free-form/interactive exactly
 *     as before.
 *   - `proactive: true` (currently only `notifyAdminOfUnknownStaffSender`):
 *     the recipient has not messaged us in this request, so there is no real
 *     inbound time to check, and `decideDispatchMode` (see
 *     staff-notification.ts) makes proactive sends ALWAYS a template — not
 *     because the window happens to be closed, but because window state
 *     inferred from our own possibly-stale records is never a safe basis for
 *     guessing "proactive but free-form is fine". Requires a caller-supplied
 *     `params.template` — there is deliberately NO default template. Reusing
 *     `epic_internal_task_v1` (the one approved template this codebase already
 *     sends proactively, via `dispatchWorkToStaff`) is NOT a safe generic
 *     fallback: its approved body is hard-committed to "Reply: ACK {{1}} /
 *     START {{1}} / DONE {{1}} <result> ...", which is correct for a real
 *     task dispatch and actively misleading for anything else. A proactive
 *     call with no matching template is refused and logged rather than
 *     risking either a silent Meta 131047 (free-form outside the 24h window:
 *     Graph still answers HTTP 200, the failure arrives later on the async
 *     status webhook) or a confusing wrong-template send.
 *
 * Other behaviour is unchanged from the inline version:
 *   - a pinned STAFF_NOTIFICATION_PHONE_NUMBER_ID that does not belong to this
 *     tenant is still a hard stop with NO fallback, same rule as the drain;
 *   - a failed interactive send still falls back to plain text, because the
 *     text is the part that carries the fact — the menu is the extra.
 *
 * `to` is the Meta sender id exactly as it arrived; the '+' strip happens here,
 * as it did before, so callers never have to remember it.
 */
async function sendStaffChannelReply(params: {
  tenantId: string;
  to: string;
  text: string;
  menu: MenuRendering;
  proactive?: boolean;
  /** Required when `proactive` is true — see decideDispatchMode above. */
  template?: { name: string; params: string[] };
  /**
   * When present this reply OPENS A FORM instead of offering a menu. Routed
   * through this function rather than a second sender for the reason stated
   * above: two send paths is how "exactly one reply" quietly becomes two.
   *
   * Only meaningful on the reactive path. A free-form `interactive` message
   * needs an open 24-hour window, and the template branch below returns before
   * this is ever read — a proactive caller passing a flow gets the template, not
   * a silent 131047.
   */
  flow?: StaffFlowPrompt | null;
}): Promise<void> {
  const { tenantId, to, text, menu, proactive = false } = params;

  const { decideDispatchMode } = await import('@/lib/staff-ops/staff-notification');
  const now = new Date();
  // Reactive: the inbound that triggered this call is the real lastInboundAt.
  // Proactive: there is no real signal, so `null` — decideDispatchMode does
  // not use it for the proactive branch (always template), but passing the
  // honest value keeps this call site truthful rather than reusing `now` for
  // a recipient who has not written in.
  const decision = decideDispatchMode({
    proactive,
    window: { lastInboundAt: proactive ? null : now, now },
  });

  if (decision.mode === 'template') {
    if (!params.template) {
      // Deliberately no default template. `epic_internal_task_v1`'s approved
      // body is hard-committed to "Reply: ACK {{1}} / START {{1}} / DONE
      // {{1}} ..." — correct for a real task dispatch (dispatchWorkToStaff),
      // actively misleading for anything else. A caller-supplied template is
      // the only way this branch sends; otherwise it refuses and logs rather
      // than risking either a silent Meta 131047 or a confusing message.
      console.error(
        `[webhook/wa][staff] proactive send to=${to} tenant=${tenantId} why=${decision.why} has no template — refused`,
      );
      return;
    }
    await sendStaffTemplate({ tenantId, to, template: params.template.name, params: params.template.params });
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

  const { sendText, sendInteractiveButtons, sendInteractiveList, sendInteractiveFlow } =
    await import('@/engines/whatsapp');
  const { getWhatsAppConfig } = await import('@/lib/engines');
  const waConfig = getWhatsAppConfig();
  const sendCtx = {
    phoneId: fromNumber.phone_number_id,
    token,
    to: to.replace(/^\+/, ''), // Meta expects E.164 digits without '+'
  };

  // A form when one is asked for, interactive when there is a menu, plain text
  // otherwise.
  let replyResult = params.flow
    ? await sendInteractiveFlow(waConfig, {
        ...sendCtx,
        body: text,
        flowId: params.flow.flowId,
        flowToken: params.flow.flowToken,
        cta: params.flow.cta,
        screen: params.flow.screen,
        data: params.flow.data,
      })
    : menu.kind === 'buttons'
      ? await sendInteractiveButtons(waConfig, {
          ...sendCtx,
          body: text,
          buttons: menu.items.map((i) => ({ id: i.id, title: i.title })),
        })
      : menu.kind === 'list'
        ? await sendInteractiveList(waConfig, {
            ...sendCtx,
            body: text,
            buttonText: 'Choose action',
            rows: menu.items.map((i) => ({
              id: i.id,
              title: i.title,
              description: i.description,
            })),
          })
        : await sendText(waConfig, { ...sendCtx, body: text });

  // A menu problem must never cost the staff member their confirmation — the
  // text is the part that carries the fact, so it is the floor, not the extra.
  if (!replyResult.ok && (params.flow || menu.kind !== 'none')) {
    console.error(
      `[webhook/wa][staff] interactive reply failed kind=${params.flow ? 'flow' : menu.kind} sender=${to} status=${replyResult.status} error=${replyResult.error} — falling back to text`,
    );
    replyResult = await sendText(waConfig, { ...sendCtx, body: text });
  }

  if (!replyResult.ok) {
    console.error(
      `[webhook/wa][staff] reply failed phone_number_id=${fromNumber.phone_number_id} sender=${to} status=${replyResult.status} error=${replyResult.error}`,
    );
  } else {
    console.log(
      `[webhook/wa][staff] reply sent phone_number_id=${fromNumber.phone_number_id} sender=${to} wamid=${replyResult.messageId}`,
    );
  }
}

/**
 * The template-send half of the staff channel, split out from the free-form
 * half above so `sendStaffChannelReply` reads as one decision (mode) plus two
 * short sends, not one function that does both under one branch. Mirrors the
 * FROM-number/token resolution exactly — same pinned-number rule, same
 * failure logging shape — because a proactive send that can't resolve a FROM
 * number is exactly as much a hard stop as a reactive one.
 */
async function sendStaffTemplate(params: {
  tenantId: string;
  to: string;
  template: string;
  params: string[];
}): Promise<void> {
  const { tenantId, to, template, params: templateParams } = params;

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
    console.error(`[webhook/wa][staff] template send suppressed — ${why}`);
    return;
  }

  const token = fromNumber.token_env
    ? process.env[fromNumber.token_env]
    : fromNumber.access_token;
  if (!token) {
    console.error(
      `[webhook/wa][staff] template send suppressed — no token for phone_number_id=${fromNumber.phone_number_id} tenant=${tenantId}`,
    );
    return;
  }

  const { sendTemplate } = await import('@/engines/whatsapp');
  const { getWhatsAppConfig } = await import('@/lib/engines');
  const result = await sendTemplate(getWhatsAppConfig(), {
    phoneId: fromNumber.phone_number_id,
    token,
    to: to.replace(/^\+/, ''),
    name: template,
    language: 'en_US',
    params: templateParams,
  });

  if (!result.ok) {
    console.error(
      `[webhook/wa][staff] template send failed phone_number_id=${fromNumber.phone_number_id} to=${to} template=${template} status=${result.status} error=${result.error}`,
    );
  } else {
    console.log(
      `[webhook/wa][staff] template sent phone_number_id=${fromNumber.phone_number_id} to=${to} template=${template} wamid=${result.messageId}`,
    );
  }
}

/**
 * Reply to a manager whose verdict was refused.
 *
 * Refusals are told plainly. A manager who taps a stale button and gets silence
 * assumes it worked; a manager who is told "already resolved" goes and looks.
 * Identity failures are handled separately and stay silent — there is nobody we
 * can safely reply to.
 */
function buildManagerRefusalReply(refusal: string): string {
  switch (refusal) {
    case 'not_a_manager':
      return '⚠️ You are not set up to verify work. Ask the owner if that is wrong.';
    case 'activity_not_open':
      // Odoo removes a completed mail.activity, so "already resolved" and
      // "never existed" are indistinguishable. Say both rather than guess.
      return '⚠️ That verification is already resolved, or is no longer open.';
    case 'not_this_manager':
      return '⚠️ That verification belongs to another manager.';
    case 'wrong_object':
      return '⚠️ That verification is not attached to a task this system can act on.';
    default:
      return '⚠️ Could not action that.';
  }
}

/**
 * A verdict reply must never read stronger than what Odoo actually holds.
 *
 * `stage.stageNameAfter` is the POST-WRITE readback, so it is preferred over
 * the stage we asked for. When the move did not happen, or the readback could
 * not confirm it, the sentence says so instead of naming a stage. This is the
 * same rule as `buildStartReply` and it exists for the same reason:
 * `def-spine-start-reports-started-without-odoo-stage-move-2026-07-29`.
 */
function buildManagerVerdictReply(
  verdict: 'approve' | 'return',
  result: { ok: boolean; detail?: unknown },
): string {
  const verb = verdict === 'approve' ? '✓ Approved' : '↩️ Returned for rework';

  if (!result.ok) {
    return `⚠️ Could not record that verdict — nothing changed in Odoo. Please try again.`;
  }

  const stage = ((result.detail as any)?.stage ?? null) as
    | { moved?: boolean; stageName?: string; stageNameAfter?: string | null; readbackOk?: boolean }
    | null;

  if (!stage?.moved) return `${verb} — recorded on the task.`;
  if (stage.readbackOk === false) {
    return `${verb} — recorded, but the board could not be re-read to confirm the stage.`;
  }
  const name = stage.stageNameAfter ?? stage.stageName;
  return name ? `${verb} — moved to ${name}.` : `${verb} — recorded on the task.`;
}

/**
 * Handle a manager's Approve / Return tap.
 *
 * NOT a second webhook processor. It is reached from inside
 * `handleStaffInboundMessage`, AFTER the cross-path wamid dedup claim and after
 * tenant resolution, and it replies through the same `sendStaffChannelReply`
 * every staff reply uses. One gate, one send, one reply.
 *
 * No menu comes back with a verdict: the episode is over for this manager, and
 * offering Approve again on work already approved is the same class of defect
 * as advertising a command the system cannot honour.
 */
async function handleManagerVerdictTap(params: {
  phoneNumberId: string;
  from: string;
  tenantId: string;
  verdict: 'approve' | 'return';
  activityId: number;
}): Promise<void> {
  const { phoneNumberId, from, tenantId, verdict, activityId } = params;
  const { resolveInboundManagerTap, applyManagerVerdict } = await import('@/lib/staff-ops/service');

  const resolved = await resolveInboundManagerTap({
    waId: from,
    verdict,
    activityId,
    channelTenantId: tenantId,
  });

  if (!resolved.ok) {
    if (resolved.refusal === 'identity') {
      // Same rule as the staff path: an unresolved sender gets no reply,
      // because we cannot vouch for who would receive it.
      console.error(
        `[webhook/wa][manager] unresolved sender=${from} phone_number_id=${phoneNumberId} why=${resolved.why} — dropped, no reply`,
      );
      return;
    }
    console.log(
      `[webhook/wa][manager] refused sender=${from} activity=${activityId} refusal=${resolved.refusal}`,
    );
    await sendStaffChannelReply({
      tenantId,
      to: from,
      text: buildManagerRefusalReply(resolved.refusal),
      menu: { kind: 'none' },
    });
    return;
  }

  const result = await applyManagerVerdict({
    manager: resolved.binding,
    activityId,
    approved: verdict === 'approve',
    taskId: resolved.taskId,
  });

  console.log(
    `[webhook/wa][manager] verdict=${verdict} sender=${from} activity=${activityId} task=${resolved.taskId} ok=${result.ok}`,
  );

  await sendStaffChannelReply({
    tenantId,
    to: from,
    text: buildManagerVerdictReply(verdict, result),
    menu: { kind: 'none' },
  });
}

/**
 * Alert the tenant owner that an unenrolled number messaged the internal
 * staff line, at most once per sender per UTC day.
 *
 * Lives here, not in lib/staff-ops/staff-notification.ts: it needs
 * `sendStaffChannelReply` and `prisma`, both already in scope in this route
 * file, and a lib module cannot import from a Next.js route handler.
 * staff-notification.ts keeps `unknownSenderAlertDedupeKey` as the pure part
 * of this contract.
 *
 * Proactive (see sendStaffChannelReply's doc comment): the owner has not
 * messaged us in this request, so `decideDispatchMode` always requires a
 * template — and deliberately none is supplied. There is no approved
 * template for "a stranger messaged the staff line", and `epic_internal_task_v1`
 * is not a safe generic substitute (its body tells the reader to text staff
 * commands). No template means this refuses and logs instead of sending
 * something wrong; the reactive reply to the unknown sender themselves is
 * unaffected and always goes out.
 */
async function notifyAdminOfUnknownStaffSender(params: {
  tenantId: string;
  waId: string;
  why: string;
}): Promise<void> {
  const { tenantId, waId, why } = params;

  const { unknownSenderAlertDedupeKey } = await import('@/lib/staff-ops/staff-notification');
  const utcDate = new Date().toISOString().slice(0, 10);
  const dedupeKey = unknownSenderAlertDedupeKey(waId, utcDate);

  // Reuses the wamid idempotency table as a generic claim store — any string
  // is a valid key, not just a Meta message id (see lib/inbound-dedup.ts).
  if (await claimInboundMessageId(dedupeKey)) {
    console.log(`[webhook/wa][staff] unknown-sender alert already sent today for waId=${waId} tenant=${tenantId}`);
    return;
  }

  const owner = await prisma.staffBinding.findFirst({
    where: { tenant_id: tenantId, role: 'owner', active: true, wa_id: { not: null } },
    select: { wa_id: true, display_name: true },
  });
  if (!owner?.wa_id) {
    console.error(
      `[webhook/wa][staff] unknown-sender waId=${waId} tenant=${tenantId} why=${why} — no reachable owner binding, alert not delivered`,
    );
    return;
  }

  console.log(
    `[webhook/wa][staff] notifying owner=${owner.wa_id} of unknown sender waId=${waId} tenant=${tenantId} why=${why}`,
  );
  // proactive: true, no template — see the doc comment above.
  await sendStaffChannelReply({
    tenantId,
    to: owner.wa_id,
    text: `An unrecognized number messaged the internal EPIC line (9043): +${waId} (${why}). If this is a new hire, add their WhatsApp binding.`,
    menu: { kind: 'none' },
    proactive: true,
  });
}

async function handleStaffInboundMessage(params: {
  phoneNumberId: string;
  from: string;
  body: string;
  waMessageId: string;
  /** Developer id echoed back by a menu tap, or null for a typed message. */
  tapId?: string | null;
  /** Free text typed into a WhatsApp Flow form, or null for anything else. */
  flowNote?: string | null;
}) {
  const { phoneNumberId, from, body, waMessageId, tapId } = params;
  const flowNote = params.flowNote ?? null;

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

  // ── Manager verdict ────────────────────────────────────────────────────────
  //
  // A manager verdict is a different vocabulary (`mv:`) naming a different Odoo
  // object (a verification activity, not a work episode) under a different
  // authority rule, so it decodes separately. It is NOT a separate processor:
  // the cross-path wamid dedup claim above has already run, the tenant is
  // already resolved, and the reply leaves through the same send helper as
  // every staff reply. `decodeManagerVerdictId` fails closed, so a staff id or
  // a foreign payload falls straight through to the staff path below.
  const { decodeManagerVerdictId } = await import('@/lib/staff-ops/manager-verdict');
  const verdictTap = decodeManagerVerdictId(tapId);
  if (verdictTap) {
    await handleManagerVerdictTap({
      phoneNumberId,
      from,
      tenantId,
      verdict: verdictTap.verdict,
      activityId: verdictTap.activityId,
    });
    return;
  }

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

  // ── Identity failures ──────────────────────────────────────────────────────
  //
  // Fail closed on DATA: no EPIC work, no names, no record ids, no routing to
  // the customer inbox. But not silence — an unenrolled number messaging the
  // internal line and hearing nothing back looks identical to a broken
  // system, and that is how staff stop trying.
  //
  // The reply is deliberately contentless: it confirms the number is not
  // enrolled and says an administrator has been told. It leaks nothing about
  // whether EPIC exists, who works here or what is in Odoo. Applies uniformly
  // to all four exception reasons (unknown_sender, inactive_binding,
  // ambiguous_binding, cross_tenant) — none of them earns a data-bearing
  // reply, and ambiguous/cross_tenant are exactly the cases an operator most
  // needs the admin alert for.
  if (r.route === 'exception') {
    console.error(
      `[webhook/wa][staff] unresolved phone_number_id=${phoneNumberId} sender=${from} route=exception why=${r.why} — no data returned`,
    );

    await notifyAdminOfUnknownStaffSender({ tenantId, waId: from, why: r.why });

    await sendStaffChannelReply({
      tenantId,
      to: from,
      text:
        'This is an internal EPIC line. This number is not enrolled, so I ' +
        'cannot share anything here. An administrator has been notified. If ' +
        'you are EPIC staff, ask for your WhatsApp number to be added.',
      menu: { kind: 'none' },
    });
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

    if (r.why === 'task_list') {
      // A direct request for the list. Answer it directly; do not spend a
      // Hermes turn rendering something Foundation already knows exactly.
      replyText = buildStaffTaskListReply(resolved.openWork);

    } else if (r.why === 'unknown_reference') {
      // They typed a valid command but with a task id we don't have on their
      // list. Show a targeted message echoing the bad ref plus their actual
      // open tasks — not the generic command list, which would be noise here.
      replyText = buildStaffUnknownRefReply(body, resolved.openWork);

    } else if (r.why === 'explicit_help') {
      // A direct request for the command list. Direct answer, same reasoning
      // as task_list above.
      replyText = buildStaffHelpReply(resolved.openWork);

    } else {
      // ── FREE-FORM. This is the INTERNAL CLAWITH DOMAIN door. ───────────
      //
      // `non_command` and `no_open_work` mean the grammar found nothing to
      // apply. That is not a failure — it is the ordinary case of a person
      // talking. Identity is already resolved and authenticated above; the
      // binding, not the text, decides who this is and what they may see.
      //
      // Structured messages NEVER reach here. ACK / START / DONE, menu taps,
      // Flow completions and manager Approve / Return are all resolved and
      // returned before this branch, and they stay Foundation-authoritative.
      // Only authenticated free-form reaches the runtime.
      //
      // The binding is resolved with NO DEFAULTS: tenant, domain, workspace,
      // agent, number, role and permitted tools must every one be present or
      // this refuses. A refusal is not a degraded answer — the staff member
      // gets the structured path, which still works, rather than a turn from
      // an agent nobody bound.
      const { resolveInternalDomainBinding } = await import('@/lib/staff-ops/internal-domain');
      const { runStaffRuntimeTurn } = await import('@/lib/staff-ops/staff-runtime-bridge');

      const domain = resolveInternalDomainBinding({
        tenantId,
        binding: r.binding,
        phoneNumberId,
      });

      if (!domain.ok) {
        console.error(
          `[webhook/wa][staff] internal domain unresolved sender=${from} refusal=${domain.refusal} detail=${domain.detail} — structured path only`,
        );
        replyText = buildStaffHelpReply(resolved.openWork);
      } else {
        const turn = await runStaffRuntimeTurn({
          binding: domain.binding,
          text: body,
          openWork: resolved.openWork,
          correlationId: waMessageId,
        });

        if (turn.ok) {
          console.log(
            `[webhook/wa][staff] clawith turn ok sender=${from} domain=internal workspace=${domain.binding.clawithWorkspaceId} agent=${domain.binding.clawithAgentId} session=${turn.sessionKey} chars=${turn.text.length}`,
          );
          replyText = turn.text;
        } else {
          // Runtime unreachable. Fall back to the command list rather than
          // silence — the staff member still has a working structured path,
          // and saying so is more useful than not replying. There is NO
          // second runtime to try: Hermes is frozen and is not a fallback.
          console.error(
            `[webhook/wa][staff] clawith turn failed sender=${from} reason=${turn.reason} detail=${turn.detail ?? ''}`,
          );
          replyText = buildStaffHelpReply(resolved.openWork);
        }
      }
    }

  } else if (r.route === 'staff_disambiguation') {
    console.log(
      `[webhook/wa][staff] disambiguation phone_number_id=${phoneNumberId} sender=${from} action=${r.action} candidates=${r.candidates.length}`,
    );
    replyText = buildStaffDisambiguationReply(r.action, r.candidates);

  } else {
    // staff_action.
    //
    // ── A TAP CANNOT CARRY TEXT. ───────────────────────────────────────────
    //
    // UPDATE, BLOCKED and DONE are meaningless without words: a blocker with no
    // reason cannot be acted on by a manager, and a DONE with no result sends a
    // verification whose "Reported result" line is empty. Applying those on a
    // bare tap wrote exactly that, honestly labelled and still useless.
    //
    // So a text-bearing action that arrives with NO words does not apply — it
    // replies with a Flow that asks for them, and applies when the form comes
    // back. The action and the record ride in the Flow's `flow_token`, so
    // nothing is remembered server-side between the two messages and an
    // abandoned form leaves no stale state to swallow the next message.
    //
    // A TYPED command is untouched: `BLOCKED 2410 <reason>` arrives with
    // `r.note` already set and applies immediately, as it always has.
    const note = r.note ?? flowNote;
    if (isTextBearingAction(r.action) && !note?.trim()) {
      console.log(
        `[webhook/wa][staff] action=${r.action} needs words sender=${from} task=${r.target.odooId} — opening flow, not applying`,
      );
      await sendStaffChannelReply({
        tenantId,
        to: from,
        text: buildStaffFlowPromptReply(r.action),
        menu: { kind: 'none' },
        flow: buildStaffNoteFlow({
          action: r.action,
          correlationId: r.target.correlationId,
          taskLabel: r.target.label ?? `#${r.target.odooId}`,
        }),
      });
      return;
    }

    const applied = await applyStaffAction({
      binding:           r.binding,
      action:            r.action,
      workRefModel:      r.target.odooModel,
      workRefId:         r.target.odooId,
      correlationId:     r.target.correlationId,
      note,
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
      replyText = buildStaffAckReply(
        r.action,
        applied.deduped,
        'odooResult' in applied ? applied.odooResult : null,
      );
      // Fresh read, after the write: a START has already moved the stage, so
      // the menu that comes back is the NEW stage's menu, not the old one's.
      replyMenu = await buildStaffReplyMenu({ binding: r.binding, target: r.target });

      // A DONE that raises a verification is already told to the manager —
      // `applyStaffAction` (lib/staff-ops/service.ts) calls
      // `applyDoneVerification`, which calls `enqueueManagerVerificationNotification`
      // as part of the same write, before this function ever sees the result.
      // That path sends the real approved `epic_manager_verification_v1`
      // template with genuine Approve/Return buttons through the durable
      // outbox. A second, synchronous, free-text notice used to be sent from
      // here too — retired 2026-07-30 as a duplicate send path (it also had
      // its own unrelated window-check bug). Do not re-add a manager notice
      // in this branch; the outbox is the sole notifier.
    }
  }

  // ── Single shared send path. ─────────────────────────────────────────────
  await sendStaffChannelReply({ tenantId, to: from, text: replyText, menu: replyMenu });
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
          // A tap arrives as type `interactive` (free-form menu) or type
          // `button` (TEMPLATE quick reply), each echoing back the developer
          // id minted when the menu or template was sent. `extractStaffTapId`
          // reduces all three envelopes to one id.
          //
          // NOTE THE ORDER. This block does NOT act on the tap — it only
          // classifies it. The cross-path idempotency gate inside
          // handleStaffInboundMessage still runs first, because a tap carries
          // a wamid like any other inbound and two Meta apps remain subscribed
          // to this WABA, so taps are delivered twice as well. Branching to a
          // handler ahead of that gate would reproduce cutover defect 4 on the
          // exact number where it was already solved once.
          const tapId = extractStaffTapId(msg);

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
            // Present only on a completed Flow. Everything else passes null and
            // behaves exactly as before.
            flowNote: extractStaffFlowNote(msg),
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
