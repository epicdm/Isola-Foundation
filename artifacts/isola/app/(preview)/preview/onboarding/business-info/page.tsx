'use client';

import { useState } from 'react';
import Link from 'next/link';
import { ArrowRight, Building2 } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { OnboardingProgress } from '../../_components/onboarding-progress';
import { TENANT } from '../../_lib/mock-data';

export default function BusinessInfoPage() {
  const [form, setForm] = useState({
    name: TENANT.name,
    industry: TENANT.industry,
    hours: TENANT.hours,
    address: TENANT.address,
  });

  function set(key: keyof typeof form) {
    return (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      setForm((f) => ({ ...f, [key]: e.target.value }));
  }

  return (
    <div className="mx-auto max-w-2xl">
      <OnboardingProgress current={0} />

      <div className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight">Tell us about your business</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          This becomes the business context every AI employee draws on. (mock — inputs are not saved)
        </p>
      </div>

      <Card>
        <CardHeader className="pb-4">
          <CardTitle className="flex items-center gap-2 text-base">
            <Building2 className="size-4 text-primary" /> Business profile
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="biz-name">Business name</Label>
            <Input id="biz-name" value={form.name} onChange={set('name')} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="biz-industry">Industry</Label>
            <Input id="biz-industry" value={form.industry} onChange={set('industry')} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="biz-hours">Hours of operation</Label>
            <Input id="biz-hours" value={form.hours} onChange={set('hours')} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="biz-address">Address</Label>
            <Textarea id="biz-address" value={form.address} onChange={set('address')} className="min-h-[70px]" />
          </div>
        </CardContent>
      </Card>

      <div className="mt-6 flex justify-end">
        <Button asChild size="lg">
          <Link href="/preview/onboarding/choose-agent">
            Next <ArrowRight className="size-4" />
          </Link>
        </Button>
      </div>
    </div>
  );
}
