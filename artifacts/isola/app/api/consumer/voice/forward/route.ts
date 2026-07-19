import { NextRequest, NextResponse } from 'next/server';
import { getConsumerSession } from '@/lib/consumer-session';
import { isMagnusConfigured } from '@/lib/engines';
import { setVoiceRouteMode, VoiceRouteError, routeErrorResponseFor } from '@/lib/voice-routing-service';

/**
 * POST /api/consumer/voice/forward — DEPRECATED compatibility adapter over
 * the central S5 routing service. Mirrors /api/voice/forward (operator) —
 * see that file's header for the exact preserved contract and the
 * forward_to_cell -> mode mapping / dial_timeout behavior-shape note.
 */
export async function POST(req: NextRequest) {
  const account = await getConsumerSession();
  if (!account) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const { forward_to_cell, cell_number } = body;

  if (!isMagnusConfigured()) {
    return NextResponse.json({ error: 'Magnus not configured' }, { status: 503 });
  }

  try {
    const result = await setVoiceRouteMode(
      { kind: 'consumer', session: account },
      {
        mode: forward_to_cell ? 'cell' : 'app',
        forwardNumber: cell_number,
        sourceSurface: 'consumer.forward_compat',
      },
    );

    if (!result.ok) {
      // See /api/voice/forward for why this mirrors that status mapping.
      const { status: structuredStatus, body } = routeErrorResponseFor(result);
      let status = 502;
      if (result.outcome === 'critical_degraded') status = structuredStatus;
      else if (/required/i.test(result.error ?? '')) status = 400;
      return NextResponse.json(body, { status });
    }

    return NextResponse.json({
      forward_to_cell: result.mode === 'cell',
      cell_number: result.forwardToCellNumber ?? null,
    });
  } catch (e) {
    if (e instanceof VoiceRouteError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: 'Failed to update routing' }, { status: 502 });
  }
}
