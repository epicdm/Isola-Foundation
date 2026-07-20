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
  did: string | null;
  magnusUserId: string | null;
  magnusSipId: string | null;
  status: HealthStatus;
  color: HealthColor;
  mode: string;
  issues: string[];
}

export interface VoiceHealthReport {
  lines: VoiceHealthLine[];
  summary: { total: number; green: number; amber: number; red: number };
  checkedAt: string;
}

export async function getVoiceHealthReport(): Promise<VoiceHealthReport> {
  const config = getMagnusConfig();

  const voiceLines = await prisma.voiceLine.findMany({
    include: {
      tenant: { select: { business_name: true } },
      identity: { select: { display_name: true, phone: true } },
    },
    orderBy: { created_at: 'desc' },
  });

  const records: VoiceLineRecord[] = voiceLines.map((vl) => ({
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
  }));

  const results = await Promise.all(
    records.map(async (record) => ({
      line: record,
      health: await computeVoiceLineHealth(config, record),
    })),
  );

  const lines: VoiceHealthLine[] = results.map((r) => ({
    id: r.line.id,
    ownerName: r.line.ownerName,
    ownerKind: r.line.ownerKind,
    did: r.line.did,
    magnusUserId: r.line.magnusUserId,
    magnusSipId: r.line.magnusSipId,
    status: r.health.status,
    color: r.health.color,
    mode: r.health.mode,
    issues: r.health.issues,
  }));

  return {
    lines,
    summary: summarize(results.map((r) => r.health)),
    checkedAt: new Date().toISOString(),
  };
}
