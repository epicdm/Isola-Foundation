/**
 * Voice Resource Health Check — Task 1, STRICTLY READ-ONLY.
 *
 * Cross-references Neon (Tenant / VoiceLine / ConsumerAccount) against live
 * Magnus (voice00) sip/callerid/did/diddestination rows, and reuses the
 * existing degraded-routing classifier (lib/voice-routing.ts) per line.
 * Never issues a Magnus `save`/`refill` action and never writes to Neon.
 *
 * Orphan scan is scoped to Magnus rows that follow Isola's own conventions —
 * sip.name LIKE 'ep_%' or 'ema_%' (see genMagnusUsername/genConsumerMagnusUsername
 * in lib/magnus-voice.ts), did.did LIKE '1767818%' (the DID_SELECTOR_LAWS pool
 * in the same file). Magnus is a shared billing instance serving other EPIC
 * products (e.g. AcmetelUSALLC-style wholesale/trunk accounts) — rows outside
 * this naming scope are not evaluated and are neither claimed orphaned nor clean.
 *
 * Usage:
 *   DATABASE_URL="<neon>" MAGNUS_URL=... MAGNUS_API_KEY=... MAGNUS_API_SECRET=... \
 *     npx tsx scripts/voice-health-audit.ts
 */
import { PrismaClient } from '@prisma/client';
import { getMagnusConfig, isMagnusConfigured } from '../lib/engines';
import { magnusRequest, type MagnusConfig } from '../engines/magnus';
import { readSipAccount, readDidDestination, findDidDestinationForSip } from '../lib/magnus-voice';
import { readVoiceRoutingSnapshot, deriveVoiceRoutingMode } from '../lib/voice-routing';

const prisma = new PrismaClient();

const CALLOUT_DID = '17678182220';

type Health = 'OK' | 'DEGRADED' | 'MISMATCH' | 'MISSING' | 'ORPHAN' | 'COLLISION';

interface Row {
  ownerName: string;
  ownerId: string;
  ownerKey: string; // canonical real-world-owner key used for DID collision comparison
  ownerKind: string; // 'tenant' | 'consumer' | 'tenant-legacy' | 'consumer-legacy' | 'magnus-orphan'
  did: string | null;
  magnusUserSip: string | null; // "user=<id> sip=<id>"
  mode: string;
  health: Health;
  issues: string[];
}

function mask(s: string | null | undefined): string {
  if (!s) return '(none)';
  return s.length <= 4 ? '*'.repeat(s.length) : s.slice(0, 3) + '*'.repeat(s.length - 6) + s.slice(-3);
}

async function findOneById(config: MagnusConfig, module: string, id: string): Promise<Record<string, any> | null> {
  if (!id) return null;
  try {
    const res = await magnusRequest(config, module, 'read', {
      page: '1', start: '0', limit: '1',
      filter: JSON.stringify([{ type: 'numeric', field: 'id', value: id, comparison: 'eq' }]),
    });
    return res?.rows?.[0] ?? null;
  } catch (e: any) {
    return null;
  }
}

async function readAllRows(
  config: MagnusConfig,
  module: string,
  filter: Array<{ type: string; field: string; value: string; comparison: string }>,
  pageSize = 200,
  capPages = 25,
): Promise<{ rows: any[]; truncated: boolean }> {
  let start = 0;
  const all: any[] = [];
  for (let i = 0; i < capPages; i++) {
    const res = await magnusRequest(config, module, 'read', {
      page: String(i + 1), start: String(start), limit: String(pageSize), filter: JSON.stringify(filter),
    });
    const rows: any[] = res?.rows ?? [];
    all.push(...rows);
    if (rows.length < pageSize) return { rows: all, truncated: false };
    start += pageSize;
  }
  return { rows: all, truncated: true };
}

function addIssue(row: Row, health: Health, issue: string) {
  row.issues.push(issue);
  const precedence: Health[] = ['COLLISION', 'MISMATCH', 'MISSING', 'DEGRADED', 'ORPHAN', 'OK'];
  if (precedence.indexOf(health) < precedence.indexOf(row.health)) row.health = health;
}

async function main() {
  if (!isMagnusConfigured()) {
    console.error('Magnus not configured — set MAGNUS_URL, MAGNUS_API_KEY, MAGNUS_API_SECRET');
    process.exit(1);
  }
  const config = getMagnusConfig();

  console.log('=== Voice Resource Health Check (READ-ONLY) ===');
  console.log(`DATABASE_URL host: ${new URL(process.env.DATABASE_URL || '').host}`);
  console.log(`MAGNUS_URL: ${process.env.MAGNUS_URL}\n`);

  const [tenants, consumers, voiceLines] = await Promise.all([
    prisma.tenant.findMany({
      select: {
        id: true, business_name: true, voice_provisioning_state: true,
        magnus_user_id: true, magnus_sip_id: true, magnus_callerid_id: true,
        magnus_did_id: true, magnus_did_number: true, magnus_diddestination_id: true,
        voice_forward_to_cell: true, voice_cell_number: true,
      },
    }),
    prisma.consumerAccount.findMany({
      select: {
        id: true, phone_number: true, display_name: true, voice_provisioning_state: true,
        magnus_user_id: true, magnus_sip_id: true, magnus_callerid_id: true,
        magnus_did_id: true, magnus_did_number: true, magnus_diddestination_id: true,
        voice_forward_to_cell: true, voice_cell_number: true,
      },
    }),
    prisma.voiceLine.findMany({
      include: {
        tenant: { select: { business_name: true } },
        identity: { select: { display_name: true, phone: true } },
      },
    }),
  ]);

  console.log(`Loaded: ${tenants.length} Tenant, ${consumers.length} ConsumerAccount, ${voiceLines.length} VoiceLine rows.\n`);

  const rows: Row[] = [];
  // DID -> distinct owner keys referencing it (for collision detection).
  const didOwners = new Map<string, Set<string>>();
  // Sets of every Magnus id referenced anywhere in the DB, for orphan detection.
  const referencedSipIds = new Set<string>();
  const referencedDidIds = new Set<string>();
  const referencedDidDestIds = new Set<string>();

  function trackDid(did: string | null | undefined, ownerKey: string) {
    if (!did) return;
    if (!didOwners.has(did)) didOwners.set(did, new Set());
    didOwners.get(did)!.add(ownerKey);
  }
  function trackRefs(sipId?: string | null, didId?: string | null, ddId?: string | null) {
    if (sipId) referencedSipIds.add(String(sipId));
    if (didId) referencedDidIds.add(String(didId));
    if (ddId) referencedDidDestIds.add(String(ddId));
  }

  // ── VoiceLine rows: the canonical per-line record ──────────────────────────
  const voiceLineByTenant = new Map<string, (typeof voiceLines)[number][]>();
  const voiceLineByOwnerKey = new Map<string, (typeof voiceLines)[number]>();

  for (const vl of voiceLines) {
    const ownerKind = vl.owner_kind;
    let ownerName = `(unknown ${ownerKind})`;
    let ownerId = vl.tenant_id || vl.identity_id || vl.id;
    if (ownerKind === 'business') {
      ownerName = vl.tenant?.business_name ?? `tenant:${vl.tenant_id}`;
    } else if (ownerKind === 'consumer') {
      ownerName = vl.identity?.display_name ?? vl.identity?.phone ?? `identity:${vl.identity_id}`;
    }

    // Canonical owner key — same basis Tenant/ConsumerAccount rows use below, so
    // the SAME real-world owner recorded in two tables (VoiceLine + legacy
    // Tenant/ConsumerAccount dual-write) collapses to one Set entry instead of
    // falsely flagging as a DID collision with itself.
    const ownerKey = ownerKind === 'business' ? `tenant:${vl.tenant_id}` : `identity:${vl.identity_id}`;

    const row: Row = {
      ownerName,
      ownerId,
      ownerKey,
      ownerKind: `voiceline:${ownerKind}`,
      did: vl.magnus_did_number,
      magnusUserSip: `user=${vl.magnus_user_id ?? '-'} sip=${vl.magnus_sip_id ?? '-'}`,
      mode: '-',
      health: 'OK',
      issues: [],
    };

    // 1. ASSIGNMENT — exactly one owner reference.
    const hasTenant = !!vl.tenant_id;
    const hasIdentity = !!vl.identity_id;
    if (hasTenant === hasIdentity) {
      addIssue(row, 'MISMATCH', `ASSIGNMENT: owner_kind=${ownerKind} but tenant_id=${mask(vl.tenant_id)} identity_id=${mask(vl.identity_id)} (expected exactly one set)`);
    }
    if (ownerKind === 'business' && vl.tenant_id) voiceLineByTenant.set(vl.tenant_id, [...(voiceLineByTenant.get(vl.tenant_id) ?? []), vl]);
    voiceLineByOwnerKey.set(`${ownerKind}:${vl.tenant_id ?? vl.identity_id}`, vl);

    trackRefs(vl.magnus_sip_id, vl.magnus_did_id, vl.magnus_diddestination_id);

    // 2. DID
    if (vl.provisioning_state === 'completed' && !vl.magnus_did_number) {
      addIssue(row, 'MISSING', 'DID: provisioning_state=completed but magnus_did_number is empty');
    }
    trackDid(vl.magnus_did_number, ownerKey);

    // 3. DB<->MAGNUS
    if (vl.magnus_sip_id) {
      const sip = await readSipAccount(config, vl.magnus_sip_id);
      if (!sip) {
        addIssue(row, 'MISSING', `DB↔MAGNUS: magnus_sip_id=${vl.magnus_sip_id} does not resolve to a live sip row`);
      } else if (vl.magnus_did_number && sip.cid_number && sip.cid_number !== vl.magnus_did_number) {
        addIssue(row, 'MISMATCH', `DB↔MAGNUS: sip.cid_number=${sip.cid_number} != VoiceLine.magnus_did_number=${vl.magnus_did_number}`);
      }
    }
    if (vl.magnus_did_id) {
      const didRow = await findOneById(config, 'did', vl.magnus_did_id);
      if (!didRow) {
        addIssue(row, 'MISSING', `DB↔MAGNUS: magnus_did_id=${vl.magnus_did_id} does not resolve to a live did row`);
      } else if (vl.magnus_did_number && String(didRow.did) !== vl.magnus_did_number) {
        addIssue(row, 'MISMATCH', `DB↔MAGNUS: did.did=${didRow.did} != VoiceLine.magnus_did_number=${vl.magnus_did_number}`);
      }
    }
    if (vl.magnus_callerid_id) {
      const cidRow = await findOneById(config, 'callerid', vl.magnus_callerid_id);
      if (!cidRow) {
        addIssue(row, 'MISSING', `DB↔MAGNUS: magnus_callerid_id=${vl.magnus_callerid_id} does not resolve to a live callerid row`);
      } else if (vl.magnus_did_number && String(cidRow.cid) !== vl.magnus_did_number) {
        addIssue(row, 'MISMATCH', `DB↔MAGNUS: callerid.cid=${cidRow.cid} != VoiceLine.magnus_did_number=${vl.magnus_did_number}`);
      }
    }
    if (vl.magnus_diddestination_id) {
      const dd = await readDidDestination(config, vl.magnus_diddestination_id);
      if (!dd) {
        addIssue(row, 'MISSING', `DB↔MAGNUS: magnus_diddestination_id=${vl.magnus_diddestination_id} does not resolve to a live diddestination row`);
      } else if (vl.magnus_sip_id && dd.id_sip && dd.id_sip !== vl.magnus_sip_id) {
        addIssue(row, 'MISMATCH', `DB↔MAGNUS: diddestination.id_sip=${dd.id_sip} != VoiceLine.magnus_sip_id=${vl.magnus_sip_id}`);
      }
    }

    // 4. ROUTING HEALTH — reuse existing degraded-detection.
    if (vl.magnus_did_id && vl.magnus_did_number) {
      try {
        const snapshot = await readVoiceRoutingSnapshot(config, vl.magnus_did_id, vl.magnus_did_number);
        const state = deriveVoiceRoutingMode(snapshot);
        row.mode = state.mode;
        if (state.mode === 'degraded' || state.mode === 'unknown') {
          addIssue(row, 'DEGRADED', `ROUTING: mode=${state.mode}${state.reason ? ` — ${state.reason}` : ''}`);
        }
      } catch (e: any) {
        row.mode = 'error';
        addIssue(row, 'DEGRADED', `ROUTING: snapshot read threw — ${e?.message ?? e}`);
      }
    } else if (vl.provisioning_state === 'completed') {
      addIssue(row, 'MISSING', 'ROUTING: provisioning_state=completed but magnus_did_id/magnus_did_number missing — cannot evaluate live routing');
    }

    rows.push(row);
  }

  // ── Tenant rows: legacy dual-write fields, cross-check against VoiceLine ───
  for (const t of tenants) {
    const vl = voiceLineByTenant.get(t.id)?.[0];
    trackDid(t.magnus_did_number, `tenant:${t.id}`);
    trackRefs(t.magnus_sip_id, t.magnus_did_id, t.magnus_diddestination_id);

    if (t.voice_provisioning_state === 'completed' && !vl) {
      const row: Row = {
        ownerName: t.business_name, ownerId: t.id, ownerKey: `tenant:${t.id}`, ownerKind: 'tenant-legacy',
        did: t.magnus_did_number, magnusUserSip: `user=${t.magnus_user_id ?? '-'} sip=${t.magnus_sip_id ?? '-'}`,
        mode: '-', health: 'OK', issues: [],
      };
      addIssue(row, 'MISSING', 'ASSIGNMENT: Tenant.voice_provisioning_state=completed but no resolvable VoiceLine row (tenant_id) exists');
      rows.push(row);
      continue;
    }
    if (vl) {
      const mismatches: string[] = [];
      if (t.magnus_sip_id && vl.magnus_sip_id && t.magnus_sip_id !== vl.magnus_sip_id) mismatches.push(`magnus_sip_id: Tenant=${t.magnus_sip_id} VoiceLine=${vl.magnus_sip_id}`);
      if (t.magnus_did_id && vl.magnus_did_id && t.magnus_did_id !== vl.magnus_did_id) mismatches.push(`magnus_did_id: Tenant=${t.magnus_did_id} VoiceLine=${vl.magnus_did_id}`);
      if (t.magnus_did_number && vl.magnus_did_number && t.magnus_did_number !== vl.magnus_did_number) mismatches.push(`magnus_did_number: Tenant=${t.magnus_did_number} VoiceLine=${vl.magnus_did_number}`);
      if (t.magnus_diddestination_id && vl.magnus_diddestination_id && t.magnus_diddestination_id !== vl.magnus_diddestination_id) mismatches.push(`magnus_diddestination_id: Tenant=${t.magnus_diddestination_id} VoiceLine=${vl.magnus_diddestination_id}`);
      if (t.magnus_callerid_id && vl.magnus_callerid_id && t.magnus_callerid_id !== vl.magnus_callerid_id) mismatches.push(`magnus_callerid_id: Tenant=${t.magnus_callerid_id} VoiceLine=${vl.magnus_callerid_id}`);
      if (mismatches.length) {
        const row: Row = {
          ownerName: t.business_name, ownerId: t.id, ownerKey: `tenant:${t.id}`, ownerKind: 'tenant-legacy',
          did: t.magnus_did_number, magnusUserSip: `user=${t.magnus_user_id ?? '-'} sip=${t.magnus_sip_id ?? '-'}`,
          mode: '-', health: 'OK', issues: [],
        };
        for (const m of mismatches) addIssue(row, 'MISMATCH', `Tenant vs VoiceLine disagreement — ${m}`);
        rows.push(row);
      }
    }
  }

  // ── ConsumerAccount rows: legacy, no FK to VoiceLine — correlate by magnus ids ─
  const voiceLineSipIds = new Set(voiceLines.map((v) => v.magnus_sip_id).filter(Boolean));
  for (const c of consumers) {
    const ownerKey = `consumeracct:${c.id}`;
    trackDid(c.magnus_did_number, ownerKey);
    trackRefs(c.magnus_sip_id, c.magnus_did_id, c.magnus_diddestination_id);

    const hasMatchingVoiceLine = c.magnus_sip_id && voiceLineSipIds.has(c.magnus_sip_id);
    if (c.voice_provisioning_state === 'completed' && !hasMatchingVoiceLine) {
      const row: Row = {
        ownerName: c.display_name ?? c.phone_number, ownerId: c.id, ownerKey, ownerKind: 'consumer-legacy',
        did: c.magnus_did_number, magnusUserSip: `user=${c.magnus_user_id ?? '-'} sip=${c.magnus_sip_id ?? '-'}`,
        mode: '-', health: 'OK', issues: [],
      };
      addIssue(row, 'MISSING', 'ASSIGNMENT: ConsumerAccount.voice_provisioning_state=completed but no VoiceLine shares its magnus_sip_id — likely un-migrated to the VoiceLine model');
      rows.push(row);
    }
  }

  // ── DID collisions — same DID referenced by >1 distinct real-world owner ───
  // (Tenant + its own VoiceLine dual-writing the same DID share one ownerKey
  // and are NOT a collision — only a genuinely different owner entity is.)
  for (const [did, owners] of didOwners) {
    if (owners.size > 1) {
      for (const r of rows) {
        if (r.did === did && owners.has(r.ownerKey)) {
          const others = [...owners].filter((o) => o !== r.ownerKey);
          if (others.length) addIssue(r, 'COLLISION', `DID ${did} is also referenced by: ${others.join(', ')}`);
        }
      }
    }
  }

  // ── Orphan scan — Isola-scoped only (see header) ────────────────────────────
  // NOTE: Magnus's grid `cn` (contains) filter does not reliably scope the
  // `sip.name` field server-side (confirmed live: a name='ep_' cn filter
  // returned the full unfiltered sip table). Fetch broadly and apply the
  // ep_/ema_ scope as a LOCAL regex instead of trusting the server-side filter.
  console.log('--- Orphan scan (Isola-scoped: sip.name ep_%/ema_%, did.did 1767818%) ---');
  const [allSip, didPool] = await Promise.all([
    readAllRows(config, 'sip', []),
    readAllRows(config, 'did', [{ type: 'string', field: 'did', value: '1767818', comparison: 'cn' }]),
  ]);
  if (allSip.truncated || didPool.truncated) {
    console.warn('WARNING: one or more orphan-scan pages hit the pagination cap — results may be incomplete, NOT silently truncated without notice.');
  }
  const isolaSip = allSip.rows.filter((r) => /^ep_/i.test(String(r.name ?? '')) || /^ema_/i.test(String(r.name ?? '')));
  const isolaDidPool = didPool.rows.filter((r) => /^1767818\d{4}$/.test(String(r.did ?? '')));
  console.log(`Magnus instance total sip rows scanned: ${allSip.rows.length} (Isola-scoped: ${isolaSip.length}); did pool scanned: ${didPool.rows.length} (Isola-scoped: ${isolaDidPool.length})`);

  for (const sip of isolaSip) {
    if (!referencedSipIds.has(String(sip.id))) {
      rows.push({
        ownerName: `Magnus sip "${sip.name}" (id_user=${sip.id_user ?? '-'})`, ownerId: String(sip.id), ownerKey: '', ownerKind: 'magnus-orphan-sip',
        did: sip.cid_number || null, magnusUserSip: `user=${sip.id_user ?? '-'} sip=${sip.id}`,
        mode: '-', health: 'ORPHAN', issues: [`ORPHAN: Magnus sip row id=${sip.id} name=${sip.name} not referenced by any Tenant/ConsumerAccount/VoiceLine magnus_sip_id`],
      });
    }
    // diddestination orphan check, bounded to this Isola sip account.
    try {
      const dd = await findDidDestinationForSip(config, String(sip.id));
      if (dd && !referencedDidDestIds.has(String(dd.id))) {
        rows.push({
          ownerName: `Magnus diddestination (sip="${sip.name}")`, ownerId: String(dd.id), ownerKey: '', ownerKind: 'magnus-orphan-diddestination',
          did: sip.cid_number || null, magnusUserSip: `sip=${sip.id}`,
          mode: '-', health: 'ORPHAN', issues: [`ORPHAN: Magnus diddestination row id=${dd.id} (id_sip=${sip.id}) not referenced by any *.magnus_diddestination_id`],
        });
      }
    } catch (e: any) {
      // ConflictingDidDestinationsError or transient — surface, don't silently drop.
      rows.push({
        ownerName: `Magnus sip "${sip.name}"`, ownerId: String(sip.id), ownerKey: '', ownerKind: 'magnus-orphan-diddestination',
        did: sip.cid_number || null, magnusUserSip: `sip=${sip.id}`,
        mode: '-', health: 'MISMATCH', issues: [`diddestination lookup for sip=${sip.id} failed/conflicted: ${e?.message ?? e}`],
      });
    }
  }
  for (const did of isolaDidPool) {
    const assigned = did.id_user !== null && did.id_user !== undefined && did.id_user !== '';
    if (assigned && !referencedDidIds.has(String(did.id))) {
      rows.push({
        ownerName: `Magnus did ${did.did} (id_user=${did.id_user})`, ownerId: String(did.id), ownerKey: '', ownerKind: 'magnus-orphan-did',
        did: String(did.did), magnusUserSip: `user=${did.id_user}`,
        mode: '-', health: 'ORPHAN', issues: [`ORPHAN: Magnus did row id=${did.id} did=${did.did} is assigned (id_user=${did.id_user}) but not referenced by any *.magnus_did_id`],
      });
    }
  }

  // ── Explicit callout: DID 17678182220 ───────────────────────────────────────
  console.log(`\n--- CALLOUT: DID ${CALLOUT_DID} ---`);
  const calloutRows = rows.filter((r) => r.did === CALLOUT_DID);
  if (calloutRows.length === 0) {
    console.log(`No DB row (Tenant/ConsumerAccount/VoiceLine) references DID ${CALLOUT_DID}.`);
    const liveDid = await magnusRequest(config, 'did', 'read', {
      page: '1', start: '0', limit: '1',
      filter: JSON.stringify([{ type: 'string', field: 'did', value: CALLOUT_DID, comparison: 'eq' }]),
    }).catch((e: any) => null);
    const didRow = liveDid?.rows?.[0];
    console.log('Live Magnus did row:', didRow ? JSON.stringify(didRow) : '(not found)');
  } else {
    for (const r of calloutRows) console.log(JSON.stringify(r, null, 2));
  }

  // ── Report ──────────────────────────────────────────────────────────────────
  console.log('\n=== FULL TABLE ===');
  console.log('owner | ownerId | ownerKind | DID | magnusUserSip | mode | HEALTH | issues');
  for (const r of rows) {
    console.log(`${r.ownerName} | ${r.ownerId} | ${r.ownerKind} | ${r.did ?? '-'} | ${r.magnusUserSip} | ${r.mode} | ${r.health} | ${r.issues.join(' ;; ')}`);
  }

  const counts: Record<string, number> = {};
  for (const r of rows) counts[r.health] = (counts[r.health] ?? 0) + 1;
  console.log('\n=== SUMMARY ===');
  console.log(JSON.stringify(counts, null, 2));
  console.log(`Total rows reported: ${rows.length}`);

  console.log('\n===JSON_START===');
  console.log(JSON.stringify({ rows, counts }, null, 2));
  console.log('===JSON_END===');
}

main()
  .catch((e) => {
    console.error('ERR', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
