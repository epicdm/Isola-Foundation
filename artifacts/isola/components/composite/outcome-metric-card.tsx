import Link from 'next/link';
import type { LucideIcon } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';

export interface OutcomeMetric {
  label: string;
  value: string;
  icon: LucideIcon;
  trend?: string;
  trendTone?: 'positive' | 'neutral';
  href?: string;
}

// OutcomeMetricCard — a business outcome, not a raw system count. Distinguish from
// TrendMetricCard (below) which is for genuinely time-series data (charts).
// Fix (review item 5): when href is set, the ENTIRE card is a focusable link (not just
// the trend line) — clicking anywhere on the card navigates, and keyboard/focus-ring
// behavior comes for free from the anchor wrapping the whole surface.
export function OutcomeMetricCard({ metric }: { metric: OutcomeMetric }) {
  const Icon = metric.icon;
  const body = (
    <>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{metric.label}</CardTitle>
        <Icon className="size-4 text-muted-foreground" />
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold tracking-tight">{metric.value}</div>
        {metric.trend && (
          <p className={cn('mt-0.5 text-xs', metric.trendTone === 'positive' ? 'text-primary' : 'text-muted-foreground')}>{metric.trend}</p>
        )}
      </CardContent>
    </>
  );
  if (metric.href) {
    return (
      <Link href={metric.href} className="block focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-xl" aria-label={`${metric.label}: ${metric.value}. ${metric.trend ?? ''}`}>
        <Card className="transition-colors hover:border-primary/40 hover:bg-accent/40">{body}</Card>
      </Link>
    );
  }
  return <Card>{body}</Card>;
}

export function TrendMetricCard({ label, value, trend }: { label: string; value: string; trend: string }) {
  return (
    <Card>
      <CardHeader className="pb-2"><CardTitle className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</CardTitle></CardHeader>
      <CardContent>
        <div className="text-2xl font-bold tracking-tight">{value}</div>
        <p className="mt-0.5 text-xs text-muted-foreground">{trend}</p>
      </CardContent>
    </Card>
  );
}
