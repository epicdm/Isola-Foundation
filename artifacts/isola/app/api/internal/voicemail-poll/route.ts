/**
 * POST /api/internal/voicemail-poll
 *
 * Thin wrapper the Replit Scheduled Deployment (or any external cron
 * caller) hits every ~5 minutes to run the per-tenant voicemail poller
 * once. See lib/voicemail-poller.ts for the actual SSH-voice00 /
 * transcribe / summarize / deliver pipeline — this route does no work
 * itself beyond auth + flag gate + invoking pollTenantVoicemails().
 *
 * Auth: `Authorization: Bearer <VOICEMAIL_POLL_TOKEN>` — a standalone
 * service token, following the same pattern as
 * app/api/agent-tools/invoke/route.ts (constant-time compare, not a
 * session cookie). Deliberately NOT session-gated so a Scheduled
 * Deployment (or an external cron/uptime-style caller) can hit it
 * directly over HTTPS.
 *
 * Flag-gated: VOICEMAIL_POLL_ENABLED must be exactly "true", or every
 * request gets 403 { ok:false, error:"service_disabled" } regardless of
 * token. Default is OFF — this PR does not turn the poller on anywhere.
 *
 * See README.md in this directory for the Scheduled Deployment wiring
 * steps (this is documentation only — no deployment config is created by
 * this PR).
 */

import { NextRequest, NextResponse } from 'next/server';
import { pollTenantVoicemails } from '@/lib/voicemail-poller';

function isEnabled(): boolean {
  return process.env.VOICEMAIL_POLL_ENABLED === 'true';
}

function getExpectedToken(): string | undefined {
  return process.env.VOICEMAIL_POLL_TOKEN;
}

function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function authenticate(req: NextRequest): boolean {
  const expected = getExpectedToken();
  if (!expected) return false; // not configured — never authenticate against an empty token
  const header = req.headers.get('authorization') ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) return false;
  return constantTimeEquals(match[1], expected);
}

export async function POST(req: NextRequest) {
  if (!isEnabled()) {
    return NextResponse.json({ ok: false, error: 'service_disabled' }, { status: 403 });
  }
  if (!authenticate(req)) {
    return NextResponse.json({ ok: false, error: 'bad_auth' }, { status: 401 });
  }

  try {
    const result = await pollTenantVoicemails();
    return NextResponse.json({ ok: true, result });
  } catch (e: any) {
    console.error('[voicemail-poll] pollTenantVoicemails failed:', e?.message ?? e);
    return NextResponse.json(
      { ok: false, error: 'poll_failed', detail: e?.message ?? 'unknown error' },
      { status: 500 },
    );
  }
}
