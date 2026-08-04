/**
 * Operator alert for a Clawith provider/model failure — the shared boundary
 * both staff chat and customer dispatch call on every non-configuration
 * `ClawithFailure`, so an operator finds out about a 402 or a leaked
 * provider error the same way regardless of which surface it happened on.
 *
 * Uses ONLY existing Foundation infrastructure, per the packet's own
 * constraint ("do not create a new alerting platform"):
 *
 *  - `audit()` — always. This is where the complete raw diagnostic (kind,
 *    HTTP status, provider detail text, run/correlation id, tenant, agent,
 *    surface) is preserved. It is the durable record satisfying "preserve
 *    the complete original failure internally".
 *
 *  - `enqueueNotification()` (WhatsApp, `owner_self_notification`) — only
 *    when `CLAWITH_FAILURE_ALERT_TEMPLATE` names an already Meta-approved
 *    template. `lib/notify-drain.ts` sends `NotificationOutbox.template`
 *    verbatim to Meta's Graph API; an unapproved name fails delivery, and
 *    creating/approving a new template is an owner-only Meta asset action
 *    (out of scope for this change — see CLAUDE.md §6). Until an owner
 *    approves one and sets this var, the audit row above IS the alert: it
 *    is durable, queryable, and already how this codebase surfaces failures
 *    an operator needs to see (see lib/staff-ops for the same pattern).
 *
 * Deduplication ("exactly one alert per failure event... across retries") is
 * enforced by `NotificationOutbox`'s own `@@unique([tenant_id, dedupe_key])`
 * — every call for the same `correlationId` shares one dedupe key, so a
 * retried turn that fails again enqueues at most one notification. The audit
 * trail is deliberately NOT deduplicated the same way: every attempt is
 * logged so the full retry history stays reconstructable.
 */

import { prisma } from '../prisma';
import { audit } from '../audit';
import { enqueueNotification } from '../notify';
import type { ClawithFailure, ClawithFailureKind } from './errors';

/** Clawith exposes no safe, credential-free balance-check endpoint to
 *  Foundation, and this change does not add Clawith-side writes
 *  (CLAWITH_WRITES=NO) — so funding/credit monitoring here is a
 *  first-failure alarm, not a polled balance check: the very first
 *  `payment_required` for a credential trips the circuit breaker
 *  (lib/clawith/circuit-breaker.ts) immediately, and every occurrence is
 *  flagged P0 in the audit row so an operator query/dashboard can filter to
 *  it without waiting on a second failure. */
const P0_KINDS: ReadonlySet<ClawithFailureKind> = new Set<ClawithFailureKind>(['payment_required']);

/** Additive, default-empty — mirrors the `FOUNDATION_STAFF_CHAT_AGENT_IDS`
 *  / `AI_LOOP_ENABLED` env-gate pattern already used for governance-
 *  sensitive config elsewhere in lib/clawith. Unset means WhatsApp
 *  escalation is off; audit-only alerting is always on. */
export const CLAWITH_FAILURE_ALERT_TEMPLATE_ENV = 'CLAWITH_FAILURE_ALERT_TEMPLATE';

export interface ClawithFailureAlertContext {
  /** Foundation tenant id — required; there is no alert without a tenant to
   *  scope it to. */
  tenantId: string;
  /** Foundation Agent.id, when the caller has one resolved. Null on the
   *  customer path, which does not carry a Foundation Agent record. */
  agentId: string | null;
  /** Clawith's own agent id — the credential/model this failure actually
   *  happened against. */
  clawithAgentId: string;
  surface: 'staff_chat' | 'customer_dispatch';
  /** Dedupe key for the WhatsApp leg, and the join key back to the audit
   *  trail. Stable across a client's retry of the same logical turn. */
  correlationId: string;
  actorId: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * Fire-and-forget, same contract as `audit()`: an alerting failure must
 * never take down the primary chat/dispatch flow that is already handling a
 * degraded response. Every step here is best-effort.
 */
export async function recordClawithFailure(
  failure: ClawithFailure,
  ctx: ClawithFailureAlertContext,
): Promise<void> {
  await audit({
    tenantId: ctx.tenantId,
    actorId: ctx.actorId,
    action: 'clawith.failure',
    entity: 'Agent',
    entityId: ctx.agentId ?? undefined,
    requestId: ctx.correlationId,
    meta: {
      kind: failure.kind,
      status: failure.status,
      detail: failure.detail,
      surface: ctx.surface,
      clawithAgentId: ctx.clawithAgentId,
      severity: P0_KINDS.has(failure.kind) ? 'P0' : 'P2',
    },
  });

  try {
    const env = ctx.env ?? process.env;
    const template = env[CLAWITH_FAILURE_ALERT_TEMPLATE_ENV];
    if (!template || template.trim() === '') return;

    const tenant = await prisma.tenant.findUnique({
      where: { id: ctx.tenantId },
      select: { owner_phone: true },
    });
    const ownerPhone = tenant?.owner_phone;
    if (!ownerPhone) return;

    await enqueueNotification({
      tenantId: ctx.tenantId,
      contact: ownerPhone,
      channel: 'whatsapp',
      consentBasis: 'owner_self_notification',
      template: template.trim(),
      payload: { kind: failure.kind, surface: ctx.surface },
      dedupeKey: `clawith-failure:${ctx.correlationId}`,
      correlationId: ctx.correlationId,
    });
  } catch (err) {
    console.error('[clawith/alert] WhatsApp escalation failed — audit row above is the durable record:', err);
  }
}
