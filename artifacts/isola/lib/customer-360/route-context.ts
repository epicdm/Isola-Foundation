/**
 * The preamble every Customer 360 route runs before it does anything.
 *
 * Extracted at the THIRD copy, not the second. `context/route.ts` and
 * `actions/send-document/route.ts` each carry their own session → role → hint
 * sequence; a third hand-written copy is where a divergence becomes likely
 * rather than possible, and the sequence is a security boundary, so the copies
 * drifting is not a style problem.
 *
 * The invariant it exists to hold, stated once here so it cannot be restated
 * differently in three places:
 *
 *   THE BROWSER SUPPLIES LOCATORS ONLY. THE TENANT COMES FROM THE SESSION.
 *
 * A hint names which conversation the panel believes it is open on. It never
 * names whose data may be read. Everything downstream scopes on `tenantId`,
 * which is derived from the Isola session cookie and never from the request
 * body.
 */

import { NextRequest, NextResponse } from 'next/server'

import { getSessionFromCookie } from '@/lib/session'
import { getMembershipRole } from '@/lib/permissions'
import type { ChatwootContextHint } from './chatwoot-context'

export interface RouteContext {
  tenantId: string
  userId: string
  isAdmin: boolean
  homeOwner: boolean
  membershipRole: string | null
  hint: ChatwootContextHint
}

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')

/** A positive integer, given as a number or a numeric string. Nothing else. */
export function positiveInt(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(str(value))
  return Number.isSafeInteger(n) && n > 0 ? n : null
}

/**
 * Parse the three locators the SERVER can independently verify, and only those.
 * A hint carrying anything else is not richer, it is less trustworthy.
 */
export function parseHint(value: unknown): ChatwootContextHint | null {
  if (!value || typeof value !== 'object') return null
  const input = value as Record<string, unknown>
  const accountIdHint = positiveInt(input.accountIdHint)
  const inboxIdHint = positiveInt(input.inboxIdHint)
  const conversationDisplayIdHint = positiveInt(input.conversationDisplayIdHint)
  return accountIdHint && inboxIdHint && conversationDisplayIdHint
    ? { accountIdHint, inboxIdHint, conversationDisplayIdHint }
    : null
}

/** Session role → the governed runtime's vocabulary. Defaults DOWN, always. */
export function actorRoleFor(isAdmin: boolean, homeOwner: boolean, membershipRole: string | null): string {
  if (isAdmin || homeOwner) return 'owner'
  return membershipRole === 'manager' || membershipRole === 'owner' ? 'manager' : 'staff'
}

/**
 * Resolve session, role and hint, or the exact response to return instead.
 *
 * Returns a discriminated union rather than throwing, so a caller cannot
 * accidentally proceed past a failed check — there is no value to read on the
 * failure branch.
 */
export async function resolveRouteContext(
  req: NextRequest,
  body: Record<string, unknown> | null,
): Promise<{ ok: true; ctx: RouteContext } | { ok: false; response: NextResponse }> {
  const session = await getSessionFromCookie(req.headers.get('cookie') ?? '')
  if (!session) {
    return { ok: false, response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  }

  const membershipRole = await getMembershipRole(session.identityId, session.effectiveTenantId)
  const homeOwner = session.user.tenant_id === session.effectiveTenantId && session.isOwner
  if (!session.isAdmin && !homeOwner && !membershipRole) {
    return { ok: false, response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) }
  }

  const hint = parseHint(body?.hint)
  if (!hint) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'Invalid Chatwoot context' }, { status: 400 }),
    }
  }

  return {
    ok: true,
    ctx: {
      tenantId: session.effectiveTenantId,
      userId: session.user.id,
      isAdmin: session.isAdmin,
      homeOwner,
      membershipRole,
      hint,
    },
  }
}
