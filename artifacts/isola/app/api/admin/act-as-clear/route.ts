/**
 * POST /api/admin/act-as-clear
 * Clears the admin's act-as session and redirects back to /admin.
 *
 * Intentionally POST-only. This used to also handle GET so a plain <a>/<Link>
 * could hit it directly, but Next.js's <Link> prefetches any href in the
 * viewport by default (a background GET), which silently fired this
 * clearing side effect the moment the "Exit act-as" link scrolled into
 * view — wiping act_as_tenant_id seconds after the admin turned it on,
 * even though the Server-Component-rendered dashboard still showed the
 * (now stale) acted-as tenant. A state-mutating endpoint must never be
 * reachable via GET/prefetch; the sidebar now calls this via POST + router
 * navigation instead of rendering it as a Link.
 */

import { NextResponse } from 'next/server';
import { getSession } from '@/lib/session';
import { prisma } from '@/lib/prisma';

export async function POST() {
  const session = await getSession();
  if (!session?.isAdmin) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  await prisma.user.update({
    where: { id: session.user.id },
    data: { act_as_tenant_id: null },
  });

  return NextResponse.json({ ok: true });
}
