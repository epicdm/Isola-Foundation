/**
 * Who may hand a conversation back to the AI.
 *
 * §5 of the packet: "Only an explicit authorized action may initiate
 * handback. Conversation resolution alone must not do so."
 *
 * The rule is expressed as an allow-list of actor kinds rather than a
 * `!isForbidden()` check, because the failure mode this exists to prevent is
 * a NEW event source acquiring handback power by default. Under an
 * allow-list, an unlisted actor — a Chatwoot resolution, a Clawith tool
 * call, an automation rule, anything added later — is refused until someone
 * deliberately adds it here.
 *
 * Pure: no session parsing, no I/O. The route decides WHO the caller is;
 * this decides whether that kind of caller may do this.
 */

/** Actor kinds that exist in the system today. Only some may hand back. */
export type HandbackActorKind =
  /** A signed-in tenant owner acting in the dashboard. */
  | 'owner'
  /** A signed-in tenant admin acting in the dashboard. */
  | 'admin'
  /** A Foundation operator acting through an internal, authenticated surface. */
  | 'internal_operator'
  /** Chatwoot closed/resolved the conversation. NOT an authorization. */
  | 'chatwoot_resolution'
  /** The brain asked to take the conversation back. NOT an authorization. */
  | 'clawith_agent'
  /** A tenant staff member with no handback grant. */
  | 'staff';

export interface HandbackActor {
  kind: HandbackActorKind;
  /** Stable, non-secret reference recorded on the transition, e.g. `user:<id>`. */
  ref: string;
  /** The tenant the actor is acting for. Must match the conversation's tenant. */
  tenantId: string;
}

/** The complete set of actor kinds permitted to initiate a handback. */
export const AUTHORIZED_HANDBACK_ACTOR_KINDS: ReadonlySet<HandbackActorKind> =
  new Set<HandbackActorKind>(['owner', 'admin', 'internal_operator']);

export type HandbackAuthzRefusal =
  | 'no_actor'
  | 'actor_kind_not_authorized'
  | 'tenant_mismatch'
  | 'actor_ref_missing';

export type HandbackAuthzResult =
  | { ok: true; actorRef: string }
  | { ok: false; refusal: HandbackAuthzRefusal };

/**
 * Decide whether `actor` may initiate a handback on a conversation belonging
 * to `tenantId`. Fails closed on anything unexpected.
 */
export function authorizeHandback(
  actor: HandbackActor | null | undefined,
  tenantId: string,
): HandbackAuthzResult {
  if (!actor) return { ok: false, refusal: 'no_actor' };
  if (!AUTHORIZED_HANDBACK_ACTOR_KINDS.has(actor.kind)) {
    return { ok: false, refusal: 'actor_kind_not_authorized' };
  }
  if (!actor.tenantId || actor.tenantId !== tenantId) {
    return { ok: false, refusal: 'tenant_mismatch' };
  }
  const ref = (actor.ref ?? '').trim();
  if (!ref) return { ok: false, refusal: 'actor_ref_missing' };
  return { ok: true, actorRef: ref };
}
