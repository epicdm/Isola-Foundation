/**
 * Unify Identity — Phase B: idempotent backfill.
 *
 * Populates Identity/Membership/VoiceLine + the identity_id links added in
 * Phase A, from existing ConsumerAccount/Tenant/User/Wallet rows. Data-only:
 * nothing reads these new tables yet, so this is safe to run repeatedly and
 * safe to roll back (see PR description).
 *
 * Usage:
 *   DATABASE_URL="<neon>" npx tsx scripts/backfill-identity-phase-b.ts --dry-run
 *   DATABASE_URL="<neon>" npx tsx scripts/backfill-identity-phase-b.ts --apply
 */
import { PrismaClient, Prisma } from '@prisma/client';

const prisma = new PrismaClient();
type Db = PrismaClient | Prisma.TransactionClient;

const APPLY = process.argv.includes('--apply');
const DRY_RUN = !APPLY;

function hasVoice(row: {
  magnus_user_id: string | null;
  voice_provisioning_state: string;
}): boolean {
  return row.magnus_user_id !== null || row.voice_provisioning_state !== 'none';
}

// In APPLY mode, run `fn` inside a transaction scoped to one source row
// (one ConsumerAccount or one Tenant). In DRY_RUN mode, just read via the
// shared client — nothing is written either way.
async function withTx<T>(fn: (db: Db) => Promise<T>): Promise<T> {
  if (APPLY) return prisma.$transaction((tx) => fn(tx));
  return fn(prisma);
}

const counts = {
  identity_created: 0,
  identity_linked_existing: 0,
  voice_line_created_consumer: 0,
  voice_line_skipped_existing_consumer: 0,
  voice_line_created_business: 0,
  voice_line_skipped_existing_business: 0,
  wallet_linked: 0,
  wallet_already_linked: 0,
  membership_created: 0,
  membership_already_existed: 0,
  user_identity_linked: 0,
};

type EdgeEntry = { kind: string; detail: string };
const edges: EdgeEntry[] = [];

async function backfillConsumerAccount(ca: {
  id: string;
  phone_number: string;
  display_name: string | null;
  magnus_user_id: string | null;
  magnus_sip_id: string | null;
  magnus_sip_username: string | null;
  magnus_sip_password: string | null;
  magnus_callerid_id: string | null;
  magnus_did_id: string | null;
  magnus_did_number: string | null;
  magnus_diddestination_id: string | null;
  voice_forward_to_cell: boolean;
  voice_cell_number: string | null;
  voice_provisioning_state: string;
  voice_provisioning_error: string | null;
}) {
  await withTx(async (db) => {
    let identityId: string;

    const existing = await db.identity.findUnique({ where: { phone: ca.phone_number } });
    if (existing) {
      identityId = existing.id;
      counts.identity_linked_existing++;
      if (APPLY && ca.display_name && existing.display_name !== ca.display_name) {
        await db.identity.update({ where: { id: existing.id }, data: { display_name: ca.display_name } });
      }
    } else {
      counts.identity_created++;
      if (APPLY) {
        const created = await db.identity.create({
          data: { phone: ca.phone_number, display_name: ca.display_name },
        });
        identityId = created.id;
      } else {
        identityId = `DRY:${ca.phone_number}`;
      }
    }

    if (hasVoice(ca)) {
      const existingLine = existing
        ? await db.voiceLine.findFirst({ where: { identity_id: existing.id } })
        : APPLY
          ? await db.voiceLine.findFirst({ where: { identity_id: identityId } })
          : null; // fresh Identity in dry-run has no real id yet to look up by

      if (existingLine) {
        counts.voice_line_skipped_existing_consumer++;
      } else {
        counts.voice_line_created_consumer++;
        if (APPLY) {
          await db.voiceLine.create({
            data: {
              owner_kind: 'consumer',
              identity_id: identityId,
              magnus_user_id: ca.magnus_user_id,
              magnus_sip_id: ca.magnus_sip_id,
              magnus_sip_username: ca.magnus_sip_username,
              magnus_sip_password: ca.magnus_sip_password,
              magnus_callerid_id: ca.magnus_callerid_id,
              magnus_did_id: ca.magnus_did_id,
              magnus_did_number: ca.magnus_did_number,
              magnus_diddestination_id: ca.magnus_diddestination_id,
              voice_forward_to_cell: ca.voice_forward_to_cell,
              voice_cell_number: ca.voice_cell_number,
              provisioning_state: ca.voice_provisioning_state,
              provisioning_error: ca.voice_provisioning_error,
            },
          });
        }
      }
    }

    const wallet = await db.wallet.findUnique({ where: { consumer_account_id: ca.id } });
    if (wallet) {
      const alreadyLinked = existing ? wallet.identity_id === existing.id : false;
      if (alreadyLinked) {
        counts.wallet_already_linked++;
      } else {
        counts.wallet_linked++;
        if (APPLY) {
          await db.wallet.update({ where: { id: wallet.id }, data: { identity_id: identityId } });
        }
      }
    }
  });
}

async function resolveUserIdentity(
  db: Db,
  user: { id: string; replit_id: string | null; name: string | null },
  tenantOwnerPhone: string | null,
): Promise<string | null> {
  if (user.replit_id) {
    const byReplit = await db.identity.findUnique({ where: { replit_id: user.replit_id } });
    if (byReplit) return byReplit.id;
  }

  if (tenantOwnerPhone) {
    const byPhone = await db.identity.findUnique({ where: { phone: tenantOwnerPhone } });
    if (byPhone) {
      if (APPLY && user.replit_id && !byPhone.replit_id) {
        await db.identity.update({ where: { id: byPhone.id }, data: { replit_id: user.replit_id } });
      }
      return byPhone.id;
    }

    // Nothing found by either key — safe to create because we have a phone.
    counts.identity_created++;
    if (!APPLY) return `DRY:${tenantOwnerPhone}`;
    const created = await db.identity.create({
      data: { phone: tenantOwnerPhone, replit_id: user.replit_id, display_name: user.name },
    });
    return created.id;
  }

  // No owner_phone on the tenant. Identity.phone is nullable (spine/identity-
  // anchor-fix), so anchor by replit_id (login) alone when present — do not
  // fabricate a phone number.
  if (user.replit_id) {
    counts.identity_created++;
    if (!APPLY) return `DRY:replit:${user.replit_id}`;
    const created = await db.identity.create({
      data: { phone: null, replit_id: user.replit_id, display_name: user.name },
    });
    return created.id;
  }

  // Neither a phone anchor nor a login anchor is available. Do not
  // fabricate — report and skip.
  edges.push({
    kind: 'NEEDS_PHONE_OR_LOGIN',
    detail: `User ${user.id} — replit_id=MISSING, tenant owner_phone=MISSING`,
  });
  return null;
}

async function backfillTenant(t: {
  id: string;
  business_name: string;
  owner_phone: string | null;
  magnus_user_id: string | null;
  magnus_sip_id: string | null;
  magnus_sip_username: string | null;
  magnus_sip_password: string | null;
  magnus_callerid_id: string | null;
  magnus_did_id: string | null;
  magnus_did_number: string | null;
  magnus_diddestination_id: string | null;
  voice_forward_to_cell: boolean;
  voice_cell_number: string | null;
  voice_provisioning_state: string;
  voice_provisioning_error: string | null;
  users: { id: string; replit_id: string | null; name: string | null; role: string }[];
}) {
  if (!t.owner_phone) {
    edges.push({ kind: 'TENANT_MISSING_OWNER_PHONE', detail: `Tenant ${t.id} (${t.business_name})` });
  }

  await withTx(async (db) => {
    if (hasVoice(t)) {
      const existingLine = await db.voiceLine.findFirst({ where: { tenant_id: t.id } });
      if (existingLine) {
        counts.voice_line_skipped_existing_business++;
      } else {
        counts.voice_line_created_business++;
        if (APPLY) {
          await db.voiceLine.create({
            data: {
              owner_kind: 'business',
              tenant_id: t.id,
              magnus_user_id: t.magnus_user_id,
              magnus_sip_id: t.magnus_sip_id,
              magnus_sip_username: t.magnus_sip_username,
              magnus_sip_password: t.magnus_sip_password,
              magnus_callerid_id: t.magnus_callerid_id,
              magnus_did_id: t.magnus_did_id,
              magnus_did_number: t.magnus_did_number,
              magnus_diddestination_id: t.magnus_diddestination_id,
              voice_forward_to_cell: t.voice_forward_to_cell,
              voice_cell_number: t.voice_cell_number,
              provisioning_state: t.voice_provisioning_state,
              provisioning_error: t.voice_provisioning_error,
            },
          });
        }
      }
    }

    for (const u of t.users) {
      const identityId = await resolveUserIdentity(db, u, t.owner_phone);
      if (!identityId) continue; // NEEDS_PHONE already recorded

      counts.user_identity_linked++;
      if (APPLY) {
        await db.user.update({ where: { id: u.id }, data: { identity_id: identityId } });
      }

      const isDryFreshIdentity = identityId.startsWith('DRY:');
      const existingMembership = isDryFreshIdentity
        ? null
        : await db.membership.findUnique({
            where: { identity_id_tenant_id: { identity_id: identityId, tenant_id: t.id } },
          });

      if (existingMembership) {
        counts.membership_already_existed++;
      } else {
        counts.membership_created++;
        if (APPLY) {
          await db.membership.upsert({
            where: { identity_id_tenant_id: { identity_id: identityId, tenant_id: t.id } },
            create: { identity_id: identityId, tenant_id: t.id, role: u.role },
            update: {},
          });
        }
      }
    }
  });
}

async function verify() {
  const identityCount = await prisma.identity.count();
  const membershipCount = await prisma.membership.count();
  const voiceLineCount = await prisma.voiceLine.count();
  const identityPhones = (await prisma.identity.findMany({ select: { phone: true } }))
    .map((i) => i.phone)
    .filter((p): p is string => p !== null);
  const consumerAccountsWithoutIdentity = await prisma.consumerAccount.count({
    where: { phone_number: { notIn: identityPhones } },
  });

  console.log('\n=== VERIFY (post-run counts) ===');
  console.log(`Identity: ${identityCount}`);
  console.log(`Membership: ${membershipCount}`);
  console.log(`VoiceLine: ${voiceLineCount}`);
  console.log(`ConsumerAccount rows with no matching Identity: ${consumerAccountsWithoutIdentity}`);
}

async function main() {
  console.log(`=== Phase B backfill — mode: ${APPLY ? 'APPLY' : 'DRY-RUN'} ===`);
  console.log(`DATABASE_URL host: ${new URL(process.env.DATABASE_URL || '').host}`);

  const accounts = await prisma.consumerAccount.findMany();
  for (const ca of accounts) await backfillConsumerAccount(ca);

  const tenants = await prisma.tenant.findMany({ include: { users: true } });
  for (const t of tenants) await backfillTenant(t);

  console.log('\n=== COUNTS ===');
  for (const [k, v] of Object.entries(counts)) {
    console.log(`${k}: ${v}`);
  }

  console.log('\n=== EDGE REPORT ===');
  if (edges.length === 0) {
    console.log('(none)');
  } else {
    for (const e of edges) console.log(`[${e.kind}] ${e.detail}`);
  }

  if (APPLY) {
    await verify();
  }

  console.log(`\n=== ${APPLY ? 'APPLY' : 'DRY-RUN'} complete ===`);
}

main()
  .catch((e) => {
    console.error('ERR', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
