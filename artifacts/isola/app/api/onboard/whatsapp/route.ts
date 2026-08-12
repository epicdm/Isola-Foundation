/**
 * POST /api/onboard/whatsapp
 * Connect a WhatsApp number to the tenant.
 * Body: { phone_number_id, waba_id, phone_number, display_name?, coex_mode? }
 *
 * Called after Meta Embedded Signup completes (or manual admin entry).
 *
 * CREDENTIAL INTAKE IS CLOSED — 2026-08-12.
 *
 * This endpoint used to accept `access_token` in the request body and write it
 * to `WhatsAppNumber.access_token` in plaintext. That made every onboarding
 * request a credential-ingestion path, put live Meta tokens in the application
 * database, and spread custody across four independent holders.
 *
 * A Meta credential is now held ONLY by the meta-egress-gateway, in a Docker
 * Swarm secret that is delivered to no other service. Per-tenant selection there
 * is derived from the authenticated tenant and its declared asset scope — never
 * from a value, a name or a reference supplied by a caller.
 *
 * So this route now records the ASSET MAPPING only: which phone number and WABA
 * belong to which tenant. That is exactly what the gateway's scope check needs,
 * and it is not a secret.
 *
 * Rejected loudly rather than ignored: a request that still carries
 * `access_token`, `token_env`, or any secret- or environment-variable-shaped
 * reference fails with 400. Silently dropping the field would let an old caller
 * believe it had provisioned a credential when it had not, and the number would
 * then fail to send with no indication why.
 *
 * Refs: blocker-meta-egress-boundary-required-2026-08-12
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromCookie } from '@/lib/session';
import { prisma } from '@/lib/prisma';
import { audit } from '@/lib/audit';
import {
  WHATSAPP_NUMBER_PUBLIC_SELECT,
  toPublicWhatsAppNumber,
  toPublicWhatsAppNumbers,
} from '@/lib/whatsapp-number-public';

export async function POST(req: NextRequest) {
  const ctx = await getSessionFromCookie(req.headers.get('cookie') ?? '');
  if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json();
  const { phone_number_id, waba_id, phone_number, display_name, coex_mode = true } = body;

  // Credential-shaped input is refused, not ignored. See the header note.
  const REJECTED_KEYS = ['access_token', 'token_env', 'token', 'secret', 'secret_name', 'env_var', 'credential_ref'];
  const offending = REJECTED_KEYS.filter((k) => body != null && Object.prototype.hasOwnProperty.call(body, k));
  if (offending.length > 0) {
    return NextResponse.json(
      {
        error:
          'This endpoint no longer accepts credentials or credential references. ' +
          'Meta tokens are held only by the meta-egress-gateway and are selected from the authenticated tenant. ' +
          `Remove: ${offending.join(', ')}`,
      },
      { status: 400 },
    );
  }

  if (!phone_number_id || !waba_id || !phone_number) {
    return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
  }

  // Check uniqueness of phone_number_id (cannot be owned by two tenants).
  // Only the owning tenant is needed here, so nothing else — least of all the
  // stored token — is read into memory for this check.
  const existing = await prisma.whatsAppNumber.findUnique({
    where: { phone_number_id },
    select: { tenant_id: true },
  });
  if (existing && existing.tenant_id !== ctx.effectiveTenantId) {
    return NextResponse.json({ error: 'This phone number is already registered to another tenant' }, { status: 409 });
  }

  const waNumber = await prisma.whatsAppNumber.upsert({
    where: { phone_number_id },
    create: {
      tenant_id: ctx.effectiveTenantId,
      phone_number_id,
      waba_id,
      phone_number,
      // The column is non-nullable in the current schema, so a new row writes an
      // empty string. It is NOT a credential and nothing resolves it: the send
      // path reads its token from the gateway. Dropping the column itself is a
      // reviewed migration, sequenced after the last legacy reader is retired.
      access_token: '',
      display_name: display_name ?? null,
      coex_mode: !!coex_mode,
    },
    update: {
      waba_id,
      phone_number,
      // Deliberately NOT touching access_token on update. An existing row may
      // still carry a legacy credential that a not-yet-migrated caller depends
      // on; blanking it here would break sending before the gateway path is
      // proven. Retirement of those values is a separate, sequenced step.
      display_name: display_name ?? null,
      coex_mode: !!coex_mode,
    },
    select: WHATSAPP_NUMBER_PUBLIC_SELECT,
  });

  await audit({
    tenantId: ctx.effectiveTenantId,
    actorId: ctx.user.id,
    action: 'whatsapp.connect',
    entity: 'whatsapp_number',
    entityId: waNumber.id,
    meta: { phone_number, coex_mode },
  });

  return NextResponse.json({ ok: true, whatsapp_number: toPublicWhatsAppNumber(waNumber) });
}

export async function GET(req: NextRequest) {
  const ctx = await getSessionFromCookie(req.headers.get('cookie') ?? '');
  if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const numbers = await prisma.whatsAppNumber.findMany({
    where: { tenant_id: ctx.effectiveTenantId },
    orderBy: { created_at: 'desc' },
    select: WHATSAPP_NUMBER_PUBLIC_SELECT,
  });
  return NextResponse.json({ numbers: toPublicWhatsAppNumbers(numbers) });
}
