import { NextRequest, NextResponse } from 'next/server';
import { getConsumerSession } from '@/lib/consumer-session';
import { isMagnusConfigured } from '@/lib/engines';
import { getVoiceRouteState, setVoiceRouteMode, VoiceRouteError, routeErrorResponseFor } from '@/lib/voice-routing-service';

/**
 * GET /api/consumer/voice/routing — the signed-in consumer's current
 * normalized routing mode. Mirrors /api/voice/routing (operator).
 */
export async function GET(_req: NextRequest) {
  const account = await getConsumerSession();
  if (!account) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!isMagnusConfigured()) return NextResponse.json({ error: 'Magnus not configured' }, { status: 503 });

  try {
    const state = await getVoiceRouteState({ kind: 'consumer', session: account });
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
 * POST /api/consumer/voice/routing — set the signed-in consumer's voice
 * routing mode. Body: { mode: 'app' | 'app_then_cell' | 'cell', forward_number?: string }
 */
export async function POST(req: NextRequest) {
  const account = await getConsumerSession();
  if (!account) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!isMagnusConfigured()) return NextResponse.json({ error: 'Magnus not configured' }, { status: 503 });

  const body = await req.json().catch(() => ({}));
  const { mode, forward_number } = body;

  try {
    const result = await setVoiceRouteMode(
      { kind: 'consumer', session: account },
      { mode, forwardNumber: forward_number, sourceSurface: 'consumer.routing' },
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
