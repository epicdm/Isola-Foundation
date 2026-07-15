/**
 * Cross-path inbound idempotency gate — keyed ONLY on Meta's wamid.
 *
 * WHY THIS EXISTS (P0, 2026-07-15): Foundation already dedupes WITHIN each
 * inbound path — Message.wa_message_id (unique) for the direct WhatsApp
 * webhook (lib/agent.ts), Message.chatwoot_message_id (unique) for the
 * Chatwoot agent-bot path (app/api/chatwoot/agent-bot/route.ts). Those are
 * two DIFFERENT local keys tied to two different tables' rows. When the
 * SAME physical Meta message reaches BOTH paths (e.g. an A2 tenant whose
 * number also has a stray direct-webhook WhatsAppNumber routing row, or any
 * future dual-delivery scenario), each path claims its own distinct local
 * id, both per-path dedup checks pass independently, and two AI replies go
 * out for one inbound message. This module closes that gap with a single
 * table keyed on the Meta wamid itself, claimed by every inbound path at
 * the earliest possible point — before any reply or side effect.
 *
 * Pattern reused from deepseek /opt/bff-v2 app/lib/webhook/ingress.ts
 * checkDedup() (table `inbound_dedup`, INSERT ... ON CONFLICT DO NOTHING).
 * Ported here as a Prisma-model try/insert + P2002 catch to match this
 * codebase's existing dedup convention (see lib/agent.ts step 7 and
 * app/api/chatwoot/agent-bot/route.ts's own Message.create dedup claims)
 * rather than introducing a raw-SQL style foreign to this repo.
 *
 * This is ADDITIVE, not a replacement — the existing per-path
 * wa_message_id / chatwoot_message_id unique constraints stay in place as
 * defense-in-depth (e.g. genuine same-path Meta/Chatwoot webhook retries).
 */

import { prisma } from './prisma';

/**
 * Atomically claim a Meta message id. Race-safe: relies on
 * InboundDedup.message_id's UNIQUE constraint rather than a check-then-act
 * read followed by a write, so there is no TOCTOU window between two
 * concurrent deliveries of the same wamid.
 *
 * Returns true  → already claimed by a previous call. This delivery is a
 *                 duplicate — the caller MUST drop it now: no AI call, no
 *                 reply, no further side effects.
 * Returns false → newly claimed by this call. This is the first delivery —
 *                 the caller should proceed normally.
 *
 * A null/empty messageId always returns false (nothing to dedup on) — the
 * caller proceeds; this matches the existing wa_message_id /
 * chatwoot_message_id columns, which are nullable for the same reason.
 */
export async function claimInboundMessageId(
  messageId: string | null | undefined,
): Promise<boolean> {
  if (!messageId) return false;

  try {
    await prisma.inboundDedup.create({ data: { message_id: messageId } });
    return false; // newly claimed — first delivery, proceed
  } catch (err: any) {
    if (err?.code === 'P2002') {
      // Unique constraint hit: another request (this path, or the other
      // path) already claimed this wamid. The FIRST claimant proceeds; every
      // subsequent one — same path retry or cross-path duplicate — stops here.
      return true;
    }
    // Unexpected DB error: fail OPEN. A transient dedup-table error must
    // never silently drop a legitimate customer message — matches this
    // codebase's existing fail-open convention for non-critical guards
    // (e.g. Chatwoot mirror failures in lib/agent.ts mirrorInbound()).
    console.error('[inbound-dedup] claim error — failing open (message will be processed):', err?.message ?? err);
    return false;
  }
}
