'use client';

import Link from 'next/link';
import { ArrowLeft, ArrowRight, MessageCircle, ShieldCheck } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { ReadinessBadge } from '@/components/foh/readiness';
import { OnboardingProgress } from '../../_components/onboarding-progress';
import { CHANNELS } from '../../_lib/mock-data';

const OTHER_CHANNELS = CHANNELS.filter((c) => c.id !== 'whatsapp');

export default function ConnectChannelPage() {
  return (
    <div className="mx-auto max-w-2xl">
      <OnboardingProgress current={2} />

      <div className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight">Connect a channel</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          A visual mock of the real WhatsApp connect step (the actual flow lives at{' '}
          <code className="rounded bg-muted px-1 py-0.5">/onboard</code>).
        </p>
      </div>

      <Card>
        <CardHeader className="pb-4">
          <CardTitle className="flex items-center gap-2 text-base">
            <MessageCircle className="size-4 text-primary" /> Connect WhatsApp
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-2">
            <Badge>Recommended</Badge>
            <span className="text-sm text-muted-foreground">Meta Embedded Signup — fastest, no token handling.</span>
          </div>
          <Button className="w-full" size="lg">
            <ShieldCheck className="size-4" /> Continue with Meta (mock)
          </Button>
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <div className="h-px flex-1 bg-border" /> or enter manually <div className="h-px flex-1 bg-border" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="wa-token">WhatsApp access token</Label>
            <Input id="wa-token" placeholder="EAAG..." disabled />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="wa-phone-id">Phone number ID</Label>
            <Input id="wa-phone-id" placeholder="109xxxxxxxxxxxx" disabled />
          </div>
        </CardContent>
      </Card>

      <div className="mt-6">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Other channels
        </h2>
        <div className="flex flex-col gap-3">
          {OTHER_CHANNELS.map((ch) => (
            <div key={ch.id} className="flex items-center justify-between rounded-lg border p-3.5">
              <div>
                <div className="text-sm font-semibold">{ch.kind}</div>
                <div className="text-xs text-muted-foreground">{ch.detail}</div>
              </div>
              <ReadinessBadge state={ch.status} />
            </div>
          ))}
        </div>
      </div>

      <div className="mt-6 flex justify-between">
        <Button asChild variant="outline" size="lg">
          <Link href="/preview/onboarding/choose-agent">
            <ArrowLeft className="size-4" /> Back
          </Link>
        </Button>
        <Button asChild size="lg">
          <Link href="/preview/onboarding/provisioning">
            Next <ArrowRight className="size-4" />
          </Link>
        </Button>
      </div>
    </div>
  );
}
