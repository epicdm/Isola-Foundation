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
  EMA_CLAWITH_AGENT_ID,
  EMA_SALES_AGENT_NAME,
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
import {
  EPIC_OWNER_TENANT_ID,
  EPIC_OWNER_AGENT_NAME,
  EPIC_CHATWOOT_BASE_URL,
  EPIC_CHATWOOT_ACCOUNT_ID,
  EPIC_CHATWOOT_SERVICE_TOKEN_REF,
  EPIC_CHATWOOT_DOORS,
} from '@/lib/epic-owner-chatwoot-seed-data';
import { audit } from '@/lib/audit';
import {
  decideChatwootBindingSeed,
  describeSeedDecision,
  type AgentFacts,
  type DesiredRegistration,
  type ExistingRegistration,
} from '@/lib/chatwoot-binding-seed-guard';

export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  const { default: prisma } = await import('@/lib/prisma');

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

  // EPIC's own mirror bindings (6737/3742/0001) — migrates inbox 7 off its
  // literal token onto the env:CHATWOOT_SERVICE_TOKEN reference and creates
  // 8 and 12 the same way. See lib/epic-owner-chatwoot-seed-data.ts.
  await seedEpicOwnerChatwootBindings(prisma);

  // One-time production flips — run after seeding so the relevant Agent row
  // is guaranteed to exist. Both are idempotent (no-op once already
  // 'hermes') and ship as code instead of a raw SQL edit against production.
  await flipEmaSalesToHermesOnce(prisma, adminTenantId);
  await flipEpicToHermesOnce(prisma, adminTenantId);

  // v1.11.0 Clawith cutover — EMA (0001) only. Runs last so it always wins
  // over flipEmaSalesToHermesOnce within the same cold start. Gated at the
  // routing layer too: ISOLA_BRIDGE_ALLOWED_PHONE_NUMBER_IDS in
  // lib/brain-provider.ts is the real safety boundary.
  await flipEmaSalesToClawithOnce(prisma, adminTenantId);
}

// ── helpers ───────────────────────────────────────────────────────────────────

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

/**
 * ── The ONE governed way this process may write a ChatwootBinding ──────────
 *
 * A ChatwootBinding is the governed REGISTRATION that points one Chatwoot door
 * (account + inbox + mode) at one Foundation Agent row, which points at one
 * Clawith agent, owned by one tenant. It is not a second AI employee and it is
 * not a routing convenience — it is the authority record for that door.
 *
 * Every cold-start binding write now goes through here. This function only
 * READS; the single write it may perform is the one
 * decideChatwootBindingSeed() (lib/chatwoot-binding-seed-guard.ts) explicitly
 * authorises. If the guard refuses, nothing is written and the conflict is
 * logged with ids + reason code only — never a token.
 *
 * Identity is configuration-backed end to end:
 *   • tenant id      — a code constant / seed-data constant
 *   • agent          — resolved by (tenant_id, agent NAME) from the same
 *                      constant, so it is never "whichever agent came first"
 *                      and never inferred from account_id
 *   • door           — account_id + inbox_id + mode; inbox_id is mandatory,
 *                      because several tenants share one Chatwoot account and
 *                      account_id alone can never establish ownership
 */
export interface ChatwootBindingSeedConfig {
  /** Human label for logs, e.g. 'EMA sales' or 'Wave B / Anansi'. */
  label: string;
  tenantId: string;
  /** Configuration-backed Agent NAME within that tenant. */
  agentName: string;
  baseUrl: string;
  accountId: string;
  inboxId: string;
  mode: string;
  /** Chatwoot auth token ('' for a2, which uses CHATWOOT_AGENTBOT_TOKEN). Never logged. */
  token: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function applyChatwootBindingSeed(prisma: any, cfg: ChatwootBindingSeedConfig) {
  const log = (msg: string) => console.log(`[instrumentation][cw-binding-guard][${cfg.label}] ${msg}`);
  const warn = (msg: string) => console.warn(`[instrumentation][cw-binding-guard][${cfg.label}] ${msg}`);

  try {
    // ── Reads only ─────────────────────────────────────────────────────────
    const tenant = await prisma.tenant.findUnique({
      where: { id: cfg.tenantId },
      select: { id: true, status: true },
    });

    // Resolve the Agent row by explicit (tenant, name). Zero or several
    // matches means the registration pointer cannot be established — the
    // guard then refuses rather than writing a NULL or arbitrary pointer.
    const agentMatches: Array<{ id: string; tenant_id: string; brain_provider: string }> =
      tenant
        ? await prisma.agent.findMany({
            where: { tenant_id: cfg.tenantId, name: cfg.agentName },
            select: { id: true, tenant_id: true, brain_provider: true },
          })
        : [];
    if (agentMatches.length !== 1) {
      warn(
        `agent registration unresolvable — tenant=${cfg.tenantId} name=${cfg.agentName} matches=${agentMatches.length}`,
      );
    }
    const agentRow = agentMatches.length === 1 ? agentMatches[0] : null;

    // Clawith identity, resolved exactly the way the runtime resolves it in
    // app/api/chatwoot/agent-bot/route.ts: per-agent row first, then the
    // tenant-level (agent_id IS NULL) fallback.
    let clawithAgentId: string | null = null;
    if (agentRow) {
      const perAgent = await prisma.clawithBinding.findFirst({
        where: { agent_id: agentRow.id },
        select: { clawith_agent_id: true },
      });
      const tenantLevel = perAgent
        ? null
        : await prisma.clawithBinding.findFirst({
            where: { tenant_id: cfg.tenantId, agent_id: null },
            select: { clawith_agent_id: true },
          });
      clawithAgentId = perAgent?.clawith_agent_id ?? tenantLevel?.clawith_agent_id ?? null;
    }

    const agent: AgentFacts | null = agentRow
      ? {
          id: agentRow.id,
          tenant_id: agentRow.tenant_id,
          brain_provider: agentRow.brain_provider,
          clawith_agent_id: clawithAgentId,
        }
      : null;

    // Every registration standing at this door — keyed by the door, never by
    // tenant_id. This is what makes "another ACTIVE registration already owns
    // this door" detectable at all.
    const doorRows: Array<{
      id: string;
      tenant_id: string;
      agent_id: string | null;
      base_url: string;
      account_id: string;
      inbox_id: string | null;
      mode: string;
      token: string;
      tenant: { status: string };
    }> = cfg.inboxId
      ? await prisma.chatwootBinding.findMany({
          where: { account_id: cfg.accountId, inbox_id: cfg.inboxId, mode: cfg.mode },
          select: {
            id: true,
            tenant_id: true,
            agent_id: true,
            base_url: true,
            account_id: true,
            inbox_id: true,
            mode: true,
            token: true,
            tenant: { select: { status: true } },
          },
        })
      : [];

    const doorRegistrations: ExistingRegistration[] = doorRows.map((r) => ({
      id: r.id,
      tenant_id: r.tenant_id,
      tenant_status: r.tenant.status,
      agent_id: r.agent_id,
      base_url: r.base_url,
      account_id: r.account_id,
      inbox_id: r.inbox_id,
      mode: r.mode,
      token: r.token,
    }));

    const desired: DesiredRegistration = {
      tenantId: cfg.tenantId,
      agentId: agent?.id ?? null,
      baseUrl: cfg.baseUrl,
      accountId: cfg.accountId,
      inboxId: cfg.inboxId,
      mode: cfg.mode,
      token: cfg.token,
    };

    // ── Decide ─────────────────────────────────────────────────────────────
    const decision = decideChatwootBindingSeed({
      desired,
      tenant: tenant ? { id: tenant.id, status: tenant.status } : null,
      agent,
      doorRegistrations,
    });

    for (const w of decision.warnings) {
      warn(
        `stale inactive registration left untouched at this door — binding=${w.binding_id} tenant=${w.tenant_id}(${w.tenant_status}) agent=${w.agent_id ?? 'null'}`,
      );
    }

    // ── Act — at most one write, exactly the one authorised ────────────────
    switch (decision.action) {
      case 'refuse':
        warn(describeSeedDecision(decision));
        return;

      case 'noop':
        // The correct registration already exists. Deliberately NO write:
        // ChatwootBinding.updated_at is @updatedAt, and an unconditional
        // refresh here is precisely what kept an invalid row permanently the
        // "freshest" row at a contested door.
        log(describeSeedDecision(decision));
        return;

      case 'create':
        await prisma.chatwootBinding.create({ data: decision.data });
        log(describeSeedDecision(decision));
        return;

      case 'update':
        await prisma.chatwootBinding.update({
          where: { id: decision.bindingId },
          data: decision.data,
        });
        log(describeSeedDecision(decision));
        return;
    }
  } catch (err) {
    console.error(`[instrumentation][cw-binding-guard][${cfg.label}] seed error:`, err);
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
    // NOT prisma.agent.upsert({where:{tenant_id}}) — Agent.tenant_id lost its
    // unique constraint in 9b1b9f7 (S4: one tenant can own multiple agents).
    // See seedEmaSalesAgent below for the full rationale.
    const existingDefaultAgent = await prisma.agent.findFirst({
      where: { tenant_id: adminTenantId },
      select: { id: true },
    });
    if (!existingDefaultAgent) {
      await prisma.agent.create({
        data: {
          tenant_id:         adminTenantId,
          name:              'Isola Assistant',
          greeting:          'Hello! How can I help you today?',
          business_info:     'EPIC Communications — multi-tenant WhatsApp AI platform serving Dominica.',
          intelligence_tier: 'advanced',  // claude-sonnet for admin/test tenant
          is_active:         true,
        },
      });
    } // idempotent — don't overwrite if owner has customised it
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
      // NOT prisma.agent.upsert({where:{tenant_id}}) — Agent.tenant_id lost
      // its unique constraint in 9b1b9f7 (S4: one tenant can own multiple
      // agents). See seedEmaSalesAgent below for the full rationale.
      const existingWaveBAgent = await prisma.agent.findFirst({
        where: { tenant_id: soul.tenantId },
        select: { id: true },
      });
      if (!existingWaveBAgent) {
        await prisma.agent.create({
          data: {
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
        });
      } else {
        await prisma.agent.update({
          where: { id: existingWaveBAgent.id },
          data: {
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
      }

      // 3. ChatwootBinding (mode='a2') — the ONLY routing key for A2 tenants.
      //
      // Was: findFirst({where:{tenant_id}}) then an unconditional
      // update({mode:'a2'}) on every cold start. That inferred door ownership
      // from the tenant, wrote a registration with a NULL agent pointer, and
      // bumped @updatedAt on every process start. Now routed through the one
      // governed writer, which refuses on a retired tenant, a NULL/unresolvable
      // agent pointer, a missing Clawith identity, or a door another ACTIVE
      // registration already owns — and writes nothing at all when the
      // registration is already correct.
      await applyChatwootBindingSeed(prisma, {
        label:      `Wave B / ${soul.agentName}`,
        tenantId:   soul.tenantId,
        agentName:  soul.agentName,
        baseUrl:    'https://inbox.epic.dm',
        accountId:  soul.chatwootAccountId,
        inboxId:    soul.chatwootInboxId,
        mode:       'a2',
        token:      '',                   // A2: uses CHATWOOT_AGENTBOT_TOKEN env var
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

    // NOT prisma.agent.upsert({where:{tenant_id}}) — Agent.tenant_id lost its
    // unique constraint in 9b1b9f7 (S4: one tenant can own multiple agents),
    // and that migration was applied to helium via db execute but never
    // added to runMigrations() below, so neon (this DATABASE_URL) never got
    // it either way the constraint is gone here (confirmed live 2026-07-18:
    // the upsert's ON CONFLICT throws Postgres 42P10 on every cold start).
    // 9b1b9f7 converted the two flip helpers below to find-then-create/update
    // but missed this seed's own upsert — this had been silently broken on
    // every cold start, which is why ema_sales_tenant never got an Agent row.
    const existingEmaAgent = await prisma.agent.findFirst({
      where: { tenant_id: EMA_SALES_TENANT_ID },
      select: { id: true },
    });
    if (!existingEmaAgent) {
      await prisma.agent.create({
        data: {
          tenant_id: EMA_SALES_TENANT_ID,
          name: EMA_SALES_AGENT_NAME,
          greeting: EMA_SALES_GREETING,
          business_info: EMA_SALES_BUSINESS_INFO,
          knowledge_text: EMA_SALES_KNOWLEDGE_TEXT,
          intelligence_tier: 'standard',
          is_active: true,
          brain_provider: 'native',
        },
      });
    } else {
      await prisma.agent.update({
        where: { id: existingEmaAgent.id },
        data: {
          // Soul-derived fields sync from source; operational fields untouched.
          name: EMA_SALES_AGENT_NAME,
          greeting: EMA_SALES_GREETING,
          business_info: EMA_SALES_BUSINESS_INFO,
          knowledge_text: EMA_SALES_KNOWLEDGE_TEXT,
        },
      });
    }

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

  // Was: findFirst({where:{tenant_id}}) then an unconditional update() that
  // resynced base_url/account_id/token/inbox_id/mode on EVERY cold start.
  // Because ChatwootBinding.updated_at is @updatedAt, that refresh kept this
  // tenant's row permanently the "freshest" registration at account 5 /
  // inbox 3 — a door tenant 43b006e4 already owns with a real Agent row —
  // even after this tenant was retired and its agent pointer went NULL.
  // resolveActiveBinding() breaks ties on updated_at, so the seeder was
  // actively fighting the tie-breaker.
  //
  // Now routed through the one governed writer: it refuses on a retired
  // tenant, refuses when the agent registration would be NULL or the Agent
  // row is missing, refuses when the Agent needs a Clawith identity it does
  // not have, refuses when another ACTIVE registration owns the door — and
  // performs NO write when the registration is already correct.
  await applyChatwootBindingSeed(prisma, {
    label:      'EMA sales',
    tenantId:   EMA_SALES_TENANT_ID,
    agentName:  EMA_SALES_AGENT_NAME,
    baseUrl:    EMA_CHATWOOT_BASE_URL,
    accountId:  EMA_CHATWOOT_ACCOUNT_ID,
    inboxId:    EMA_CHATWOOT_INBOX_ID,
    mode:       'a2',
    token,
  });
}

/**
 * EPIC's own Chatwoot mirror bindings (mode='mirror') for inboxes 7, 8, 12
 * on account 2 — see lib/epic-owner-chatwoot-seed-data.ts for the full
 * provenance (which inbox is which number, why mirror mode is provably safe
 * here, and why the token is a credential reference rather than a literal).
 *
 * Runs through the same governed writer as every other ChatwootBinding
 * write in this file: refuses on a retired tenant, a NULL/unresolvable
 * agent pointer, or a door another ACTIVE registration owns; writes nothing
 * when the registration already matches. Inbox 7 already has a live
 * registration whose token is a literal secret — including it here is what
 * migrates that row onto the reference (a normal `update` decision, diffing
 * `token` and, if it was null, `agent_id`), not a special case.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function seedEpicOwnerChatwootBindings(prisma: any) {
  for (const door of EPIC_CHATWOOT_DOORS) {
    await applyChatwootBindingSeed(prisma, {
      label: door.label,
      tenantId: EPIC_OWNER_TENANT_ID,
      agentName: EPIC_OWNER_AGENT_NAME,
      baseUrl: EPIC_CHATWOOT_BASE_URL,
      accountId: EPIC_CHATWOOT_ACCOUNT_ID,
      inboxId: door.inboxId,
      mode: 'mirror',
      token: EPIC_CHATWOOT_SERVICE_TOKEN_REF,
    });
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
    if (agent.brain_provider !== 'native') {
      // Already flipped past native — no-op. Not just "!== 'hermes'": a
      // later, more specific flip (flipEmaSalesToClawithOnce) may have since
      // moved this tenant past hermes, and this one-time flip must not
      // clobber that on the next cold start.
      return;
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
 * v1.11.0 cutover: EMA sales Agent.brain_provider → 'clawith', wired to the
 * new Isola bridge. Creates/refreshes the ClawithBinding row for
 * EMA_SALES_TENANT_ID (clawith_agent_id = EMA_CLAWITH_AGENT_ID, pinned via
 * agent_id to the Agent created by seedEmaSalesAgent above; the paperclip_*
 * columns are leftovers from the legacy dispatch contract, unused by the
 * bridge, left empty). Ships as code (prisma calls + the same audit() call
 * the admin PATCH route uses) rather than a raw SQL edit against production,
 * per this project's established convention.
 *
 * Deliberately NOT prisma.clawithBinding.upsert({where:{tenant_id}}) — same
 * reasoning as the Agent fix in seedEmaSalesAgent above: ClawithBinding.
 * tenant_id is not unique either (schema.prisma: `tenant_id String` +
 * `@@index([tenant_id])`, since a tenant can have multiple agents/bindings
 * post-S4), so upsert's ON CONFLICT would throw the same 42P10. This
 * find-then-create/update needs no DB-level unique constraint.
 *
 * The REAL safety boundary for this cutover is
 * ISOLA_BRIDGE_ALLOWED_PHONE_NUMBER_IDS in lib/brain-provider.ts — this flip
 * only ever touches EMA_SALES_TENANT_ID (phone_number_id 1023804347491554).
 * It never touches tenant 43b006e4's two already-live clawith numbers (old
 * clawith_agent_ids 8166ea11.../75ff7811...), which keep routing through
 * tryClawithLegacy exactly as before. Idempotent — no-ops once the Agent is
 * already 'clawith' with the target clawith_agent_id already set.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function flipEmaSalesToClawithOnce(prisma: any, adminTenantId: string | null) {
  try {
    const agent = await prisma.agent.findFirst({
      where: { tenant_id: EMA_SALES_TENANT_ID },
      select: { id: true, brain_provider: true },
    });
    if (!agent) {
      console.warn('[instrumentation] EMA sales agent not found — clawith flip deferred');
      return;
    }

    const existingBinding = await prisma.clawithBinding.findFirst({
      where: { tenant_id: EMA_SALES_TENANT_ID },
      select: { id: true, clawith_agent_id: true },
    });
    if (!existingBinding) {
      await prisma.clawithBinding.create({
        data: {
          tenant_id: EMA_SALES_TENANT_ID,
          agent_id: agent.id,
          clawith_agent_id: EMA_CLAWITH_AGENT_ID,
          paperclip_agent_id: '',
          paperclip_company_id: '',
        },
      });
      console.log('[instrumentation] EMA ClawithBinding created — tenant', EMA_SALES_TENANT_ID);
    } else if (existingBinding.clawith_agent_id !== EMA_CLAWITH_AGENT_ID) {
      await prisma.clawithBinding.update({
        where: { id: existingBinding.id },
        data: { clawith_agent_id: EMA_CLAWITH_AGENT_ID },
      });
      console.log('[instrumentation] EMA ClawithBinding clawith_agent_id updated — tenant', EMA_SALES_TENANT_ID);
    }

    if (agent.brain_provider === 'clawith') {
      return; // already flipped — no-op
    }

    await prisma.agent.update({
      where: { id: agent.id },
      data: { brain_provider: 'clawith' },
    });

    await audit({
      tenantId: adminTenantId ?? EMA_SALES_TENANT_ID,
      actorId: 'instrumentation:flip-ema-sales-clawith',
      action: 'admin.tenant.update',
      entity: 'tenant',
      entityId: EMA_SALES_TENANT_ID,
      meta: { changes: ['brain_provider'], from: agent.brain_provider, to: 'clawith' },
    });

    console.log('[instrumentation] EMA sales brain_provider flipped to clawith — tenant', EMA_SALES_TENANT_ID);
  } catch (err) {
    console.error('[instrumentation] EMA sales clawith flip error:', err);
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
