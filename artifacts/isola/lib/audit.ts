/**
 * Audit log helper — records every significant mutation.
 * Fire-and-forget: never throws, logs to console on error.
 */

import type { Prisma } from '@prisma/client';
import { prisma } from './prisma';

/**
 * Exactly one of `tenantId` / `consumerAccountId` must be set — mirrors the
 * nullable dual-FK on AuditLog itself. The consumer-account variant exists
 * for the P2 consumer phone-OTP auth realm (signup/session events); it does
 * not change behavior for any existing tenant-scoped call site.
 */
export async function audit(params: {
  tenantId?: string;
  consumerAccountId?: string;
  actorId: string;
  action: string;
  entity?: string;
  entityId?: string;
  requestId?: string;
  meta?: Record<string, unknown>;
}): Promise<void> {
  if (!params.tenantId && !params.consumerAccountId) {
    console.error('[audit] Neither tenantId nor consumerAccountId set — skipping', params.action);
    return;
  }
  try {
    await prisma.auditLog.create({
      data: {
        tenant_id: params.tenantId,
        consumer_account_id: params.consumerAccountId,
        actor_id: params.actorId,
        action: params.action,
        entity: params.entity,
        entity_id: params.entityId,
        request_id: params.requestId,
        // Serialise through JSON to satisfy Prisma's InputJsonValue type
        meta: (params.meta ? JSON.parse(JSON.stringify(params.meta)) : {}) as Prisma.InputJsonValue,
      },
    });
  } catch (err) {
    console.error('[audit] Failed to write audit log:', err);
  }
}
