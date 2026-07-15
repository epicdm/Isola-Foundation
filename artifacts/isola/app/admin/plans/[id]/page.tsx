import { redirect, notFound } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { getSession } from '@/lib/session';
import { getMagnusConfig, isMagnusConfigured } from '@/lib/engines';
import { getRatePlan, listPlanRates } from '@/lib/magnus-rateplan';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { PlanRatesPanel } from './PlanRatesPanel';

export const metadata = { title: 'Admin — Plan detail' };
export const revalidate = 0;

export default async function PlanDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session?.isAdmin) redirect('/');

  const { id } = await params;

  if (!isMagnusConfigured()) {
    return (
      <Alert variant="destructive">
        <AlertDescription>Magnus is not configured.</AlertDescription>
      </Alert>
    );
  }

  const config = getMagnusConfig();
  const plan = await getRatePlan(config, id);
  if (!plan) notFound();

  const { rates, totalForPlan } = await listPlanRates(config, id, { limit: 1000 });

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link href="/admin/plans" className="mb-1 flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-3.5" /> All plans
        </Link>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-semibold tracking-tight">{plan.name}</h1>
          <Badge variant="secondary">Magnus plan id {plan.id}</Badge>
        </div>
        <p className="text-sm text-muted-foreground">
          {totalForPlan} destination rate{totalForPlan === 1 ? '' : 's'} configured for this plan.
        </p>
      </div>

      <PlanRatesPanel planId={plan.id} planName={plan.name} initialRates={rates} />
    </div>
  );
}
