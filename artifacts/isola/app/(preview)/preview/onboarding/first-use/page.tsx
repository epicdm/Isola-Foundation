import Link from 'next/link';
import { ArrowRight, Bot, CheckCircle2, Inbox, LayoutGrid, Phone } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { OnboardingProgress } from '../../_components/onboarding-progress';
import { TENANT } from '../../_lib/mock-data';

const NEXT_STEPS = [
  { href: '/preview/control-plane/home', label: 'Go to your dashboard', icon: LayoutGrid },
  { href: '/preview/control-plane/ai-team', label: 'Review your AI Team', icon: Bot },
  { href: '/preview/control-plane/channels', label: 'Check connected channels', icon: Phone },
  { href: '/preview/control-plane/conversations', label: 'See conversations', icon: Inbox },
];

export default function FirstUsePage() {
  return (
    <div className="mx-auto max-w-2xl text-center">
      <OnboardingProgress current={4} />

      <div className="flex flex-col items-center gap-3 py-6">
        <div className="flex size-16 items-center justify-center rounded-full bg-success/10 text-success">
          <CheckCircle2 className="size-9" />
        </div>
        <h1 className="text-2xl font-bold tracking-tight">You&apos;re ready to go!</h1>
        <p className="max-w-md text-sm text-muted-foreground">
          {TENANT.name} is set up with a connected WhatsApp number and an active AI employee. Your first customer
          message can arrive any time.
        </p>
      </div>

      <div className="grid gap-3 text-left sm:grid-cols-2">
        {NEXT_STEPS.map((step) => (
          <Link key={step.href} href={step.href} className="group">
            <Card className="h-full transition-colors group-hover:border-primary">
              <CardContent className="flex items-center gap-3 p-4">
                <step.icon className="size-5 shrink-0 text-primary" />
                <span className="flex-1 text-sm font-medium">{step.label}</span>
                <ArrowRight className="size-4 shrink-0 text-muted-foreground" />
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>

      <div className="mt-8">
        <Button asChild size="lg">
          <Link href="/preview/control-plane/home">
            Enter the control plane <ArrowRight className="size-4" />
          </Link>
        </Button>
      </div>
    </div>
  );
}
