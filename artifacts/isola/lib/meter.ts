/**
 * Usage metering helpers.
 * Debits minutes (calls) and tokens (AI) against the current monthly period.
 */

import { prisma } from './prisma';
import { TIER_COST_PER_1K } from './ai';

/** USD per call-minute — $0.10/min. */
const MINUTES_COST_PER_MIN = 0.10;

function currentPeriod(): { start: Date; end: Date } {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
  return { start, end };
}

/** Meter AI token usage for a completed Anthropic call. */
export async function meterTokens(
  tenantId: string,
  tokens: number,
  model: string,
): Promise<void> {
  if (tokens <= 0) return;
  const { start, end } = currentPeriod();
  const costPer1k = TIER_COST_PER_1K[model] ?? 0.004;
  const cost = (tokens / 1000) * costPer1k;

  await prisma.usageMeter.upsert({
    where: { tenant_id_period_start: { tenant_id: tenantId, period_start: start } },
    create: {
      tenant_id: tenantId,
      period_start: start,
      period_end: end,
      tokens_used: tokens,
      tokens_cost: parseFloat(cost.toFixed(6)),
    },
    update: {
      tokens_used: { increment: tokens },
      tokens_cost: { increment: parseFloat(cost.toFixed(6)) },
    },
  });
}

/** Meter call minutes from a Magnus CDR duration (seconds). */
export async function meterMinutes(
  tenantId: string,
  durationSeconds: number,
): Promise<void> {
  if (durationSeconds <= 0) return;
  const { start, end } = currentPeriod();
  const minutes = durationSeconds / 60;
  const cost = minutes * MINUTES_COST_PER_MIN;

  await prisma.usageMeter.upsert({
    where: { tenant_id_period_start: { tenant_id: tenantId, period_start: start } },
    create: {
      tenant_id: tenantId,
      period_start: start,
      period_end: end,
      minutes_used: parseFloat(minutes.toFixed(4)),
      minutes_cost: parseFloat(cost.toFixed(4)),
    },
    update: {
      minutes_used: { increment: parseFloat(minutes.toFixed(4)) },
      minutes_cost: { increment: parseFloat(cost.toFixed(4)) },
    },
  });
}

/**
 * Sync call minutes from Magnus CDR (idempotent — sets totals rather than
 * incrementing, so calling this on every CDR fetch never double-counts).
 */
export async function syncMinutesFromCDR(
  tenantId: string,
  totalBillsec: number,
): Promise<void> {
  const { start, end } = currentPeriod();
  const minutes = totalBillsec / 60;
  const cost = minutes * MINUTES_COST_PER_MIN;

  await prisma.usageMeter.upsert({
    where: { tenant_id_period_start: { tenant_id: tenantId, period_start: start } },
    create: {
      tenant_id: tenantId,
      period_start: start,
      period_end: end,
      minutes_used: parseFloat(minutes.toFixed(4)),
      minutes_cost: parseFloat(cost.toFixed(4)),
    },
    update: {
      // SET (not increment) — CDR is the source of truth for call minutes
      minutes_used: parseFloat(minutes.toFixed(4)),
      minutes_cost: parseFloat(cost.toFixed(4)),
    },
  });
}

/** Fetch the current-period usage for a tenant. */
export async function getCurrentUsage(tenantId: string) {
  const { start } = currentPeriod();
  return prisma.usageMeter.findUnique({
    where: { tenant_id_period_start: { tenant_id: tenantId, period_start: start } },
  });
}

/**
 * Fetch up to `months` most recent monthly UsageMeter rows for a tenant,
 * oldest first — used to render real usage-over-time charts. Read-only,
 * additive helper; does not affect metering/billing logic above.
 */
export async function getUsageHistory(tenantId: string, months = 6) {
  const rows = await prisma.usageMeter.findMany({
    where: { tenant_id: tenantId },
    orderBy: { period_start: 'desc' },
    take: months,
  });
  return rows.reverse();
}
