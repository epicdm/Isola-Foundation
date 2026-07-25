'use client';

import { useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, ArrowRight, Check, Sparkles } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { OnboardingProgress } from '../../_components/onboarding-progress';
import { AGENT_TEMPLATES } from '../../_lib/mock-data';

export default function ChooseAgentPage() {
  const [hired, setHired] = useState<string | null>(AGENT_TEMPLATES[0].id);

  return (
    <div className="mx-auto max-w-4xl">
      <OnboardingProgress current={1} />

      <div className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight">Hire your first AI employee</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Pick a template to start from — you can fully customize it afterward, and hire more later.
        </p>
      </div>

      <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
        {AGENT_TEMPLATES.map((tpl) => {
          const isHired = hired === tpl.id;
          return (
            <Card key={tpl.id} className={isHired ? 'border-primary ring-1 ring-primary' : ''}>
              <CardHeader className="pb-3">
                <div className="mb-1 flex items-center justify-between">
                  <Sparkles className="size-5 text-primary" />
                  {isHired && <Badge className="gap-1"><Check className="size-3" /> Hired</Badge>}
                </div>
                <CardTitle className="text-base">{tpl.name}</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground">{tpl.blurb}</p>
                <p className="mt-2 text-xs text-muted-foreground">
                  <span className="font-semibold text-foreground">Best for: </span>
                  {tpl.bestFor}
                </p>
                <Button
                  className="mt-4 w-full"
                  variant={isHired ? 'secondary' : 'default'}
                  onClick={() => setHired(tpl.id)}
                >
                  {isHired ? 'Hired' : 'Hire this employee'}
                </Button>
              </CardContent>
            </Card>
          );
        })}
      </div>

      <p className="mt-6 text-xs text-muted-foreground">
        This maps to a real Clawith agent once created — hiring here is a mock selection only.
      </p>

      <div className="mt-6 flex justify-between">
        <Button asChild variant="outline" size="lg">
          <Link href="/preview/onboarding/business-info">
            <ArrowLeft className="size-4" /> Back
          </Link>
        </Button>
        <Button asChild size="lg">
          <Link href="/preview/onboarding/connect-channel">
            Next <ArrowRight className="size-4" />
          </Link>
        </Button>
      </div>
    </div>
  );
}
