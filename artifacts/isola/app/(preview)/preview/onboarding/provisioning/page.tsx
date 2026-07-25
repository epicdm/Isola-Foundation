'use client';

import Link from 'next/link';
import { ArrowLeft, ArrowRight, Bot, Check, Loader2, MessageCircle, Phone } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { OnboardingProgress } from '../../_components/onboarding-progress';

const CHECKLIST = [
  { icon: Phone, label: 'WhatsApp number connected', state: 'complete' as const },
  { icon: Bot, label: 'AI employee configured', state: 'complete' as const },
  { icon: Check, label: 'Webhook verified', state: 'complete' as const },
  { icon: MessageCircle, label: 'First test message sent', state: 'pending' as const },
];

export default function ProvisioningPage() {
  return (
    <div className="mx-auto max-w-2xl">
      <OnboardingProgress current={3} />

      <div className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight">Setting things up</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Governed provisioning runs these steps in order. This is a mock — no real webhook or agent is being
          created.
        </p>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Provisioning checklist</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="flex flex-col gap-1">
            {CHECKLIST.map((item) => (
              <li key={item.label} className="flex items-center gap-3 rounded-lg p-3">
                <div
                  className={
                    item.state === 'complete'
                      ? 'flex size-8 shrink-0 items-center justify-center rounded-full bg-success/10 text-success'
                      : 'flex size-8 shrink-0 items-center justify-center rounded-full bg-warning/10 text-warning'
                  }
                >
                  {item.state === 'complete' ? <Check className="size-4" /> : <Loader2 className="size-4 animate-spin" />}
                </div>
                <div className="flex-1">
                  <div className="text-sm font-medium">{item.label}</div>
                </div>
                <item.icon className="size-4 text-muted-foreground" />
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      <div className="mt-6 flex justify-between">
        <Button asChild variant="outline" size="lg">
          <Link href="/preview/onboarding/connect-channel">
            <ArrowLeft className="size-4" /> Back
          </Link>
        </Button>
        <Button asChild size="lg">
          <Link href="/preview/onboarding/first-use">
            Next <ArrowRight className="size-4" />
          </Link>
        </Button>
      </div>
    </div>
  );
}
