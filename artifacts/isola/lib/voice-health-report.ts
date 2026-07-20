/**
 * lib/voice-health-report.ts — shared report builder for the operator Voice
 * Health page and its API route, so both consumers (app/admin/voice-health/
 * page.tsx and app/api/admin/voice-health/route.ts) compute the identical
 * report without one calling the other over HTTP.
 */
import { prisma } from './prisma';
import { getMagnusConfig } from './engines';
import { computeVoiceLineHealth, summarize, type VoiceLineRecord, type HealthStatus, type HealthColor } from './voice-health';

export interface VoiceHealthLine {
  id: string;
  ownerName: string;
  ownerKind: 'business' | 'consumer';
  tenantId: string | null;
  did: string | null;
  magnusUserId: string | null;
  magnusSipId: string | null;
  provisioningState: string;
  createdAt: string;
  status: HealthStatus;
  color: HealthColor;
  mode: string;
  issues: string[];
}

export interface VoiceHealthReport {
  lines: VoiceHealthLine[];
  summary: { total: number; green: number; amber: number; red: number; gray: number };
  checkedAt: string;
}

// Sort order for the default (red-first, most severe at top) row ordering.
// Array.prototype.sort is stable, so lines within the same color keep the
// query's created_at desc ordering.
const COLOR_SORT_RANK: Record<HealthColor, number> = { red: 0, amber: 1, green: 2, gray: 3 };

export async function getVoiceHealthReport(): Promise<VoiceHealthReport> {
  const config = getMagnusConfig();

  // Explicit select (not include) — this list is exactly the fields the
  // report uses; in particular it must never pull magnus_sip_password or any
  // other VoiceLine secret column into memory.
  const voiceLines = await prisma.voiceLine.findMany({
    select: {
      id: true,
      owner_kind: true,
      identity_id: true,
      tenant_id: true,
      magnus_user_id: true,
      magnus_sip_id: true,
      magnus_callerid_id: true,
      magnus_did_id: true,
      magnus_did_number: true,
      magnus_diddestination_id: true,
      provisioning_state: true,
      created_at: true,
      tenant: { select: { business_name: true } },
      identity: { select: { display_name: true, phone: true } },
    },
    orderBy: { created_at: 'desc' },
  });

  // Legacy-dup cross-check: pre-VoiceLine-model ConsumerAccount rows that
  // still carry their own magnus_sip_id/magnus_did_number can duplicate a
  // resource a VoiceLine row now also owns (see Task A's retirement of
  // +17672859610 for the canonical example). Only fetch the columns needed
  // to build the lookup maps.
  const legacyConsumerAccounts = await prisma.consumerAccount.findMany({
    where: { OR: [{ magnus_sip_id: { not: null } }, { magnus_did_number: { not: null } }] },
    select: { id: true, magnus_sip_id: true, magnus_did_number: true },
  });
  const dupsBySipId = new Map<string, string[]>();
  const dupsByDidNumber = new Map<string, string[]>();
  for (const ca of legacyConsumerAccounts) {
    if (ca.magnus_sip_id) dupsBySipId.set(ca.magnus_sip_id, [...(dupsBySipId.get(ca.magnus_sip_id) ?? []), ca.id]);
    if (ca.magnus_did_number) dupsByDidNumber.set(ca.magnus_did_number, [...(dupsByDidNumber.get(ca.magnus_did_number) ?? []), ca.id]);
  }

  type ReportRecord = { record: VoiceLineRecord; tenantId: string | null; provisioningState: string; createdAt: string };

  const records: ReportRecord[] = voiceLines.map((vl) => ({
    record: {
      id: vl.id,
      ownerName:
        vl.owner_kind === 'business'
          ? (vl.tenant?.business_name ?? `tenant:${vl.tenant_id}`)
          : (vl.identity?.display_name ?? vl.identity?.phone ?? `identity:${vl.identity_id}`),
      ownerKind: vl.owner_kind === 'business' ? 'business' : 'consumer',
      did: vl.magnus_did_number,
      magnusUserId: vl.magnus_user_id,
      magnusSipId: vl.magnus_sip_id,
      magnusCallerIdId: vl.magnus_callerid_id,
      magnusDidId: vl.magnus_did_id,
      magnusDidDestinationId: vl.magnus_diddestination_id,
      provisioningState: vl.provisioning_state,
    },
    tenantId: vl.tenant_id,
    provisioningState: vl.provisioning_state,
    createdAt: vl.created_at.toISOString(),
  }));

  const results = await Promise.all(
    records.map(async ({ record, tenantId, provisioningState, createdAt }) => {
      const legacyDuplicateAccountIds = Array.from(
        new Set([
          ...(record.magnusSipId ? (dupsBySipId.get(record.magnusSipId) ?? []) : []),
          ...(record.did ? (dupsByDidNumber.get(record.did) ?? []) : []),
        ]),
      );
      return {
        record,
        tenantId,
        provisioningState,
        createdAt,
        health: await computeVoiceLineHealth(config, record, legacyDuplicateAccountIds),
      };
    }),
  );

  const lines: VoiceHealthLine[] = results.map((r) => ({
    id: r.record.id,
    ownerName: r.record.ownerName,
    ownerKind: r.record.ownerKind,
    tenantId: r.tenantId,
    did: r.record.did,
    magnusUserId: r.record.magnusUserId,
    magnusSipId: r.record.magnusSipId,
    provisioningState: r.provisioningState,
    createdAt: r.createdAt,
    status: r.health.status,
    color: r.health.color,
    mode: r.health.mode,
    issues: r.health.issues,
  }));

  lines.sort((a, b) => COLOR_SORT_RANK[a.color] - COLOR_SORT_RANK[b.color]);

  return {
    lines,
    summary: summarize(results.map((r) => r.health)),
    checkedAt: new Date().toISOString(),
  };
}
