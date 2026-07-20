import { redirect } from 'next/navigation';
import { requireAdmin } from '@/lib/admin-guard';
import { isMagnusConfigured } from '@/lib/engines';
import { getVoiceHealthReport } from '@/lib/voice-health-report';
import { VoiceHealthTable } from './VoiceHealthTable';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';

export const metadata = { title: 'Admin — Voice Health' };
export const revalidate = 0;

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

  const stats = [
    { label: 'Total lines', value: summary.total },
    { label: 'Green', value: summary.green },
    { label: 'Amber', value: summary.amber },
    { label: 'Red', value: summary.red },
    { label: 'Retired', value: summary.gray },
  ];

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Voice Health</h1>
        <p className="text-sm text-muted-foreground">
          Live per-line status, cross-checked against Magnus (voice00). Read-only.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
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
          <CardTitle className="text-sm">All voice lines</CardTitle>
        </CardHeader>
        <CardContent>
          <VoiceHealthTable initialReport={report} />
        </CardContent>
      </Card>
    </div>
  );
}
