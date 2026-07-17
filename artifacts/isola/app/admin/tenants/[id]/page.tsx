import { redirect, notFound } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { getSession } from '@/lib/session';
import { prisma } from '@/lib/prisma';
import { getCurrentUsage } from '@/lib/meter';
import { TenantActions } from './TenantActions';
import { VoiceProvisioning } from './VoiceProvisioning';
import { CreateAgentButton } from './CreateAgentButton';
import { MagnusPlanCard } from './MagnusPlanCard';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

export const revalidate = 0;

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

  const stats = [
    {
      label: 'Wallet balance',
      value: tenant.wallet ? `${tenant.wallet.currency} ${tenant.wallet.balance_cache.toFixed(2)}` : '—',
    },
    { label: 'Conversations', value: String(tenant._count.conversations) },
    {
      label: 'AI tokens (this month)',
      value: (usage?.tokens_used ?? 0).toLocaleString(),
      sub: `$${(usage?.tokens_cost ?? 0).toFixed(2)}`,
    },
    {
      label: 'Call minutes (this month)',
      value: (usage?.minutes_used ?? 0).toFixed(1),
      sub: `$${(usage?.minutes_cost ?? 0).toFixed(2)}`,
    },
  ];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <Link href="/admin" className="mb-1 flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
            <ArrowLeft className="size-3.5" /> All tenants
          </Link>
          <h1 className="text-2xl font-semibold tracking-tight">{tenant.business_name}</h1>
          <div className="mt-2 flex gap-2">
            <Badge variant={tenant.status === 'active' ? 'default' : 'destructive'}>{tenant.status}</Badge>
            <Badge variant="secondary">{tenant.plan}</Badge>
          </div>
        </div>
        <TenantActions
          tenantId={id}
          tenantName={tenant.business_name}
          currentPlan={tenant.plan}
          currentStatus={tenant.status}
          isActingAs={isActingAsThis}
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {stats.map((s) => (
          <Card key={s.label}>
            <CardHeader className="pb-2">
              <CardTitle className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {s.label}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold tracking-tight">{s.value}</div>
              {s.sub && <div className="text-xs text-muted-foreground">{s.sub}</div>}
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
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
