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
