import { redirect, notFound } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, ExternalLink, Phone, AlertTriangle } from 'lucide-react';
import { getSession } from '@/lib/session';
import { prisma } from '@/lib/prisma';
import { getCurrentUsage } from '@/lib/meter';
import { TenantActions } from './TenantActions';
import { VoiceProvisioning } from './VoiceProvisioning';
import { CreateAgentButton } from './CreateAgentButton';
import { MagnusPlanCard } from './MagnusPlanCard';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { OutcomeMetricCard, type OutcomeMetric } from '@/components/composite/outcome-metric-card';
import { Wallet, MessageCircle, Bot, PhoneCall } from 'lucide-react';

export const revalidate = 0;

const usd = (n: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);

/**
 * SCREEN B — operator Contextual Tenant Workspace.
 * Ratified: dec-isola-v7-screen-b-operator-tenant-detail-2026-07-26.
 *
 * Platform-admin/operator ONLY. This is the sole implementation of the customer-context
 * workspace. Owner /workspace is the generic owner work queue and is NOT this screen; it is
 * untouched by every package in this handover.
 *
 * Data authority (see design/CHANGE-DELTA.md):
 *   identity/status/plan/entitlements/channel bindings .... Isola Foundation (Prisma, proven)
 *   products & services ................................... Odoo (NO adapter proven -> honest unavailable state)
 *   invoices & payment state .............................. Odoo (NO adapter proven -> honest unavailable state)
 *   business activity ..................................... Odoo or governed Foundation aggregation (NOT proven)
 *   tasks ................................................. Odoo (NOT proven)
 *   Chatwoot doors ....................................... exact (account_id, inbox_id, mode) from ChatwootBinding
 *   conversation summaries ................................ NO live Chatwoot adapter proven -> inbox-level links only
 *   risks & blockers ...................................... deterministic Foundation/Isola signals (proven fields only)
 *   call action ........................................... existing authorized Isola/PBX workflow only (NOT proven -> disabled)
 *
 * Nothing below fabricates a data source, an API, or a mock production record. Where an adapter
 * is not proven to exist in this repository, the section renders an honest unavailable state and
 * names the engineering adapter required.
 */
export default async function TenantDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await getSession();
  if (!session?.isAdmin) redirect('/');

  const { id } = await params;
  const [tenant, usage] = await Promise.all([
    prisma.tenant.findUnique({
      where: { id },
      include: {
        subscription: true,
        wallet: true,
        agents: true,
        whatsapp_numbers: true,
        chatwoot_bindings: true,
        users: true,
        _count: { select: { conversations: true, wallet_txns: true, audit_logs: true } },
      },
    }),
    getCurrentUsage(id),
  ]);
  if (!tenant) notFound();

  const isActingAsThis = session.user.act_as_tenant_id === id;

  /**
   * CHATWOOT DOORS — resolved from the ACTUAL ChatwootBinding model.
   *
   * ChatwootBinding fields: id, tenant_id, agent_id, base_url, account_id, token, inbox_id,
   * mode, created_at, updated_at. There is NO is_active field and none is invented here.
   * Binding activity/retirement is NOT a binding property — the TENANT's status determines
   * whether this tenant is active or retired.
   *
   * A "door" is the exact triple (account_id, inbox_id, mode). Several distinct doors belonging
   * to one tenant are legitimate and are NOT duplicates — each is rendered. A duplicate is more
   * than one registration for the SAME exact triple, which fails closed. No arbitrary selection,
   * no account-only lookup, no unordered findFirst.
   */
  const tenantIsActive = tenant.status === 'active';
  const normalizeBase = (u: string) => u.replace(/\/+$/, '');

  /**
   * A base_url is usable only when it is a non-blank absolute http(s) URL. Blank, whitespace and
   * unparseable values make the door INVALID: it generates no action and raises an explicit risk.
   * NEXT_PUBLIC_CHATWOOT_BASE_URL is deliberately NOT consulted as a fallback — the binding is the
   * authority for its own door, and substituting an environment default would silently point an
   * operator at a Chatwoot instance the binding never named.
   */
  const isUsableBase = (u: unknown): u is string => {
    if (typeof u !== 'string' || u.trim() === '') return false;
    try {
      const parsed = new URL(u.trim());
      return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
      return false;
    }
  };

  /**
   * CORRECTION A — duplicate detection runs BEFORE any base_url filtering.
   *
   * Candidates are every binding carrying a non-null inbox_id. Filtering for a usable base_url
   * first (the prior behaviour) would drop a malformed duplicate out of the count, reduce an
   * ambiguous door to an apparent single winner, and then render an action for it. Counting first
   * is what makes the duplicate visible at all.
   *
   * A binding with inbox_id === null is NOT a door: it registers no Chatwoot inbox, generates no
   * action, and is never counted as a duplicate of a real door. It is reported separately.
   */
  const doorCandidates = tenant.chatwoot_bindings
    .filter((binding) => binding.inbox_id !== null)
    .map((binding) => ({
      binding,
      key: `${binding.account_id}|${binding.inbox_id}|${binding.mode}`,
    }));

  const keyCounts = doorCandidates.reduce<Record<string, number>>((acc, candidate) => {
    acc[candidate.key] = (acc[candidate.key] ?? 0) + 1;
    return acc;
  }, {});
  const duplicateKeys = Object.keys(keyCounts).filter((k) => keyCounts[k] > 1);
  const noDoorBindings = tenant.chatwoot_bindings.filter((b) => b.inbox_id === null).length;

  /**
   * CORRECTION B — every distinct door key renders once, carrying its own verdict. Two different
   * inbox ids are two legitimate doors, not an ambiguity, and each renders separately. An exact
   * duplicate key fails closed on ITS OWN row: no winner is chosen, no findFirst is used, no
   * ordering decides it. A healthy distinct door is unaffected by another door's duplicate.
   */
  type Door = {
    key: string;
    accountId: string;
    inboxId: string;
    mode: string;
    count: number;
    url: string | null;
    verdict: 'ok' | 'duplicate' | 'invalid-base';
  };

  const doors: Door[] = Object.keys(keyCounts)
    .sort((a, b) => a.localeCompare(b))
    .map((key) => {
      const members = doorCandidates.filter((candidate) => candidate.key === key);
      const first = members[0].binding;
      const duplicate = members.length > 1;
      const baseUsable = isUsableBase(first.base_url);
      return {
        key,
        accountId: String(first.account_id),
        inboxId: String(first.inbox_id),
        mode: String(first.mode),
        count: members.length,
        url:
          !duplicate && baseUsable && tenantIsActive
            ? `${normalizeBase(first.base_url)}/app/accounts/${first.account_id}/inbox/${first.inbox_id}`
            : null,
        verdict: duplicate ? 'duplicate' : baseUsable ? 'ok' : 'invalid-base',
      };
    });

  const invalidBaseDoors = doors.filter((d) => d.verdict === 'invalid-base');

  /**
   * Tenant-level gate. Tenant.status is the activity/retirement authority — ChatwootBinding has no
   * is_active field and none is invented. A non-active tenant withholds every Chatwoot action.
   */
  const doorProblem = !tenantIsActive
    ? `Tenant status is "${tenant.status}" — Chatwoot actions are withheld for non-active tenants.`
    : doors.length === 0
      ? noDoorBindings > 0
        ? 'No Chatwoot door — the binding(s) for this tenant carry no inbox_id.'
        : 'No Chatwoot binding for this tenant.'
      : null;

  /**
   * "View full conversation" requires a specific Chatwoot conversation id. No live Chatwoot
   * conversation-summary adapter is proven in this repository and no conversation is selected,
   * so that action ships DISABLED. Inbox-level links are labelled honestly as "Open Chatwoot inbox".
   */
  const resolvedConversationUrl: string | null = null;

  /**
   * RISKS & BLOCKERS — deterministic Foundation/Isola operational signals only.
   * Every entry below is derived from a proven Prisma field. No thresholds are invented:
   * each condition is a state the schema explicitly models.
   */
  const risks: { label: string; detail: string }[] = [];
  if (tenant.status !== 'active') {
    risks.push({ label: `Tenant status: ${tenant.status}`, detail: 'Service behaviour follows the non-active tenant state.' });
  }
  if (tenant.voice_provisioning_state === 'failed' || tenant.voice_provisioning_error) {
    risks.push({
      label: 'Voice provisioning did not complete',
      detail: tenant.voice_provisioning_error ?? 'Provisioning state reports a failure.',
    });
  }
  if (doorProblem) {
    risks.push({ label: 'Chatwoot actions withheld', detail: doorProblem });
  }
  for (const k of duplicateKeys) {
    const [acct, inbox, mode] = k.split('|');
    risks.push({
      label: 'Duplicate Chatwoot door registration',
      detail: `More than one registration exists for the same exact (account_id, inbox_id, mode) = (${acct}, ${inbox}, ${mode}). Actions for this door are withheld and no winner is chosen. Resolve the duplicate registration, then reload.`,
    });
  }
  for (const d of invalidBaseDoors) {
    risks.push({
      label: 'Chatwoot binding has no usable base_url',
      detail: `The registration for (account_id, inbox_id, mode) = (${d.accountId}, ${d.inboxId}, ${d.mode}) has a blank or invalid base_url, so no link can be generated. No environment default is substituted.`,
    });
  }
  if (noDoorBindings > 0) {
    risks.push({
      label: `${noDoorBindings} Chatwoot registration${noDoorBindings === 1 ? '' : 's'} with no inbox`,
      detail: 'These registrations carry no inbox_id, so they open no Chatwoot door and generate no action. They are not duplicates of a real door.',
    });
  }
  if (tenant.whatsapp_numbers.length === 0) {
    risks.push({ label: 'No WhatsApp number connected', detail: 'The tenant has no connected WhatsApp asset.' });
  }
  if (!tenant.agents[0]) {
    risks.push({ label: 'No assistant configured', detail: 'The governance adapter needs an Agent id to wire this tenant.' });
  }

  const metrics: OutcomeMetric[] = [
    { label: 'Wallet balance', value: tenant.wallet ? `${tenant.wallet.currency} ${tenant.wallet.balance_cache.toFixed(2)}` : '—', icon: Wallet },
    { label: 'Conversations', value: String(tenant._count.conversations), icon: MessageCircle },
    { label: 'AI usage (tokens)', value: (usage?.tokens_used ?? 0).toLocaleString(), icon: Bot, trend: usd(usage?.tokens_cost ?? 0) },
    { label: 'Call minutes (this month)', value: (usage?.minutes_used ?? 0).toFixed(1), icon: PhoneCall, trend: usd(usage?.minutes_cost ?? 0) },
  ];

  return (
    <div className="flex flex-col gap-6">
      {/* Context header — identity, status, plan, and the two context actions */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <Link href="/admin" className="mb-1 flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
            <ArrowLeft className="size-3.5" /> All tenants
          </Link>
          <h1 className="text-2xl font-semibold tracking-tight">{tenant.business_name}</h1>
          <div className="mt-2 flex flex-wrap gap-2">
            <Badge variant={tenant.status === 'active' ? 'default' : 'destructive'}>{tenant.status}</Badge>
            <Badge variant="secondary">{tenant.plan}</Badge>
            {tenant.subscription ? <Badge variant="outline">{tenant.subscription.status}</Badge> : null}
          </div>
        </div>
        {/*
          Cross-axis alignment is items-start, NOT items-center. TenantActions is a tall
          stacked block (act-as / reactivate / plan select / credit adjustment) and becomes
          this row's height driver; items-center vertically centred the two context actions
          against it, stranding them mid-band and opening a large void under the tenant name.
          The golden reference places this action pair on the header line. Presentation only —
          both buttons keep their existing disabled state, titles and behaviour.
        */}
        <div className="flex flex-wrap items-start gap-2">
          {/*
            "View full conversation" needs a real Chatwoot conversation id. None is resolvable here,
            so it ships disabled. Inbox-level access is offered per exact door in the conversations
            card below, labelled "Open Chatwoot inbox".
          */}
          <Button
            variant="outline"
            disabled={resolvedConversationUrl === null}
            title="Requires a specific Chatwoot conversation id. No live Chatwoot conversation-summary adapter is wired, so no conversation can be resolved."
          >
            View full conversation <ExternalLink className="size-3.5" />
          </Button>
          {/*
            CALL CONTROL — ships disabled. No endpoint is invented here. Calling becomes available
            only after the existing PBX action, the customer identity contract and the authorization
            contract are all proven in this repository.
          */}
          <Button
            variant="secondary"
            disabled
            title="Calling becomes available only after the existing PBX action, customer identity contract and authorization contract are proven."
          >
            <Phone className="size-3.5" /> Call (unavailable)
          </Button>
          <TenantActions
            tenantId={id}
            tenantName={tenant.business_name}
            currentPlan={tenant.plan}
            currentStatus={tenant.status}
            isActingAs={isActingAsThis}
          />
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {metrics.map((m) => <OutcomeMetricCard key={m.label} metric={m} />)}
      </div>

      {/* Risks & blockers — deterministic signals only */}
      {risks.length > 0 ? (
        <Card className="border-amber-500/40">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-sm">
              <AlertTriangle className="size-4 text-amber-600" /> Risks and blockers
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {risks.map((r) => (
              <div key={r.label}>
                <div className="text-sm font-medium">{r.label}</div>
                <div className="text-xs text-muted-foreground">{r.detail}</div>
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        {/* Recent conversations — Chatwoot, deterministic binding, fail-closed */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">Recent conversations</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            {doors.length > 0 && !doorProblem ? (
              <>
                {doors.map((d) => (
                  <div key={d.key} className="flex flex-wrap items-center justify-between gap-2 border-b pb-2 last:border-b-0 last:pb-0">
                    <div className="text-xs text-muted-foreground">
                      account <span className="font-mono">{d.accountId}</span> · inbox{' '}
                      <span className="font-mono">{d.inboxId}</span> · mode{' '}
                      <span className="font-mono">{d.mode}</span>
                      {d.verdict === 'duplicate' ? (
                        <span className="ml-2 font-medium text-destructive">
                          {d.count} duplicate registrations — action withheld
                        </span>
                      ) : null}
                      {d.verdict === 'invalid-base' ? (
                        <span className="ml-2 font-medium text-destructive">no usable base_url — action withheld</span>
                      ) : null}
                    </div>
                    {d.url ? (
                      <Button asChild size="sm" variant="outline">
                        <a href={d.url} target="_blank" rel="noopener noreferrer">
                          Open Chatwoot inbox <ExternalLink className="size-3.5" />
                        </a>
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled
                        title="No link is generated for a duplicated or unusable door registration."
                      >
                        Open Chatwoot inbox <ExternalLink className="size-3.5" />
                      </Button>
                    )}
                  </div>
                ))}
                <Row label="Foundation conversation records (local mirror count)" value={String(tenant._count.conversations)} />
                <p className="text-xs text-muted-foreground">
                  The count above is Isola&apos;s local Foundation mirror, not a live Chatwoot summary.
                  Conversation history and composition live in Chatwoot — Isola stores no second copy
                  and offers no second inbox. Live summaries require a Chatwoot conversation adapter,
                  which is not wired.
                </p>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">
                Unavailable — {doorProblem} Required engineering adapter: a resolver that returns each
                distinct (account_id, inbox_id, mode) door for a tenant, failing closed on a retired
                tenant, a missing inbox_id, a missing base_url, or a duplicate exact door key — plus a
                Chatwoot conversation-summary adapter to enable conversation-level links.
              </p>
            )}
          </CardContent>
        </Card>

        {/* Products & services — Odoo, adapter not proven */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">Products and services</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              Not configured — no Odoo product/service adapter exists in this repository. Required
              engineering adapter: read the tenant&apos;s purchased products and services from Odoo,
              keyed by the canonical Isola tenant identifier. Plan and entitlement state shown above
              comes from Isola Foundation and is not a substitute.
            </p>
          </CardContent>
        </Card>

        {/* Invoices & payment state — Odoo + billing/wallet adapters, not proven */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">Invoices and payment state</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              Not configured — no Odoo invoice adapter exists in this repository. Required
              engineering adapter: read invoices and payment status from Odoo, with payment state
              reconciled through the canonical billing and wallet adapters. Wallet balance shown
              above is the Magnus-authoritative voice balance only, not an invoice position.
            </p>
          </CardContent>
        </Card>

        {/* Recent business activity — Odoo or governed Foundation aggregation, not proven */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">Recent business activity</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              Not configured — no business-activity source is wired. Required engineering adapter:
              Odoo activity, or an explicitly governed Foundation aggregation of Odoo activity. The
              existing audit log ({tenant._count.audit_logs} entries) is internal platform audit, not
              customer business activity, and is deliberately not substituted here.
            </p>
          </CardContent>
        </Card>

        {/* Open tasks — Odoo, not proven */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">Open tasks</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              Not configured — no Odoo task adapter exists in this repository. Required engineering
              adapter: read open tasks for this tenant from Odoo.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Tenant details</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            <Row label="ID" value={tenant.id} mono />
            <Row label="Created" value={new Date(tenant.created_at).toLocaleDateString()} />
            <Row label="Magnus ID" value={tenant.magnus_user_id ?? '—'} />
            <Row label="Users" value={String(tenant.users.length)} />
            <Row label="WA numbers" value={String(tenant.whatsapp_numbers.length)} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">AI Agent</CardTitle>
          </CardHeader>
          <CardContent>
            {tenant.agents[0] ? (
              <div className="flex flex-col gap-2">
                <Row label="Agent id" value={tenant.agents[0].id} mono />
                <Row label="Name" value={tenant.agents[0].name} />
                <Row label="Tier" value={tenant.agents[0].intelligence_tier} />
                <Row label="Active" value={tenant.agents[0].is_active ? 'Yes' : 'No'} />
                <Row label="Brain provider" value={tenant.agents[0].brain_provider} />
                <Row label="Flowise flow id" value={tenant.agents[0].flowise_flow_id ?? '—'} mono />
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                <p className="text-sm text-muted-foreground">
                  No agent configured — the governance adapter needs an Agent id to wire this tenant.
                </p>
                <CreateAgentButton tenantId={id} />
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Users</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {tenant.users.map((u) => (
              <div key={u.id} className="flex items-center justify-between">
                <div>
                  <div className="text-sm font-medium">{u.name ?? u.email ?? u.replit_id}</div>
                  <div className="text-xs text-muted-foreground">{u.email}</div>
                </div>
                <Badge variant={u.role === 'admin' ? 'secondary' : 'outline'}>{u.role}</Badge>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">WhatsApp Numbers</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {tenant.whatsapp_numbers.length === 0 ? (
              <p className="text-sm text-muted-foreground">None connected.</p>
            ) : (
              tenant.whatsapp_numbers.map((n) => (
                <div key={n.id}>
                  <div className="text-sm font-medium">{n.phone_number}</div>
                  <div className="text-xs text-muted-foreground">ID: {n.phone_number_id}</div>
                </div>
              ))
            )}
          </CardContent>
        </Card>

        <MagnusPlanCard tenantId={id} magnusUserId={tenant.magnus_user_id} />

        <VoiceProvisioning
          tenantId={id}
          state={tenant.voice_provisioning_state}
          error={tenant.voice_provisioning_error}
          magnusUserId={tenant.magnus_user_id}
          sipId={tenant.magnus_sip_id}
          sipUsername={tenant.magnus_sip_username}
          didId={tenant.magnus_did_id}
          didNumber={tenant.magnus_did_number}
          diddestinationId={tenant.magnus_diddestination_id}
          calleridId={tenant.magnus_callerid_id}
        />
      </div>
    </div>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex justify-between gap-3 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className={mono ? 'break-all text-right font-mono text-[11px]' : 'text-right'}>{value}</span>
    </div>
  );
}
