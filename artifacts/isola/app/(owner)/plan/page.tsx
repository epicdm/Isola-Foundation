import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';
import { prisma } from '@/lib/prisma';
import { getCurrentUsage } from '@/lib/meter';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';

export const metadata = { title: 'Plan & Usage' };

// F3: a previous "wording alignment" relabelled AI turns as thousands of tokens while leaving
// the limit VALUES untouched. That silently restated a 500-turn allowance as "500k tokens" and
// a 2,000-turn allowance as "2,000k tokens", overstating both by orders of magnitude.
// lib/plans.ts is the ratified source and defines these limits in AI TURNS (500 / 2,000 /
// unlimited). The unit is restored here to match it. Limits, prices and keys are unchanged --
// entitlements are ratified and altering them is a central-PM decision, not a display fix.
const PLAN_INFO: Record<string, { price: number; features: string[]; limits: { ai_usage: number; minutes: number } }> = {
  starter: { price: 39, features: ['AI Agent', 'WhatsApp inbox', '500 AI turns/mo', '100 mins/mo'], limits: { ai_usage: 500, minutes: 100 } },
  growth:  { price: 89, features: ['2,000 AI turns/mo', '500 mins/mo', 'CRM integration'], limits: { ai_usage: 2000, minutes: 500 } },
  pro:     { price: 179, features: ['Unlimited AI turns', '2,000 mins/mo', 'Priority support'], limits: { ai_usage: -1, minutes: 2000 } },
};

function UsageBar({ used, limit, label, unit }: { used: number; limit: number; label: string; unit: string }) {
  const pct = limit <= 0 ? 0 : Math.min(100, (used / limit) * 100);
  const warn = pct > 80;
  return (
    <div className="mb-4">
      <div className="flex justify-between mb-1.5 text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className={cn(warn ? 'text-warning font-medium' : 'text-foreground')}>
          {used.toLocaleString()} / {limit < 0 ? '∞' : limit.toLocaleString()} {unit}
        </span>
      </div>
      <div className="h-1.5 rounded-full bg-muted overflow-hidden">
        {limit > 0 && (
          <div
            className={cn(
              'h-full rounded-full transition-[width] duration-400',
              warn ? 'bg-warning' : 'bg-primary'
            )}
            style={{ width: `${pct}%` }}
          />
        )}
      </div>
    </div>
  );
}

export default async function PlanPage() {
  const session = await getSession();
  if (!session) redirect('/');
  const tenantId = session.effectiveTenantId;

  const [subscription, usage, tenant] = await Promise.all([
    prisma.subscription.findUnique({ where: { tenant_id: tenantId } }),
    getCurrentUsage(tenantId),
    prisma.tenant.findUnique({ where: { id: tenantId } }),
  ]);

  const currentPlan = subscription?.plan ?? tenant?.plan ?? 'starter';
  const planInfo = PLAN_INFO[currentPlan] ?? PLAN_INFO['starter'];

  return (
    <>
      <div className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight">Plan & Usage</h1>
        <p className="text-muted-foreground text-sm mt-1">Current subscription and this month's consumption.</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8">
        {/* Current plan card */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Current plan</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-3 mb-3">
              <span className="text-3xl font-extrabold tracking-tight">
                {currentPlan.charAt(0).toUpperCase() + currentPlan.slice(1)}
              </span>
              <Badge variant={subscription?.status === 'active' ? 'default' : 'destructive'}>
                {subscription?.status ?? 'active'}
              </Badge>
            </div>
            <div className="text-2xl font-bold mb-4">
              EC${planInfo.price}
              <span className="text-sm text-muted-foreground font-normal">/month</span>
            </div>
            <ul className="space-y-1.5">
              {planInfo.features.map((f) => (
                <li key={f} className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Check className="h-3.5 w-3.5 text-primary shrink-0" />
                  {f}
                </li>
              ))}
            </ul>
            <p className="mt-4 text-xs text-muted-foreground">To upgrade, contact your EPIC operator.</p>
          </CardContent>
        </Card>

        {/* This month's costs */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">This month's costs</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-4xl font-extrabold tracking-tight mb-1">
              US${((usage?.tokens_cost ?? 0) + (usage?.minutes_cost ?? 0)).toFixed(2)}
            </div>
            <p className="text-xs text-muted-foreground mb-6">
              AI usage US${(usage?.tokens_cost ?? 0).toFixed(2)} + Calls US${(usage?.minutes_cost ?? 0).toFixed(2)}
            </p>
            {/*
              F3: no progress bar is rendered for AI usage, because none can be drawn honestly.
              The entitlement is denominated in AI TURNS (lib/plans.ts), but UsageMeter records
              only `tokens_used` (Int, raw tokens -- prisma/schema.prisma). There is no turn
              counter in the data model and no ratified turns-to-tokens conversion, so the
              previous `tokens_used / 800` was an invented constant that produced a fabricated
              percentage against an incompatible limit.
              Both real facts are shown instead: the allowance in its ratified unit, and the
              metered consumption in the unit actually recorded. Introducing a conversion, or a
              turn counter, is a separate packet -- not a display fix.
            */}
            <div className="mb-4">
              <div className="flex justify-between mb-1.5 text-xs">
                <span className="text-muted-foreground">AI turns included</span>
                <span className="text-foreground">
                  {planInfo.limits.ai_usage < 0 ? '∞' : planInfo.limits.ai_usage.toLocaleString()} turns/mo
                </span>
              </div>
              <div className="flex justify-between mb-1.5 text-xs">
                <span className="text-muted-foreground">AI tokens metered this month</span>
                <span className="text-foreground">{(usage?.tokens_used ?? 0).toLocaleString()} tokens</span>
              </div>
              <p className="text-[11px] text-muted-foreground">
                Turn-level consumption isn’t metered yet, so progress against your turn allowance can’t be shown.
              </p>
            </div>
            <UsageBar
              label="Call minutes"
              used={Math.round(usage?.minutes_used ?? 0)}
              limit={planInfo.limits.minutes}
              unit="mins"
            />
          </CardContent>
        </Card>
      </div>

      {/* Plan comparison */}
      <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-4">Available plans</h2>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-5">
        {Object.entries(PLAN_INFO).map(([key, info]) => (
          <Card
            key={key}
            className={cn(
              'relative',
              key === currentPlan ? 'border-primary ring-1 ring-primary' : ''
            )}
          >
            <CardHeader className="pb-3">
              {key === currentPlan && (
                <Badge className="mb-2 w-fit">Current plan</Badge>
              )}
              <CardTitle className="capitalize text-base">{key}</CardTitle>
              <div className="text-2xl font-extrabold tracking-tight">
                EC${info.price}
                <span className="text-sm text-muted-foreground font-normal">/mo</span>
              </div>
            </CardHeader>
            <CardContent>
              <ul className="space-y-1.5">
                {info.features.map((f) => (
                  <li key={f} className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Check className="h-3 w-3 text-primary shrink-0" />
                    {f}
                  </li>
                ))}
              </ul>
              {key !== currentPlan && (
                <p className="mt-4 text-xs text-muted-foreground">Contact EPIC operator to upgrade.</p>
              )}
            </CardContent>
          </Card>
        ))}
      </div>
    </>
  );
}
