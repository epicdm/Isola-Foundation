import { NextRequest, NextResponse } from 'next/server';
import { getConsumerSession } from '@/lib/consumer-session';
import { getMagnusConfig, isMagnusConfigured } from '@/lib/engines';
import { getCalls } from '@/engines/magnus';

/** GET /api/consumer/voice/calls — recent CDRs for the signed-in consumer's Magnus user. */
export async function GET(req: NextRequest) {
  const account = await getConsumerSession();
  if (!account) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  if (!isMagnusConfigured()) {
    return NextResponse.json({ calls: [], magnus_configured: false });
  }

  if (!account.magnus_user_id) {
    return NextResponse.json({ calls: [], magnus_configured: true, magnus_user_id_missing: true });
  }

  const limitParam = new URL(req.url).searchParams.get('limit');
  const displayLimit = limitParam ? parseInt(limitParam, 10) : 30;

  try {
    const calls = await getCalls(getMagnusConfig(), account.magnus_user_id, displayLimit);
    return NextResponse.json({ calls, magnus_configured: true });
  } catch (e: any) {
    console.error('[consumer/voice/calls]', e.message);
    return NextResponse.json({ error: 'Failed to fetch calls', calls: [] }, { status: 502 });
  }
}
