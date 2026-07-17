/**
 * Next.js instrumentation hook — runs once per server process start in both
 * development and production.
 *
 * Responsibilities:
 *   • Seed required WhatsApp routing rows that must exist in every environment.
 *   • Ensure every tenant (especially the admin tenant) has a default active Agent.
 *   • Seed Wave B A2-mode tenants (Anansi, DineBot) from waveb-seed-data.
 *
 * Dev and production have separate databases; this hook is the idempotent way to
 * keep required seed data in sync without manual steps after each deployment.
 *
 * Rules:
 *   • Only runs in the Node.js runtime (not edge).
 *   • All operations are idempotent — safe to re-run on every cold start.
 *   • Errors are logged but never thrown — a seed failure must not crash the app.
 */

// Wave B seed data is imported at module level (not dynamic) because it's a
// sibling TS module with no side-effects — safe for instrumentation.
import { WAVE_B_TENANTS } from '@/lib/waveb-seed-data';
import {
  EMA_SALES_TENANT_ID,
  EMA_SALES_WA_NUMBER_ID,
  EMA_SALES_PHONE_NUMBER_ID,
  EMA_SALES_WABA_ID,
  EMA_SALES_PHONE_NUMBER,
  EMA_SALES_GREETING,
  EMA_SALES_BUSINESS_INFO,
  EMA_SALES_KNOWLEDGE_TEXT,
  EMA_CHATWOOT_BASE_URL,
  EMA_CHATWOOT_ACCOUNT_ID,
  EMA_CHATWOOT_INBOX_ID,
} from '@/lib/ema-sales-seed-data';
import {
  EPIC_MAIN_PHONE_NUMBER_ID,
  EPIC_MAIN_PHONE_NUMBER,
  EPIC_MAIN_WA_NUMBER_ID,
  EPIC_FB_LINKED_PHONE_NUMBER_ID,
  EPIC_FB_LINKED_PHONE_NUMBER,
  EPIC_FB_LINKED_WA_NUMBER_ID,
  EPIC_WABA_ID,
} from '@/lib/epic-seed-data';
import { audit } from '@/lib/audit';

export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  const { default: prisma } = await import('@/lib/prisma');

  // Schema migrations first — idempotent ALTER TABLE statements so production
  // (neondb) stays in sync without a separate migration runner.
  await runMigrations(prisma);

  // Resolve admin tenant once; both seeds need it
  const adminTenantId = await resolveAdminTenantId(prisma);

  await Promise.all([
    seedWhatsAppTestNumber(prisma, adminTenantId),
    seedDefaultAgent(prisma, adminTenantId),
    seedWaveBTenants(prisma),
    seedEmaSalesAgent(prisma),
    seedEpicWhatsAppNumbers(prisma, adminTenantId),
  ]);

  // Gate #4: EMA human-takeover Chatwoot binding — inert until CC's real
  // inbox ids are configured. Runs after seedEmaSalesAgent so the Tenant
  // row exists (FK requirement for ChatwootBinding).
  await seedEmaSalesChatwootBinding(prisma);

  // One-time production flips — run after seeding so the relevant Agent row
  // is guaranteed to exist. Both are idempotent (no-op once already
  // 'hermes') and ship as code instead of a raw SQL edit against production.
  await flipEmaSalesToHermesOnce(prisma, adminTenantId);
  await flipEpicToHermesOnce(prisma, adminTenantId);
}

// ── helpers ───────────────────────────────────────────────────────────────────

/**
 * Idempotent schema migrations using raw SQL. Runs on every cold start so
 * production (neondb) stays in sync with schema.prisma without a separate
 * migration runner or CI step. ADD COLUMN IF NOT EXISTS is always safe to
 * re-run; it is a no-op when the column already exists.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function runMigrations(prisma: any) {
  try {
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "Conversation" ADD COLUMN IF NOT EXISTS human_handling BOOLEAN NOT NULL DEFAULT FALSE;`,
    );
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "Message" ADD COLUMN IF NOT EXISTS chatwoot_message_id INTEGER;`,
    );
    // Add unique index separately so IF NOT EXISTS works on older Postgres versions
    await prisma.$executeRawUnsafe(
      `CREATE UNIQUE INDEX IF NOT EXISTS "Message_chatwoot_message_id_key" ON "Message"(chatwoot_message_id) WHERE chatwoot_message_id IS NOT NULL;`,
    );
    // Inbound dedup: unique index on Meta wamid so duplicate deliveries are caught
    // at the DB level (P2002) before the AI is called.
    await prisma.$executeRawUnsafe(
      `CREATE UNIQUE INDEX IF NOT EXISTS "Message_wa_message_id_key" ON "Message"(wa_message_id) WHERE wa_message_id IS NOT NULL;`,
    );
    // P0 (2026-07-15): cross-path inbound dedup, keyed ONLY on Meta's wamid,
    // independent of Tenant/Conversation/routing-path. Closes the gap where
    // Message.wa_message_id (direct WA webhook path) and
    // Message.chatwoot_message_id (Chatwoot agent-bot path) are different
    // local keys, so the same physical Meta message reaching both paths
    // produced two AI replies. See lib/inbound-dedup.ts.
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "InboundDedup" (
        id         TEXT PRIMARY KEY,
        message_id TEXT NOT NULL,
        created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);
    await prisma.$executeRawUnsafe(
      `CREATE UNIQUE INDEX IF NOT EXISTS "InboundDedup_message_id_key" ON "InboundDedup"(message_id);`,
    );
    // A2 mode: ChatwootBinding.mode column distinguishes mirror (Wave A) from
    // a2 (Chatwoot owns WA channel, this app is the AI brain).
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "ChatwootBinding" ADD COLUMN IF NOT EXISTS mode VARCHAR(20) NOT NULL DEFAULT 'mirror';`,
    );
    // After-hours away message: sent verbatim instead of silence during off-hours.
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "Agent" ADD COLUMN IF NOT EXISTS away_message TEXT NOT NULL DEFAULT '';`,
    );
    // Brain-provider abstraction: per-agent choice of reply runtime (native Claude
    // vs external self-hosted Flowise flow). Default 'native' for every existing row.
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "Agent" ADD COLUMN IF NOT EXISTS brain_provider VARCHAR(20) NOT NULL DEFAULT 'native';`,
    );
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "Agent" ADD COLUMN IF NOT EXISTS flowise_flow_id TEXT;`,
    );
    // P6: EMA landing page funnel attribution — standalone table, no FKs.
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "ConsumerLead" (
        id            TEXT PRIMARY KEY,
        phone_number  TEXT,
        utm_source    TEXT,
        utm_medium    TEXT,
        utm_campaign  TEXT,
        utm_term      TEXT,
        utm_content   TEXT,
        referrer      TEXT,
        landing_path  TEXT,
        cta           TEXT,
        odoo_lead_id  INTEGER,
        created_at    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);
    await prisma.$executeRawUnsafe(
      `CREATE INDEX IF NOT EXISTS "ConsumerLead_created_at_idx" ON "ConsumerLead"(created_at);`,
    );
    await prisma.$executeRawUnsafe(
      `CREATE INDEX IF NOT EXISTS "ConsumerLead_utm_source_utm_campaign_idx" ON "ConsumerLead"(utm_source, utm_campaign);`,
    );
    console.log('[instrumentation] Schema migrations applied');
  } catch (err) {
    console.error('[instrumentation] Migration error:', err);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function resolveAdminTenantId(prisma: any): Promise<string | null> {
  const adminReplitIds = (process.env.ADMIN_REPLIT_IDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  if (!adminReplitIds.length) return null;

  try {
    const user = await prisma.user.findFirst({
      where: { replit_id: { in: adminReplitIds } },
      select: { tenant_id: true },
    });
    return user?.tenant_id ?? null;
  } catch {
    return null;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function seedWhatsAppTestNumber(prisma: any, adminTenantId: string | null) {
  const TEST_PHONE_NUMBER_ID = '172262922640694';

  try {
    const existing = await prisma.whatsAppNumber.findUnique({
      where: { phone_number_id: TEST_PHONE_NUMBER_ID },
      select: { id: true },
    });
    if (existing) return;

    if (!adminTenantId) {
      console.warn('[instrumentation] Admin not yet provisioned — WhatsApp test number seed deferred');
      return;
    }

    await prisma.whatsAppNumber.create({
      data: {
        tenant_id:       adminTenantId,
        phone_number_id: TEST_PHONE_NUMBER_ID,
        waba_id:         '1503636574518000',
        phone_number:    '+15550000001',
        display_name:    'Meta Test Number',
        access_token:    '',
        token_env:       'META_TEST_ACCESS_TOKEN',
        coex_mode:       true,
      },
    });
    console.log('[instrumentation] WhatsApp test number seeded → tenant', adminTenantId);
  } catch (err) {
    console.error('[instrumentation] WhatsApp test number seed error:', err);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function seedDefaultAgent(prisma: any, adminTenantId: string | null) {
  if (!adminTenantId) {
    console.warn('[instrumentation] Admin not yet provisioned — default agent seed deferred');
    return;
  }

  try {
    await prisma.agent.upsert({
      where: { tenant_id: adminTenantId },
      create: {
        tenant_id:         adminTenantId,
        name:              'Isola Assistant',
        greeting:          'Hello! How can I help you today?',
        business_info:     'EPIC Communications — multi-tenant WhatsApp AI platform serving Dominica.',
        intelligence_tier: 'advanced',  // claude-sonnet for admin/test tenant
        is_active:         true,
      },
      update: {}, // idempotent — don't overwrite if owner has customised it
    });
    console.log('[instrumentation] Default agent ensured for tenant', adminTenantId);
  } catch (err) {
    console.error('[instrumentation] Default agent seed error:', err);
  }
}

/**
 * Seed Wave B A2-mode tenants (Anansi, DineBot) from WAVE_B_TENANTS.
 *
 * Creates or verifies: Tenant, Agent, and ChatwootBinding (mode='a2').
 *
 * IMPORTANT: WhatsApp routing rows (WhatsAppNumber) are intentionally NOT
 * created for A2 tenants. A second Meta app still delivers webhooks for their
 * phone_number_ids to /api/webhooks/whatsapp; if routing rows existed, that
 * path would also answer and cause double-replies. The direct webhook path
 * silently no-ops (returns without AI or send) for any phone_number_id that
 * has no routing row — that is the isolation guarantee.
 *
 * A cleanup step runs first to remove any rows that a previous seed version
 * may have accidentally created.
 *
 * All other operations are idempotent — safe to re-run on every cold start.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function seedWaveBTenants(prisma: any) {
  // ── Safety cleanup: remove stale A2 WhatsApp routing rows ─────────────────
  // If a previous seed version created routing rows for these phone_number_ids,
  // delete them now. Their presence would cause the direct WA webhook path to
  // answer for A2 numbers and double-reply alongside the agent-bot path.
  const A2_PHONE_NUMBER_IDS = WAVE_B_TENANTS.map((s) => s.phoneNumberId);
  try {
    const deleted = await prisma.whatsAppNumber.deleteMany({
      where: { phone_number_id: { in: A2_PHONE_NUMBER_IDS } },
    });
    if (deleted.count > 0) {
      console.log(
        `[instrumentation] Removed ${deleted.count} stale A2 WhatsApp routing row(s) — double-reply prevention`,
      );
    }
  } catch (err: any) {
    // FK constraint fires when conversations reference the rows. The direct WA
    // path is still safe: handleInboundWhatsApp returns immediately for any
    // phone_number_id that resolves to an A2 tenant (access_token blank → send fails).
    console.warn(
      '[instrumentation] Could not remove A2 WA routing rows (FK constraint — manual cleanup required):',
      err?.message,
    );
  }

  // ── Per-tenant seed ────────────────────────────────────────────────────────
  for (const soul of WAVE_B_TENANTS) {
    try {
      // 1. Tenant
      await prisma.tenant.upsert({
        where:  { id: soul.tenantId },
        create: {
          id:            soul.tenantId,
          business_name: soul.businessName,
          status:        'active',
          plan:          'growth',
        },
        update: {}, // never overwrite plan or status once set
      });

      // 2. Agent — soul-derived fields are always kept in sync with WAVEB-SOULS.json
      // so that fixes to away_message, greeting, knowledge, and schedule land on
      // every cold start without a manual DB patch. Operational fields (is_active,
      // intelligence_tier, brain_provider) are only set on create so an operator
      // override persists. flowise_flow_id is synced from source (it's a fixed
      // test-fixture reference, not something an operator hand-edits per tenant).
      await prisma.agent.upsert({
        where:  { tenant_id: soul.tenantId },
        create: {
          tenant_id:         soul.tenantId,
          name:              soul.agentName,
          greeting:          soul.greeting,
          business_info:     soul.businessInfo,
          knowledge_text:    soul.knowledgeText,
          away_message:      soul.awayMessage,
          intelligence_tier: 'standard',
          after_hours_start: soul.afterHoursStart,
          after_hours_end:   soul.afterHoursEnd,
          timezone:          soul.timezone,
          is_active:         true,
          brain_provider:    'native',
          flowise_flow_id:   soul.flowiseFlowId ?? null,
        },
        update: {
          // Soul-derived fields: always sync from source so typo-fixes and content
          // updates propagate automatically on next cold start.
          name:              soul.agentName,
          greeting:          soul.greeting,
          business_info:     soul.businessInfo,
          knowledge_text:    soul.knowledgeText,
          away_message:      soul.awayMessage,
          after_hours_start: soul.afterHoursStart,
          after_hours_end:   soul.afterHoursEnd,
          timezone:          soul.timezone,
          flowise_flow_id:   soul.flowiseFlowId ?? null,
        },
      });

      // 3. ChatwootBinding (mode='a2') — the ONLY routing key for A2 tenants
      await prisma.chatwootBinding.upsert({
        where:  { tenant_id: soul.tenantId },
        create: {
          tenant_id:  soul.tenantId,
          base_url:   'https://inbox.epic.dm',
          account_id: soul.chatwootAccountId,
          token:      '',                   // A2: uses CHATWOOT_AGENTBOT_TOKEN env var
          inbox_id:   soul.chatwootInboxId,
          mode:       'a2',
        },
        update: { mode: 'a2' }, // ensure mode is always 'a2' on re-run
      });

      console.log(`[instrumentation] Wave B tenant seeded: ${soul.agentName} (${soul.tenantId})`);
    } catch (err) {
      console.error(`[instrumentation] Wave B seed error for ${soul.agentName}:`, err);
    }
  }
}

/**
 * Seed the EMA sales/onboarding WhatsApp agent (P5) — the acquisition front
 * door running on +1 767-818-0001, the SAME number that sends the consumer
 * OTP (lib/consumer-whatsapp-otp.ts). See lib/ema-sales-seed-data.ts for why
 * this is a direct-webhook tenant (WhatsAppNumber row only, no Chatwoot
 * inbox/binding) rather than an A2 tenant.
 *
 * Idempotent: upsert by fixed id. business_info/knowledge_text/greeting are
 * always kept in sync with source (like Wave B) so persona fixes propagate
 * on next cold start without a manual DB patch. is_active/brain_provider are
 * create-only so an operator override persists.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function seedEmaSalesAgent(prisma: any) {
  try {
    await prisma.tenant.upsert({
      where: { id: EMA_SALES_TENANT_ID },
      create: {
        id: EMA_SALES_TENANT_ID,
        business_name: 'EMA (EPIC Calling App)',
        status: 'active',
        plan: 'growth',
      },
      update: {}, // never overwrite plan/status once set
    });

    await prisma.agent.upsert({
      where: { tenant_id: EMA_SALES_TENANT_ID },
      create: {
        tenant_id: EMA_SALES_TENANT_ID,
        name: 'EMA',
        greeting: EMA_SALES_GREETING,
        business_info: EMA_SALES_BUSINESS_INFO,
        knowledge_text: EMA_SALES_KNOWLEDGE_TEXT,
        intelligence_tier: 'standard',
        is_active: true,
        brain_provider: 'native',
      },
      update: {
        // Soul-derived fields sync from source; operational fields untouched.
        name: 'EMA',
        greeting: EMA_SALES_GREETING,
        business_info: EMA_SALES_BUSINESS_INFO,
        knowledge_text: EMA_SALES_KNOWLEDGE_TEXT,
      },
    });

    // Direct-webhook routing row ONLY — no ChatwootBinding. This number's
    // WABA (272252189309178) already has the EPIC_BFF_test app's webhook
    // pointed at this deployment's /api/webhooks/whatsapp; creating a
    // Chatwoot inbox here is unnecessary and is exactly the action that
    // previously diverted another number's traffic on this WABA ("3742
    // trap") by rewriting the app-level webhook config. Do not add one.
    await prisma.whatsAppNumber.upsert({
      where: { phone_number_id: EMA_SALES_PHONE_NUMBER_ID },
      create: {
        id: EMA_SALES_WA_NUMBER_ID,
        tenant_id: EMA_SALES_TENANT_ID,
        phone_number_id: EMA_SALES_PHONE_NUMBER_ID,
        waba_id: EMA_SALES_WABA_ID,
        phone_number: EMA_SALES_PHONE_NUMBER,
        display_name: 'EMA',
        access_token: '',
        token_env: 'WHATSAPP_TOKEN', // same token consumer OTP sends with
        coex_mode: true,
      },
      update: {}, // routing identity — never overwrite once set
    });

    console.log('[instrumentation] EMA sales agent seeded — tenant', EMA_SALES_TENANT_ID);
  } catch (err) {
    console.error('[instrumentation] EMA sales agent seed error:', err);
  }
}

/**
 * Gate #4 — EMA human-takeover Chatwoot binding (Wave-B A2 pattern reused).
 *
 * Target confirmed by CC: the EXISTING account 5 / inbox 3 (API-channel
 * inbox on inbox.epic.dm, no new resources, safe on the shared WABA) — so
 * account/inbox/base_url are fixed code constants. Only the auth token is
 * sensitive: EMA_CHATWOOT_TOKEN (App Secret, set by Eric) is read from env
 * and NEVER logged. Deliberately INERT until that secret is set — with no
 * binding row, mirrorInbound() in lib/agent.ts short-circuits
 * (`if (!tenant.chatwoot_binding) return null`) and the outbound mirror at
 * the end of handleInboundWhatsApp() is skipped too (`if (effectiveCwConvId
 * !== null && tenant.chatwoot_binding)`) — so live EMA behavior
 * (brain_provider='hermes', no mirroring) is unchanged until the token
 * exists.
 *
 * mode='a2' is what makes this the SAME pattern as Anansi/DineBot — Chatwoot
 * is a passive mirror + human-takeover surface, not the WhatsApp channel
 * owner (this tenant remains a direct-webhook tenant; no WABA/app-webhook
 * config is touched, so the "3742 trap" does not apply here).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function seedEmaSalesChatwootBinding(prisma: any) {
  const token = process.env.EMA_CHATWOOT_TOKEN;

  if (!token) {
    console.log(
      '[instrumentation] EMA Chatwoot binding not configured (EMA_CHATWOOT_TOKEN unset) — inert, no mirroring',
    );
    return;
  }

  try {
    await prisma.chatwootBinding.upsert({
      where: { tenant_id: EMA_SALES_TENANT_ID },
      create: {
        tenant_id: EMA_SALES_TENANT_ID,
        base_url: EMA_CHATWOOT_BASE_URL,
        account_id: EMA_CHATWOOT_ACCOUNT_ID,
        token,
        inbox_id: EMA_CHATWOOT_INBOX_ID,
        mode: 'a2',
      },
      update: {
        // Resync from env/secret on every cold start — e.g. if the token
        // rotates — no manual DB patch needed.
        base_url: EMA_CHATWOOT_BASE_URL,
        account_id: EMA_CHATWOOT_ACCOUNT_ID,
        token,
        inbox_id: EMA_CHATWOOT_INBOX_ID,
        mode: 'a2',
      },
    });
    console.log(
      '[instrumentation] EMA Chatwoot binding active — tenant',
      EMA_SALES_TENANT_ID,
      'account',
      EMA_CHATWOOT_ACCOUNT_ID,
      'inbox',
      EMA_CHATWOOT_INBOX_ID,
    );
  } catch (err) {
    console.error('[instrumentation] EMA Chatwoot binding seed error:', err);
  }
}

/**
 * Seed the two EPIC business-facing WhatsApp routing rows (3742 main,
 * 1568 FB-linked) onto the admin/tenant-zero Tenant. See
 * lib/epic-seed-data.ts for why these are plain direct-webhook routing rows
 * (same shared-WABA "3742 trap" rationale as EMA) and why token_env reuses
 * WHATSAPP_TOKEN. Idempotent: upsert by fixed phone_number_id, routing
 * identity fields never overwritten once set (matches seedEmaSalesAgent's
 * WhatsAppNumber upsert pattern).
 *
 * Deferred (not this seed): no ChatwootBinding is created for either
 * number — human-takeover mirroring for 3742/1568 is a separate follow-up
 * that will reuse the EMA A2 pattern against account 5.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function seedEpicWhatsAppNumbers(prisma: any, adminTenantId: string | null) {
  if (!adminTenantId) {
    console.warn('[instrumentation] Admin not yet provisioned — EPIC WhatsApp numbers seed deferred');
    return;
  }

  const numbers = [
    {
      id: EPIC_MAIN_WA_NUMBER_ID,
      phone_number_id: EPIC_MAIN_PHONE_NUMBER_ID,
      phone_number: EPIC_MAIN_PHONE_NUMBER,
      display_name: 'EPIC (main)',
    },
    {
      id: EPIC_FB_LINKED_WA_NUMBER_ID,
      phone_number_id: EPIC_FB_LINKED_PHONE_NUMBER_ID,
      phone_number: EPIC_FB_LINKED_PHONE_NUMBER,
      display_name: 'EPIC (FB-linked)',
    },
  ];

  for (const num of numbers) {
    try {
      await prisma.whatsAppNumber.upsert({
        where: { phone_number_id: num.phone_number_id },
        create: {
          id: num.id,
          tenant_id: adminTenantId,
          phone_number_id: num.phone_number_id,
          waba_id: EPIC_WABA_ID,
          phone_number: num.phone_number,
          display_name: num.display_name,
          access_token: '',
          token_env: 'WHATSAPP_TOKEN', // same business-scoped token EMA already sends with
          coex_mode: true,
        },
        update: {}, // routing identity — never overwrite once set
      });
      console.log(`[instrumentation] EPIC WhatsApp number seeded: ${num.display_name} → tenant`, adminTenantId);
    } catch (err) {
      console.error(`[instrumentation] EPIC WhatsApp number seed error (${num.display_name}):`, err);
    }
  }
}

/**
 * One-time production go-live flip: EMA sales Agent.brain_provider
 * 'native' → 'hermes'. Ships as code (goes through prisma.agent.update +
 * the same audit() call the admin PATCH route uses) rather than a raw SQL
 * edit against production, per this project's established convention that
 * production writes materialize on cold start, never via direct DB access.
 * The HERMES_ALLOWED_PHONE_NUMBER_IDS gate in lib/brain-provider.ts is the
 * real safety boundary; this flip only takes effect for phone_number_id
 * 1023804347491554, and no other tenant's brain_provider is touched.
 * Idempotent — checks current value first and no-ops if already 'hermes',
 * so this is safe to leave in place across future cold starts.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function flipEmaSalesToHermesOnce(prisma: any, adminTenantId: string | null) {
  try {
    const agent = await prisma.agent.findFirst({
      where: { tenant_id: EMA_SALES_TENANT_ID },
      select: { id: true, brain_provider: true },
    });
    if (!agent) {
      console.warn('[instrumentation] EMA sales agent not found — hermes flip deferred');
      return;
    }
    if (agent.brain_provider === 'hermes') {
      return; // already flipped — no-op
    }

    await prisma.agent.update({
      where: { id: agent.id },
      data: { brain_provider: 'hermes' },
    });

    await audit({
      tenantId: adminTenantId ?? EMA_SALES_TENANT_ID,
      actorId: 'instrumentation:flip-ema-sales-hermes',
      action: 'admin.tenant.update',
      entity: 'tenant',
      entityId: EMA_SALES_TENANT_ID,
      meta: { changes: ['brain_provider'], from: agent.brain_provider, to: 'hermes' },
    });

    console.log('[instrumentation] EMA sales brain_provider flipped to hermes — tenant', EMA_SALES_TENANT_ID);
  } catch (err) {
    console.error('[instrumentation] EMA sales hermes flip error:', err);
  }
}

/**
 * One-time production go-live flip: admin/tenant-zero Agent.brain_provider
 * 'native' → 'hermes', for the EPIC main (3742) and FB-linked (1568)
 * numbers. Same rationale and idempotency as flipEmaSalesToHermesOnce()
 * above.
 *
 * SAFE for the tenant's OTHER number (Meta Test Number, phone_number_id
 * 172262922640694): it is not in HERMES_ALLOWED_PHONE_NUMBER_IDS, so
 * generateReply() logs a warning and falls back to native for it — the
 * tenant-wide brain_provider column is intentionally not the only gate; see
 * lib/brain-provider.ts's HERMES PER-NUMBER GATE doc comment.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function flipEpicToHermesOnce(prisma: any, adminTenantId: string | null) {
  if (!adminTenantId) return;
  try {
    const agent = await prisma.agent.findFirst({
      where: { tenant_id: adminTenantId },
      select: { id: true, brain_provider: true },
    });
    if (!agent) {
      console.warn('[instrumentation] EPIC (admin tenant) agent not found — hermes flip deferred');
      return;
    }
    if (agent.brain_provider === 'hermes') {
      return; // already flipped — no-op
    }

    await prisma.agent.update({
      where: { id: agent.id },
      data: { brain_provider: 'hermes' },
    });

    await audit({
      tenantId: adminTenantId,
      actorId: 'instrumentation:flip-epic-hermes',
      action: 'admin.tenant.update',
      entity: 'tenant',
      entityId: adminTenantId,
      meta: { changes: ['brain_provider'], from: agent.brain_provider, to: 'hermes' },
    });

    console.log('[instrumentation] EPIC brain_provider flipped to hermes — tenant', adminTenantId);
  } catch (err) {
    console.error('[instrumentation] EPIC hermes flip error:', err);
  }
}
