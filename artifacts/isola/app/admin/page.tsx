import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';
import { prisma } from '@/lib/prisma';
import { NewTenantForm } from './NewTenantForm';
import { TenantsDataTable, type TenantRow } from '@/components/tenants-data-table';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export const metadata = { title: 'Admin — Tenants' };
export const revalidate = 0;

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

  const stats = [
    { label: 'Total tenants', value: tenants.length },
    { label: 'Active', value: tenants.filter((t) => t.status === 'active').length },
    { label: 'Pro plan', value: tenants.filter((t) => t.plan === 'pro').length },
    { label: 'Growth plan', value: tenants.filter((t) => t.plan === 'growth').length },
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
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Tenants</h1>
        <p className="text-sm text-muted-foreground">
          {tenants.length} tenant{tenants.length !== 1 ? 's' : ''} on the platform
        </p>
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
            </CardContent>
          </Card>
        ))}
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
