'use client';

import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export interface UsagePoint {
  month: string;
  tokens: number;
  minutes: number;
}

function EmptyChart({ label }: { label: string }) {
  return (
    <div className="flex h-[220px] flex-col items-center justify-center gap-1 text-center text-sm text-muted-foreground">
      <span>Not enough history yet to chart {label}.</span>
      <span className="text-xs">Check back after another billing period.</span>
    </div>
  );
}

export function UsageChart({ data }: { data: UsagePoint[] }) {
  const hasHistory = data.length > 1;

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">AI usage (tokens) over time</CardTitle>
        </CardHeader>
        <CardContent>
          {hasHistory ? (
            <ResponsiveContainer width="100%" height={220}>
              <AreaChart data={data} margin={{ left: -20, right: 8, top: 8 }}>
                <defs>
                  {/* Fix: --primary already contains a full hsl(...) expression (see
                      app/globals.css), so wrapping it again in hsl(var(--primary)) produced
                      an invalid nested color and rendered as black/transparent. Use the
                      token directly. */}
                  <linearGradient id="tokensFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="var(--primary)" stopOpacity={0.35} />
                    <stop offset="95%" stopColor="var(--primary)" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--border)" />
                <XAxis dataKey="month" tick={{ fontSize: 11 }} tickLine={false} axisLine={false} />
                <YAxis tick={{ fontSize: 11 }} tickLine={false} axisLine={false} width={40} />
                <Tooltip
                  contentStyle={{
                    background: 'var(--popover)',
                    border: '1px solid var(--border)',
                    borderRadius: 8,
                    fontSize: 12,
                  }}
                />
                <Area type="monotone" dataKey="tokens" stroke="var(--primary)" fill="url(#tokensFill)" strokeWidth={2} />
              </AreaChart>
            </ResponsiveContainer>
          ) : (
            <EmptyChart label="AI usage" />
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">Call minutes over time</CardTitle>
        </CardHeader>
        <CardContent>
          {hasHistory ? (
            <ResponsiveContainer width="100%" height={220}>
              <AreaChart data={data} margin={{ left: -20, right: 8, top: 8 }}>
                <defs>
                  <linearGradient id="minutesFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="var(--chart-2)" stopOpacity={0.35} />
                    <stop offset="95%" stopColor="var(--chart-2)" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--border)" />
                <XAxis dataKey="month" tick={{ fontSize: 11 }} tickLine={false} axisLine={false} />
                <YAxis tick={{ fontSize: 11 }} tickLine={false} axisLine={false} width={40} />
                <Tooltip
                  contentStyle={{
                    background: 'var(--popover)',
                    border: '1px solid var(--border)',
                    borderRadius: 8,
                    fontSize: 12,
                  }}
                />
                <Area type="monotone" dataKey="minutes" stroke="var(--chart-2)" fill="url(#minutesFill)" strokeWidth={2} />
              </AreaChart>
            </ResponsiveContainer>
          ) : (
            <EmptyChart label="call minutes" />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
