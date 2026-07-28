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
    default:        return '✓ Recorded.';
  }
}

async function handleStaffInboundMessage(params: {
  phoneNumberId: string;
  from: string;
  body: string;
  waMessageId: string;
}) {
  const { phoneNumberId, from, body, waMessageId } = params;

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
  const { resolveInboundStaffMessage, applyStaffAction } = await import('@/lib/staff-ops/service');
  const resolved = await resolveInboundStaffMessage({
    waId: from,
    text: body,
    channelTenantId: tenantId,
  });

  if (resolved.route.route !== 'staff_action') {
    // Unknown sender, inactive binding, disambiguation needed, help request,
    // non-command prose — all are operator concerns. Log and stop.
    // The customer agent is never involved.
    const r = resolved.route;
    const detail =
      r.route === 'exception'           ? `why=${r.why}` :
      r.route === 'staff_disambiguation' ? `action=${r.action} candidates=${r.candidates.length}` :
      r.route === 'staff_help'          ? `why=${r.why}` : 'non_command';
    console.error(
      `[webhook/wa][staff] unresolved phone_number_id=${phoneNumberId} sender=${from} route=${r.route} ${detail} — dropped, no reply`,
    );
    return;
  }

  const route = resolved.route;

  const applied = await applyStaffAction({
    binding:       route.binding,
    action:        route.action,
    workRefModel:  route.target.odooModel,
    workRefId:     route.target.odooId,
    correlationId: route.target.correlationId,
    note:          route.note,
    providerMessageId: waMessageId,
    source: 'whatsapp',
  });

  if (!applied.ok) {
    console.error(
      `[webhook/wa][staff] apply failed phone_number_id=${phoneNumberId} sender=${from} action=${route.action} reason=${applied.reason} — no reply`,
    );
    return;
  }

  console.log(
    `[webhook/wa][staff] applied phone_number_id=${phoneNumberId} sender=${from} action=${route.action} deduped=${applied.deduped} actionId=${applied.actionId}`,
  );

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

  const { sendText } = await import('@/engines/whatsapp');
  const { getWhatsAppConfig } = await import('@/lib/engines');
  const replyResult = await sendText(getWhatsAppConfig(), {
    phoneId: fromNumber.phone_number_id,
    token,
    to: from.replace(/^\+/, ''), // Meta expects E.164 digits without '+'
    body: buildStaffAckReply(route.action, applied.deduped),
  });

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
      // Inbound messages from an ignored number are always dropped here.
      // Delivery-status callbacks are exempt when the number also appears in
      // WEBHOOK_STATUS_PASSTHROUGH_PHONE_IDS — see the block comment above for
      // the full cutover procedure.
      const isIgnored = !!(phoneNumberId && ignoredPhoneNumberIds.has(phoneNumberId));
      if (isIgnored) {
        const hasStatuses = Array.isArray(value?.statuses) && value.statuses.length > 0;
        if (!hasStatuses || !getStatusPassthroughPhoneNumberIds().has(phoneNumberId)) {
          console.log('[webhook/wa] ignore-phone-id', phoneNumberId, '— acknowledged, zero downstream processing (not owned by Foundation)');
          continue;
        }
        // Number is on the ignore list but has statuses and is in the
        // passthrough list — fall through to status ingestion only.
        // Messages are skipped by the guard below.
      }

      // ── Wave 1: delivery-status callbacks ────────────────────────────────
      //
      // Meta delivers `statuses` on the same `messages` field as inbound
      // messages. Foundation previously read only `messages` and dropped every
      // status on the floor — which is the same shape of gap that let a failed
      // send keep reading as though it had gone out.
      if (Array.isArray(value?.statuses) && value.statuses.length > 0) {
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

      // Inbound messages are never processed for ignored numbers, even when the
      // status passthrough list allowed status events to be ingested above.
      if (isIgnored) continue;

      const messages: any[] = value?.messages ?? [];

      // Staff-operations path — mutually exclusive with the customer-agent
      // path below. A number in STAFF_INBOUND_PHONE_NUMBER_IDS NEVER reaches
      // handleInboundWhatsApp. The explicit `continue` below is the hard
      // barrier; it is there intentionally and must not be removed.
      if (phoneNumberId && getStaffInboundPhoneNumberIds().has(phoneNumberId)) {
        for (const msg of messages) {
          if (msg.type !== 'text') {
            console.log('[webhook/wa][staff] ignoring non-text message type:', msg.type);
            continue;
          }
          await handleStaffInboundMessage({
            phoneNumberId,
            from: String(msg.from ?? ''),
            body: String(msg.text?.body ?? ''),
            waMessageId: String(msg.id ?? ''),
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
