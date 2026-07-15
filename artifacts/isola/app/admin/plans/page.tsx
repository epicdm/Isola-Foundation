import { redirect } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { getSession } from '@/lib/session';
import { getMagnusConfig, isMagnusConfigured } from '@/lib/engines';
import { listRatePlans } from '@/lib/magnus-rateplan';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';

export const metadata = { title: 'Admin — Plans & Rates' };
export const revalidate = 0;

export default async function PlansPage() {
  const session = await getSession();
  if (!session?.isAdmin) redirect('/');

  if (!isMagnusConfigured()) {
    return (
      <div className="flex flex-col gap-4">
        <Header />
        <Alert variant="destructive">
          <AlertDescription>Magnus is not configured (MAGNUS_URL / MAGNUS_API_KEY / MAGNUS_API_SECRET).</AlertDescription>
        </Alert>
      </div>
    );
  }

  let plans;
  let error: string | null = null;
  try {
    plans = await listRatePlans(getMagnusConfig());
  } catch (e: any) {
    error = e.message;
  }

  return (
    <div className="flex flex-col gap-6">
      <Header />
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>Failed to load Magnus rate plans: {error}</AlertDescription>
        </Alert>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {plans!.map((p) => (
            <Link key={p.id} href={`/admin/plans/${p.id}`}>
              <Card className="transition-colors hover:border-primary/50">
                <CardHeader className="pb-2">
                  <CardTitle className="text-base">{p.name}</CardTitle>
                </CardHeader>
                <CardContent className="flex flex-col gap-1 text-sm text-muted-foreground">
                  <div>Magnus plan id: <span className="font-mono">{p.id}</span></div>
                  <div>Tariff limit: {p.tariffLimit}</div>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

function Header() {
  return (
    <div>
      <Link href="/admin" className="mb-1 flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-3.5" /> Admin
      </Link>
      <h1 className="text-2xl font-semibold tracking-tight">Plans &amp; Rates</h1>
      <p className="text-sm text-muted-foreground">
        Live Magnus rate plans. Open a plan to view and edit its per-destination sell rates.
      </p>
    </div>
  );
}
