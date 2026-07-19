import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromCookie } from '@/lib/session';
import { isMagnusConfigured } from '@/lib/engines';
import { setVoiceRouteMode, VoiceRouteError, routeErrorResponseFor } from '@/lib/voice-routing-service';

/**
 * POST /api/voice/forward — DEPRECATED compatibility adapter over the
 * central S5 routing service (lib/voice-routing-service.ts). Preserves the
 * exact pre-S5 boolean request/response contract:
 *   Body: { forward_to_cell: boolean, cell_number?: string }
 *   Response: { forward_to_cell: boolean, cell_number: string | null }
 *
 * Maps forward_to_cell=false -> mode 'app' (plain SIP, no forwarding) and
 * forward_to_cell=true -> mode 'cell'. `cell` is the closest S5 equivalent to
 * this endpoint's old semantics (ring behaves as "goes to cell"), though the
 * underlying Magnus write shape changed: the legacy writer set
 * voip_call='0' (SIP routing disabled outright); the S5 writer keeps
 * voip_call='1' and forces sip.dial_timeout='1' instead — SIP-first-safe by
 * structure even though the caller-visible behavior is unchanged. See PR
 * RISKS for this documented behavior-shape change.
 *
 * New integrations should call POST /api/voice/routing directly. This
 * endpoint is not currently scheduled for removal — kept indefinitely as a
 * compatibility shim until every caller has migrated.
 */
export async function POST(req: NextRequest) {
  const ctx = await getSessionFromCookie(req.headers.get('cookie') ?? '');
  if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const { forward_to_cell, cell_number } = body;

  if (!isMagnusConfigured()) {
    return NextResponse.json({ error: 'Magnus not configured' }, { status: 503 });
  }

  try {
    const result = await setVoiceRouteMode(
      { kind: 'operator', session: ctx },
      {
        mode: forward_to_cell ? 'cell' : 'app',
        forwardNumber: cell_number,
        sourceSurface: 'operator.forward_compat',
      },
    );

    if (!result.ok) {
      // Preserve the legacy boolean-contract failure shape ({ error }) — the
      // extra fields below are additive and safe for old callers to ignore.
      // A required-field rejection keeps its pre-existing 400; critical_degraded
      // gets its own server-error status so it's never silently reported the
      // same way as an ordinary validation rejection or Magnus-unavailable
      // error (which keep this route's pre-existing 502).
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
