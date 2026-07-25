'use client';

import { Check, Wallet } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import { KPIS } from '../../_lib/mock-data';
import { useMockCta } from '../../_lib/use-mock-cta';
import { MockCtaStatus } from '../../_components/mock-cta-status';

const PLAN_INFO: Record<string, { price: number; features: string[]; limits: { ai_turns: number; minutes: number } }> = {
  starter: { price: 39, features: ['AI Agent', 'WhatsApp inbox', '500 AI turns/mo', '100 mins/mo'], limits: { ai_turns: 500, minutes: 100 } },
  growth: { price: 89, features: ['2,000 AI turns/mo', '500 mins/mo', 'CRM integration'], limits: { ai_turns: 2000, minutes: 500 } },
  pro: { price: 179, features: ['Unlimited AI turns', '2,000 mins/mo', 'Priority support'], limits: { ai_turns: -1, minutes: 2000 } },
};

const CURRENT_PLAN = 'growth';
const USED_TURNS = 1240;
const USED_MINUTES = 310;

function UsageBar({ used, limit, label, unit }: { used: number; limit: number; label: string; unit: string }) {
  const pct = limit <= 0 ? 0 : Math.min(100, (used / limit) * 100);
  const warn = pct > 80;
  return (
    <div className="mb-4">
      <div className="mb-1.5 flex justify-between text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className={cn(warn ? 'font-medium text-warning' : 'text-foreground')}>
          {used.toLocaleString()} / {limit < 0 ? '∞' : limit.toLocaleString()} {unit}
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
        {limit > 0 && (
          <div
            className={cn('h-full rounded-full transition-[width] duration-400', warn ? 'bg-warning' : 'bg-primary')}
            style={{ width: `${pct}%` }}
          />
        )}
      </div>
    </div>
  );
}

export default function BillingPage() {
  const planInfo = PLAN_INFO[CURRENT_PLAN];
  const topup = useMockCta('Payment received — wallet updated.');

  return (
    <div className="flex flex-col gap-8">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Plan &amp; Billing</h1>
        <p className="mt-1 text-sm text-muted-foreground">Subscription, usage, and wallet in one place.</p>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Current plan</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="mb-3 flex items-center gap-3">
              <span className="text-3xl font-extrabold tracking-tight capitalize">{CURRENT_PLAN}</span>
              <Badge>Active</Badge>
            </div>
            <div className="mb-4 text-2xl font-bold">
              EC${planInfo.price}
              <span className="text-sm font-normal text-muted-foreground">/month</span>
            </div>
            <ul className="space-y-1.5">
              {planInfo.features.map((f) => (
                <li key={f} className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Check className="size-3.5 shrink-0 text-primary" /> {f}
                </li>
              ))}
            </ul>
            <p className="mt-4 text-xs text-muted-foreground">To upgrade, contact your EPIC operator.</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">This month&apos;s usage</CardTitle>
          </CardHeader>
          <CardContent>
            <UsageBar label="AI turns" used={USED_TURNS} limit={planInfo.limits.ai_turns} unit="turns" />
            <UsageBar label="Call minutes" used={USED_MINUTES} limit={planInfo.limits.minutes} unit="mins" />
          </CardContent>
        </Card>
      </div>

      <div>
        <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-muted-foreground">Available plans</h2>
        <div className="grid gap-5 sm:grid-cols-3">
          {Object.entries(PLAN_INFO).map(([key, info]) => (
            <Card key={key} className={key === CURRENT_PLAN ? 'border-primary ring-1 ring-primary' : ''}>
              <CardHeader className="pb-3">
                {key === CURRENT_PLAN && <Badge className="mb-2 w-fit">Current plan</Badge>}
                <CardTitle className="text-base capitalize">{key}</CardTitle>
                <div className="text-2xl font-extrabold tracking-tight">
                  EC${info.price}
                  <span className="text-sm font-normal text-muted-foreground">/mo</span>
                </div>
              </CardHeader>
              <CardContent>
                <ul className="space-y-1.5">
                  {info.features.map((f) => (
                    <li key={f} className="flex items-center gap-2 text-xs text-muted-foreground">
                      <Check className="size-3 shrink-0 text-primary" /> {f}
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>

      <Card className="max-w-lg">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Wallet className="size-4 text-primary" /> Wallet
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="mb-4 text-3xl font-extrabold tracking-tight">EC${KPIS.walletBalance.toFixed(2)}</div>
          <div className="space-y-1.5">
            <Label htmlFor="topup-amount">Top up amount (EC$)</Label>
            <Input id="topup-amount" placeholder="50.00" defaultValue="50.00" />
          </div>
          <Button
            className="mt-3 w-full"
            disabled={topup.state.phase === 'loading'}
            onClick={() => topup.run()}
          >
            {topup.state.phase === 'loading' ? 'Processing…' : 'Top up wallet (mock)'}
          </Button>
          <MockCtaStatus state={topup.state} />
        </CardContent>
      </Card>
    </div>
  );
}
