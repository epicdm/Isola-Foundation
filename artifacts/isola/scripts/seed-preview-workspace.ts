/**
 * Seed a sanitized, EPIC-SHAPED workspace for Chunk 1 preview UAT.
 *
 *   npx tsx scripts/seed-preview-workspace.ts
 *
 * PURPOSE
 * Chunk 1's acceptance needs a signed-in walkthrough across four roles. This
 * creates a tenant shaped like EPIC Tenant Zero — one assistant, a WhatsApp
 * number, conversations in both handled and handed-over states, audit history —
 * with entirely synthetic content, so UAT can run without touching production.
 *
 * SAFETY
 *  - Refuses to run against the production database (same host check as
 *    scripts/src/guard-not-prod-db.ts). This is the hard stop.
 *  - Refuses unless PREVIEW_SEED_CONFIRM=yes, so it cannot run by accident.
 *  - Writes ONLY rows it creates, all prefixed `preview-`. It never updates or
 *    deletes anything pre-existing.
 *  - Contains no real customer data, no real phone numbers in service, and no
 *    secrets. Numbers use the reserved 555 range.
 *
 * WHAT IT CREATES
 *   tenant            preview-tenant-epic-shaped
 *   users + memberships
 *                     preview-owner    Membership.role = owner   -> full access
 *                     preview-manager  Membership.role = admin   -> operational only
 *                     preview-staff    Membership.role = staff   -> denied
 *   a second tenant   preview-tenant-other (+ its own agent) to prove that
 *                     cross-tenant access is indistinguishable from not found
 *   agent             "Ava" with greeting, business context and knowledge text
 *   whatsapp number   +1 555-0100 (reserved range)
 *   conversations     4, one of which is human_handling = true
 *   messages          a short realistic exchange per conversation
 *   audit log         a handful of entries incl. an escalation
 *
 * To sign in as each role, map the three users' replit_id values to the Replit
 * identities you will authenticate with (see REPLIT_ID_* env below), or edit
 * them afterwards in the preview database.
 */

import { PrismaClient } from '@prisma/client';

const PROD_HOST_PATTERN = /ep-fancy-cake/i;

function assertNotProduction(): void {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set. Point it at the preview/dev database first.');
    process.exit(1);
  }
  let host = '(unparseable)';
  try {
    host = new URL(url).hostname;
  } catch {
    /* fall through — an unparseable URL is not the production host */
  }
  if (PROD_HOST_PATTERN.test(host)) {
    console.error(`REFUSING TO RUN: DATABASE_URL points at the production database host (${host}).`);
    console.error('This script is for a preview/dev database only.');
    process.exit(1);
  }
  console.log(`Target database host: ${host}`);
}

function assertConfirmed(): void {
  if (process.env.PREVIEW_SEED_CONFIRM !== 'yes') {
    console.error('Refusing to run without PREVIEW_SEED_CONFIRM=yes.');
    console.error('Re-run as: PREVIEW_SEED_CONFIRM=yes npx tsx scripts/seed-preview-workspace.ts');
    process.exit(1);
  }
}

const P = 'preview-';
const TENANT_ID = `${P}tenant-epic-shaped`;
const OTHER_TENANT_ID = `${P}tenant-other`;

const ROLES = [
  { key: 'owner', membershipRole: 'owner', name: 'Preview Owner' },
  { key: 'manager', membershipRole: 'admin', name: 'Preview Manager' },
  { key: 'staff', membershipRole: 'staff', name: 'Preview Staff' },
] as const;

async function main(): Promise<void> {
  assertNotProduction();
  assertConfirmed();

  const prisma = new PrismaClient();
  const now = new Date();
  const minsAgo = (m: number) => new Date(now.getTime() - m * 60000);

  try {
    // ---------------------------------------------------------------- tenants
    for (const [id, name] of [
      [TENANT_ID, 'Preview Front Desk Co'],
      [OTHER_TENANT_ID, 'Preview Other Business'],
    ] as const) {
      await prisma.tenant.upsert({
        where: { id },
        update: {},
        create: { id, business_name: name, status: 'active', plan: 'growth', tenant_kind: 'test' },
      });
    }

    // ------------------------------------------------------ users + memberships
    for (const role of ROLES) {
      const identityId = `${P}identity-${role.key}`;
      const userId = `${P}user-${role.key}`;
      const replitId = process.env[`REPLIT_ID_${role.key.toUpperCase()}`] ?? `${P}replit-${role.key}`;

      await prisma.identity.upsert({
        where: { id: identityId },
        update: {},
        create: { id: identityId, display_name: role.name, replit_id: replitId },
      });

      await prisma.user.upsert({
        where: { id: userId },
        update: { replit_id: replitId },
        create: {
          id: userId,
          replit_id: replitId,
          name: role.name,
          // NOTE: User.role defaults to 'owner' for everyone in this schema —
          // that is precisely why workspace access is decided by Membership.role.
          role: 'owner',
          tenant_id: TENANT_ID,
          identity_id: identityId,
        },
      });

      await prisma.membership.upsert({
        where: { identity_id_tenant_id: { identity_id: identityId, tenant_id: TENANT_ID } },
        update: { role: role.membershipRole },
        create: { identity_id: identityId, tenant_id: TENANT_ID, role: role.membershipRole },
      });
    }

    // ----------------------------------------------------------------- agents
    const agentId = `${P}agent-ava`;
    await prisma.agent.upsert({
      where: { id: agentId },
      update: {},
      create: {
        id: agentId,
        tenant_id: TENANT_ID,
        name: 'Ava',
        greeting: 'Hi! This is Ava at Preview Front Desk Co. How can I help today?',
        business_info:
          'Preview Front Desk Co answers customer questions, books appointments and takes messages. ' +
          'Opening hours are 9am to 5pm Monday to Friday. Synthetic preview data.',
        knowledge_text:
          'Bookings: appointments run every 30 minutes between 9am and 4:30pm. ' +
          'Payments: card and bank transfer accepted. ' +
          'Delivery: same-day within town, next-day elsewhere. ' +
          'Refunds: within 14 days with proof of purchase. (Synthetic preview knowledge.)',
        after_hours_start: '17:00',
        after_hours_end: '09:00',
        away_message: 'Thanks for your message! We are closed right now and will reply in the morning.',
        is_active: true,
        brain_provider: 'clawith',
      },
    });

    // A second tenant's agent — the cross-tenant 404 target.
    await prisma.agent.upsert({
      where: { id: `${P}agent-other` },
      update: {},
      create: { id: `${P}agent-other`, tenant_id: OTHER_TENANT_ID, name: 'Other Assistant', is_active: true },
    });

    // --------------------------------------------------------- whatsapp number
    await prisma.whatsAppNumber.upsert({
      where: { phone_number_id: `${P}pnid-0100` },
      update: {},
      create: {
        phone_number_id: `${P}pnid-0100`,
        tenant_id: TENANT_ID,
        waba_id: `${P}waba`,
        phone_number: '15550100', // reserved 555 range — not a routable number
        display_name: 'Preview Front Desk',
        // Deliberately not credential-shaped: this column is NOT NULL, and the
        // preview never calls Meta, so a short obvious placeholder is correct.
        access_token: 'preview',
      },
    });

    // ---------------------------------------------------------- conversations
    const conversations = [
      { id: `${P}conv-1`, name: 'Sam Rivera', phone: '15550111', status: 'open', human: false, mins: 3 },
      { id: `${P}conv-2`, name: 'Jules Bennett', phone: '15550112', status: 'open', human: true, mins: 12 },
      { id: `${P}conv-3`, name: 'Robin Hale', phone: '15550113', status: 'resolved', human: false, mins: 90 },
      { id: `${P}conv-4`, name: null, phone: '15550114', status: 'open', human: false, mins: 8 },
    ];

    for (const c of conversations) {
      await prisma.conversation.upsert({
        where: { id: c.id },
        update: {},
        create: {
          id: c.id,
          tenant_id: TENANT_ID,
          customer_phone: c.phone,
          customer_name: c.name,
          status: c.status,
          human_handling: c.human,
          last_message_at: minsAgo(c.mins),
          created_at: minsAgo(c.mins + 30),
          messages: {
            create: [
              { role: 'user', content: 'Hi, are you open on Saturday?', created_at: minsAgo(c.mins + 5) },
              {
                role: 'assistant',
                content: 'We are open Monday to Friday, 9am to 5pm. Would a weekday slot work?',
                created_at: minsAgo(c.mins),
              },
            ],
          },
        },
      });
    }

    // ------------------------------------------------------------- audit rows
    const auditRows = [
      { action: 'escalate_to_human.invoked', entity: 'conversation', actor: 'clawith:escalate_to_human', mins: 12 },
      { action: 'chatwoot.addMessage', entity: 'conversation', actor: 'system', mins: 11 },
      { action: 'agent.update', entity: 'agent', actor: `${P}user-owner`, mins: 240 },
      { action: 'takeover.enable', entity: 'user', actor: `${P}user-owner`, mins: 300 },
      { action: 'odoo.findCustomerByPhone', entity: 'customer', actor: 'agent:preview', mins: 420 },
    ];
    for (const [i, a] of auditRows.entries()) {
      await prisma.auditLog.upsert({
        where: { id: `${P}audit-${i}` },
        update: {},
        create: {
          id: `${P}audit-${i}`,
          tenant_id: TENANT_ID,
          actor_id: a.actor,
          action: a.action,
          entity: a.entity,
          created_at: minsAgo(a.mins),
        },
      });
    }

    // ------------------------------------------------------------ usage meter
    const periodStart = new Date(now.getFullYear(), now.getMonth(), 1);
    await prisma.usageMeter.upsert({
      where: { tenant_id_period_start: { tenant_id: TENANT_ID, period_start: periodStart } },
      update: {},
      create: {
        tenant_id: TENANT_ID,
        period_start: periodStart,
        period_end: new Date(now.getFullYear(), now.getMonth() + 1, 0),
        minutes_used: 42.5,
        tokens_used: 18400,
      },
    });

    console.log('\nSeeded preview workspace:');
    console.log(`  tenant           ${TENANT_ID}`);
    console.log(`  cross-tenant     ${OTHER_TENANT_ID} (agent ${P}agent-other — expect 404)`);
    console.log(`  agent            ${agentId}`);
    console.log('  roles            owner / manager (admin) / staff');
    console.log('  conversations    4 (1 handed to a person)');
    console.log('\nSign-in mapping: set REPLIT_ID_OWNER / REPLIT_ID_MANAGER / REPLIT_ID_STAFF');
    console.log('to the Replit identities you will authenticate with, then re-run.');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('Seed failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
