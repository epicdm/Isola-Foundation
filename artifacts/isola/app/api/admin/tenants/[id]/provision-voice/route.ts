import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromCookie } from '@/lib/session';
import { audit } from '@/lib/audit';
import { provisionTenantVoice } from '@/lib/voice-provisioning';

type Params = { params: Promise<{ id: string }> };

/**
 * POST /api/admin/tenants/[id]/provision-voice
 * Admin-triggered, idempotent Magnus voice/PBX provisioning for a tenant.
 * Safe to call repeatedly — resumes/no-ops based on which Magnus ids are
 * already persisted on the tenant.
 */
export async function POST(req: NextRequest, { params }: Params) {
  const ctx = await getSessionFromCookie(req.headers.get('cookie') ?? '');
  if (!ctx?.isAdmin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const { id } = await params;

  try {
    const result = await provisionTenantVoice(id);

    await audit({
      tenantId: ctx.user.tenant_id,
      actorId: ctx.user.id,
      action: 'admin.tenant.provision_voice',
      entity: 'tenant',
      entityId: id,
      meta: { state: result.state, error: result.error },
    });

    if (result.state === 'failed') {
      return NextResponse.json({ error: result.error, result }, { status: 502 });
    }
    return NextResponse.json({ result });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? 'Provisioning failed' }, { status: 500 });
  }
}
