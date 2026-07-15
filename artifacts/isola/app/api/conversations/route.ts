import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromCookie } from '@/lib/session';
import { prisma } from '@/lib/prisma';

export async function GET(req: NextRequest) {
  const ctx = await getSessionFromCookie(req.headers.get('cookie') ?? '');
  if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const url = new URL(req.url);
  const status = url.searchParams.get('status') ?? 'open';
  const limitParam = url.searchParams.get('limit');
  const limit = limitParam ? Math.min(parseInt(limitParam, 10), 100) : 50;

  const conversations = await prisma.conversation.findMany({
    where: { tenant_id: ctx.effectiveTenantId, ...(status !== 'all' && { status }) },
    include: {
      messages: {
        orderBy: { created_at: 'desc' },
        take: 1,
      },
    },
    orderBy: { last_message_at: 'desc' },
    take: limit,
  });

  return NextResponse.json({ conversations });
}
