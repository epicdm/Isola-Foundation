import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromCookie } from '@/lib/session';
import { isMagnusConfigured } from '@/lib/engines';
import { getVoiceRouteState, setVoiceRouteMode, VoiceRouteError, routeErrorResponseFor } from '@/lib/voice-routing-service';

/**
 * GET /api/voice/routing — the tenant's current normalized routing mode,
 * derived live from Magnus (never persisted in Neon).
 */
export async function GET(req: NextRequest) {
  const ctx = await getSessionFromCookie(req.headers.get('cookie') ?? '');
  if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!isMagnusConfigured()) return NextResponse.json({ error: 'Magnus not configured' }, { status: 503 });

  try {
    const state = await getVoiceRouteState({ kind: 'operator', session: ctx });
    return NextResponse.json({
      mode: state.mode,
      forward_to_cell_number: state.forwardToCellNumber,
      reason: state.reason,
    });
  } catch (e) {
    if (e instanceof VoiceRouteError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: 'Failed to read voice routing state' }, { status: 502 });
  }
}

/**
 * POST /api/voice/routing — set the tenant's voice routing mode.
 * Body: { mode: 'app' | 'app_then_cell' | 'cell', forward_number?: string }
 * The canonical S5 endpoint — supersedes the boolean-shaped
 * /api/voice/forward, which remains as a compatibility adapter over the same
 * central service (lib/voice-routing-service.ts).
 */
export async function POST(req: NextRequest) {
  const ctx = await getSessionFromCookie(req.headers.get('cookie') ?? '');
  if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!isMagnusConfigured()) return NextResponse.json({ error: 'Magnus not configured' }, { status: 503 });

  const body = await req.json().catch(() => ({}));
  const { mode, forward_number } = body;

  try {
    const result = await setVoiceRouteMode(
      { kind: 'operator', session: ctx },
      { mode, forwardNumber: forward_number, sourceSurface: 'operator.routing' },
    );
    if (!result.ok) {
      const { status, body } = routeErrorResponseFor(result);
      return NextResponse.json(body, { status });
    }
    return NextResponse.json({ mode: result.mode, forward_to_cell_number: result.forwardToCellNumber });
  } catch (e) {
    if (e instanceof VoiceRouteError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: 'Failed to update routing' }, { status: 502 });
  }
}
