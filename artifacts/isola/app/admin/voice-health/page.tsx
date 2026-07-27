import { redirect } from 'next/navigation';
import { requireAdmin } from '@/lib/admin-guard';
import { isMagnusConfigured } from '@/lib/engines';
import { getVoiceHealthReport } from '@/lib/voice-health-report';
import { VoiceHealthTable } from './VoiceHealthTable';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { OwnerPageHeader } from '@/components/composite/owner-page-header';
import { OutcomeMetricCard, type OutcomeMetric } from '@/components/composite/outcome-metric-card';
import { Phone, CircleCheck, CircleAlert, CircleX, CircleDashed } from 'lucide-react';

export const metadata = { title: 'Admin — Voice Health' };
export const revalidate = 0;

// GOLDEN-STANDARD PASS (visual only, same reasoning as plans/page.tsx): OutcomeMetricCard
// replaces the flat 5-stat grid. "Magnus" stays — correct for this internal console.
export default async function VoiceHealthPage() {
  const guard = await requireAdmin();
  if (!guard.ok) redirect('/');

  if (!isMagnusConfigured()) {
    return (
      <div className="flex flex-col gap-6">
        <h1 className="text-2xl font-semibold tracking-tight">Voice Health</h1>
        <Alert variant="destructive">
          <AlertDescription>Magnus is not configured — cannot compute voice line health.</AlertDescription>
        </Alert>
      </div>
    );
  }

  const report = await getVoiceHealthReport();
  const { summary } = report;

  const metrics: OutcomeMetric[] = [
    { label: 'Total lines', value: String(summary.total), icon: Phone },
    { label: 'Green', value: String(summary.green), icon: CircleCheck, trendTone: 'positive', trend: 'Healthy' },
    { label: 'Amber', value: String(summary.amber), icon: CircleAlert },
    { label: 'Red', value: String(summary.red), icon: CircleX },
    { label: 'Retired', value: String(summary.gray), icon: CircleDashed },
  ];

  return (
    <div className="flex flex-col gap-6">
      <OwnerPageHeader title="Voice Health" eyebrow="Live per-line status, cross-checked against Magnus (voice00). Read-only." />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        {metrics.map((m) => <OutcomeMetricCard key={m.label} metric={m} />)}
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">All voice lines</CardTitle>
        </CardHeader>
        <CardContent>
          <VoiceHealthTable initialReport={report} />
        </CardContent>
      </Card>
    </div>
  );
}
