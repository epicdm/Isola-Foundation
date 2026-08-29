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
import { bearerFrom, resolveServiceCaller, serviceAuthEnvFrom } from './service-auth'
import type { ChatwootContextHint } from './chatwoot-context'

/**
 * A tenant the CALLER believes it is asking about.
 *
 * It is never used to decide which tenant is read — that comes from the session
 * or from the service token's own configuration. It is read for exactly one
 * purpose: to REFUSE when it disagrees.
 *
 * Ignoring it outright would also be safe, and was the first design. The reason
 * it is read is that pure ignoring hides a caller's bug: a portal that believes
 * it asked for tenant A and silently receives tenant B's data looks like it
 * worked. Refusing turns that into a loud 403. Reading a value solely to deny
 * creates no path by which it could ever grant.
 */
export const TENANT_ASSERTION_HEADER = 'x-isola-tenant-id'

export type CallerKind = 'service' | 'session'

export interface CallerContext {
  tenantId: string
  kind: CallerKind
  /** The governed runtime's vocabulary. A service caller is never 'owner'. */
  actorRole: string
  userId: string | null
}

/**
 * Refuse when the caller asserted a tenant that is not the one we resolved.
 * Returns the response to send, or null to continue.
 */
export function refuseOnTenantMismatch(
  req: NextRequest,
  resolvedTenantId: string,
): NextResponse | null {
  const asserted = (req.headers.get(TENANT_ASSERTION_HEADER) ?? '').trim()
  if (!asserted) return null
  if (asserted === resolvedTenantId) return null
  // Deliberately the same wording a role failure gets. Confirming that some
  // OTHER tenant id is real would make this an enumeration oracle over tenants.
  return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
}

/**
 * Resolve WHO is calling and WHICH tenant they may read, by either door.
 *
 * THE ORDER MATTERS, AND SO DOES THE REFUSAL IN THE MIDDLE
 * --------------------------------------------------------
 * The service door is tried first. If a bearer was PRESENTED and did not
 * authenticate, this refuses outright and does NOT fall through to the cookie
 * door — otherwise a caller holding a stale service token and a valid browser
 * session would silently succeed as a different principal, and the failure of
 * the credential it actually presented would go unnoticed.
 */
export async function resolveCaller(
  req: NextRequest,
): Promise<{ ok: true; caller: CallerContext } | { ok: false; response: NextResponse }> {
  const authorization = req.headers.get('authorization')

  const service = resolveServiceCaller(authorization, serviceAuthEnvFrom(process.env))
  if (service.ok) {
    const refusal = refuseOnTenantMismatch(req, service.tenantId)
    if (refusal) return { ok: false, response: refusal }
    return {
      ok: true,
      caller: {
        tenantId: service.tenantId,
        kind: 'service',
        // A machine gets the middle role. Owner powers belong to a person.
        actorRole: 'manager',
        userId: null,
      },
    }
  }

  // A bearer was offered and rejected. Do not try another door.
  if (bearerFrom(authorization)) {
    return { ok: false, response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  }

  const session = await getSessionFromCookie(req.headers.get('cookie') ?? '')
  if (!session) {
    return { ok: false, response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  }

  const membershipRole = await getMembershipRole(session.identityId, session.effectiveTenantId)
  const homeOwner = session.user.tenant_id === session.effectiveTenantId && session.isOwner
  if (!session.isAdmin && !homeOwner && !membershipRole) {
    return { ok: false, response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) }
  }

  // The same refusal on the cookie path. A browser cannot GRANT itself a tenant
  // here — the value is only ever compared, never assigned — but a mismatched
  // header still means the caller is confused about whose data it is reading.
  const refusal = refuseOnTenantMismatch(req, session.effectiveTenantId)
  if (refusal) return { ok: false, response: refusal }

  return {
    ok: true,
    caller: {
      tenantId: session.effectiveTenantId,
      kind: 'session',
      actorRole: actorRoleFor(session.isAdmin, homeOwner, membershipRole),
      userId: session.user.id,
    },
  }
}

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
