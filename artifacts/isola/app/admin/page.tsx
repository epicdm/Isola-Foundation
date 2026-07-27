import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';
import { prisma } from '@/lib/prisma';
import { NewTenantForm } from './NewTenantForm';
import { TenantsDataTable, type TenantRow } from '@/components/tenants-data-table';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { OwnerPageHeader } from '@/components/composite/owner-page-header';
import { OutcomeMetricCard, type OutcomeMetric } from '@/components/composite/outcome-metric-card';
import { Users, CheckCircle2, Crown, TrendingUp } from 'lucide-react';

export const metadata = { title: 'Admin — Tenants' };
export const revalidate = 0;

// GOLDEN-STANDARD PASS: same OutcomeMetricCard/OwnerPageHeader composite layer used on the
// tenant-side dashboard/team/workspace, applied here to the separate operator console —
// this is a visual-consistency pass only. Realm separation (admin vs owner) is unchanged:
// this route is still gated by session.isAdmin and renders none of the tenant nav/shell.
export default async function AdminPage() {
  const session = await getSession();
  if (!session?.isAdmin) redirect('/');

  const tenants = await prisma.tenant.findMany({
    include: {
      subscription: true,
      wallet: { select: { balance_cache: true, currency: true } },
      agents: { select: { id: true, name: true, brain_provider: true, flowise_flow_id: true } },
      _count: { select: { users: true, conversations: true } },
    },
    orderBy: { created_at: 'desc' },
  });

  const metrics: OutcomeMetric[] = [
    { label: 'Total tenants', value: String(tenants.length), icon: Users },
    { label: 'Active', value: String(tenants.filter((t) => t.status === 'active').length), icon: CheckCircle2, trendTone: 'positive', trend: 'Currently active' },
    { label: 'Pro plan', value: String(tenants.filter((t) => t.plan === 'pro').length), icon: Crown },
    { label: 'Growth plan', value: String(tenants.filter((t) => t.plan === 'growth').length), icon: TrendingUp },
  ];

  const rows: TenantRow[] = tenants.map((t) => ({
    id: t.id,
    business_name: t.business_name,
    plan: t.plan,
    status: t.status,
    balance: t.wallet ? `${t.wallet.currency} ${t.wallet.balance_cache.toFixed(2)}` : null,
    users: t._count.users,
    conversations: t._count.conversations,
    createdAt: new Date(t.created_at).toLocaleDateString(),
    agents: t.agents.map((a) => ({
      id: a.id,
      label: `${a.name} — brain: ${a.brain_provider}${a.flowise_flow_id ? ` (${a.flowise_flow_id})` : ''}`,
    })),
  }));

  return (
    <div className="flex flex-col gap-6">
      <OwnerPageHeader title="Tenants" eyebrow={`${tenants.length} tenant${tenants.length !== 1 ? 's' : ''} on the platform`} />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {metrics.map((m) => <OutcomeMetricCard key={m.label} metric={m} />)}
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">All tenants</CardTitle>
        </CardHeader>
        <CardContent>
          <TenantsDataTable data={rows} />
        </CardContent>
      </Card>

      <NewTenantForm />
    </div>
  );
}
