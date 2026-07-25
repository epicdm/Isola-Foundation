import Link from 'next/link';
import { ArrowRight, LayoutGrid, Sparkles } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { TENANT } from './_lib/mock-data';

export const metadata = { title: 'Owner Visual Review' };

export default function PreviewIndexPage() {
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-8">
      <div>
        <Badge variant="secondary" className="mb-3">
          Owner visual review
        </Badge>
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Isola preview — {TENANT.name}</h1>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          A click-through design preview of screens proposed for the control plane and onboarding, built with mock
          data so it renders without a live tenant. Nothing here is wired to a real backend — use the picks below,
          or the sidebar, to explore.
        </p>
      </div>

      <div className="grid gap-5 sm:grid-cols-2">
        <Link href="/preview/onboarding/business-info" className="group">
          <Card className="h-full transition-colors group-hover:border-primary">
            <CardHeader>
              <Sparkles className="mb-2 size-6 text-primary" />
              <CardTitle className="text-lg">Start onboarding preview</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">
                Walk through business info, choosing an AI employee, connecting a channel, provisioning, and the
                first-use success screen — the proposed pre-home journey.
              </p>
              <div className="mt-4 flex items-center gap-1.5 text-sm font-semibold text-primary">
                Begin <ArrowRight className="size-4" />
              </div>
            </CardContent>
          </Card>
        </Link>

        <Link href="/preview/control-plane/home" className="group">
          <Card className="h-full transition-colors group-hover:border-primary">
            <CardHeader>
              <LayoutGrid className="mb-2 size-6 text-primary" />
              <CardTitle className="text-lg">Go to control plane</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">
                Home, AI Team, Channels, Integrations, Conversations, Billing, Team, Support, Activity, and Settings
                — the day-to-day owner surface once a tenant is live.
              </p>
              <div className="mt-4 flex items-center gap-1.5 text-sm font-semibold text-primary">
                Enter <ArrowRight className="size-4" />
              </div>
            </CardContent>
          </Card>
        </Link>
      </div>

      <p className="text-xs text-muted-foreground">
        This whole section lives under <code className="rounded bg-muted px-1 py-0.5">/preview</code> so it never
        collides with the real app's routes. Every page carries a persistent preview banner.
      </p>
    </div>
  );
}
