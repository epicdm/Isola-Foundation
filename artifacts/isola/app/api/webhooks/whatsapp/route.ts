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

// Per-phone-number-id ignore list (Port defect-foundation-must-ignore-hermes-
// 9043-2026-07-23). Foundation and bff-v2 (EPIC_BFF) are BOTH subscribed to
// the same WABA, so Meta delivers every event to both. Hermes's internal
// WhatsApp number (+1 767-818-9043, phone_number_id 1029700810228517) is
// owned exclusively by bff-v2/EPIC_BFF — Foundation must acknowledge but
// never process it: no tenant resolution, no Flowise/agent invocation, no
// DB writes, no send.
//
// 1029700810228517 (Hermes 9043) is a HARDCODED floor, not just an env var —
// this exact number already leaked through once because an earlier fix set
// WEBHOOK_IGNORE_PHONE_IDS without any code reading it (env presence was
// mistaken for enforcement). WEBHOOK_IGNORE_PHONE_IDS still works and can add
// further ids on top, but 9043 is never dependent on it alone.
// Read fresh on every call (not module-level) so an env change takes effect
// on next request without a code deploy.
const HERMES_9043_PHONE_NUMBER_ID = '1029700810228517';

function getIgnoredPhoneNumberIds(): Set<string> {
  const fromEnv = (process.env.WEBHOOK_IGNORE_PHONE_IDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return new Set([HERMES_9043_PHONE_NUMBER_ID, ...fromEnv]);
}

async function processWebhook(body: Record<string, unknown>) {
  const entries = (body?.entry as any[]) ?? [];
  const ignoredPhoneNumberIds = getIgnoredPhoneNumberIds();

  for (const entry of entries) {
    for (const change of (entry.changes as any[]) ?? []) {
      if (change.field !== 'messages') continue;

      const value = change.value as Record<string, any>;
      const phoneNumberId: string = value?.metadata?.phone_number_id ?? '';

      // Early ignore guard — filtered per-change so a batched webhook
      // containing both an ignored (9043) and an allowed (e.g. 6737)
      // change still processes the allowed one. No tenant/agent
      // resolution, no Flowise, no DB write, no send for an ignored id.
      if (phoneNumberId && ignoredPhoneNumberIds.has(phoneNumberId)) {
        console.log('[webhook/wa] ignore-phone-id', phoneNumberId, '— acknowledged, zero downstream processing (not owned by Foundation)');
        continue;
      }

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
