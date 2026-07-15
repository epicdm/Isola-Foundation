/**
 * POST /api/consumer/lead — public, unauthenticated funnel-attribution
 * endpoint for the P6 EMA landing page (app/ema). Never touches consumer
 * auth/session/provisioning — purely a marketing-attribution write.
 */

import { NextRequest, NextResponse } from 'next/server';
import { captureConsumerLead } from '@/lib/consumer-lead';

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 500) : null);

  try {
    const result = await captureConsumerLead({
      utmSource: str(body.utm_source),
      utmMedium: str(body.utm_medium),
      utmCampaign: str(body.utm_campaign),
      utmTerm: str(body.utm_term),
      utmContent: str(body.utm_content),
      referrer: str(body.referrer),
      landingPath: str(body.landing_path),
      cta: str(body.cta),
    });
    return NextResponse.json(result);
  } catch (err) {
    console.error('[api/consumer/lead] capture failed:', err);
    return NextResponse.json({ error: 'Failed to capture lead' }, { status: 500 });
  }
}
