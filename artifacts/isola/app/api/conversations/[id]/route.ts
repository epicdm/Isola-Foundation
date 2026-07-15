import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromCookie } from '@/lib/session';
import { prisma } from '@/lib/prisma';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const ctx = await getSessionFromCookie(req.headers.get('cookie') ?? '');
  if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id } = await params;
  const conversation = await prisma.conversation.findFirst({
    where: { id, tenant_id: ctx.effectiveTenantId },
    include: {
      messages: { orderBy: { created_at: 'asc' } },
    },
  });
  if (!conversation) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  return NextResponse.json({ conversation });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const ctx = await getSessionFromCookie(req.headers.get('cookie') ?? '');
  if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id } = await params;
  const { status, agent_took_over } = await req.json();

  const conversation = await prisma.conversation.findFirst({
    where: { id, tenant_id: ctx.effectiveTenantId },
  });
  if (!conversation) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const updated = await prisma.conversation.update({
    where: { id },
    data: {
      ...(status !== undefined && { status }),
      ...(agent_took_over !== undefined && { agent_took_over }),
    },
  });
  return NextResponse.json({ conversation: updated });
}
