/**
 * Root page — smart redirect hub.
 *
 * Unauthenticated  → landing page (login CTA)
 * Authenticated + no DB user → /api/provision (first-time setup)
 * Owner → /dashboard
 * Admin → /admin
 */

import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';
import { resolveWorkspaceAuthz } from '@/lib/workspace/authz';
import { getAuthUser } from '@/lib/auth';
import { cookies } from 'next/headers';
import { MessageCircle, ClipboardCheck, Wrench, ArrowRight } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';

export default async function RootPage() {
  // Check if we have a Replit auth session at all
  const cookieStore = await cookies();
  const cookieHeader = cookieStore.getAll().map((c) => `${c.name}=${c.value}`).join('; ');
  const authUser = await getAuthUser({ Cookie: cookieHeader });

  if (!authUser?.id) {
    // Not logged in — show landing
    return <LandingPage />;
  }

  // Logged in — check if provisioned in our DB
  const session = await getSession();
  if (!session) {
    // Auth but no DB record → provision
    redirect('/api/provision');
  }

  // Realm selection on the customer-facing entry point.
  //
  // Being a platform administrator must NOT, on its own, send someone to the
  // operator console: the same human can hold both platform authority and a
  // tenant Membership, and arriving here is a customer-facing entry. Prefer the
  // tenant workspace whenever the user actually has workspace access, and fall
  // back to the operator console only when they have none. The console stays
  // explicitly reachable at /admin and from the switch in the workspace sidebar
  // (defect-isola-owner-login-lands-saas-operator-2026-07-25).
  const workspaceAuthz = await resolveWorkspaceAuthz(session);
  if (workspaceAuthz.level !== 'denied') redirect('/dashboard');
  if (session.isAdmin) redirect('/admin');
  redirect('/dashboard');
}

// Founding-pilot WhatsApp entry point — same number already used by the
// EMA consumer funnel (app/ema/page.tsx, app/consumer/landing/page.tsx);
// the prefilled text is what distinguishes a business pilot inquiry from a
// personal Dominica-number request once it lands with the sales agent.
const APPLY_URL =
  'https://wa.me/17678180001?text=' +
  encodeURIComponent("Hi, I'd like to apply for the founding pilot for my business.");

const HOW_IT_WORKS = [
  {
    icon: MessageCircle,
    title: 'Apply on WhatsApp',
    desc: 'Tell us about your business. A person on our team reviews every application.',
  },
  {
    icon: Wrench,
    title: 'We build it with you',
    desc: 'Our team sets up and trains your WhatsApp concierge on your business — nothing to self-configure.',
  },
  {
    icon: ClipboardCheck,
    title: 'Go live, managed',
    desc: 'We launch the pilot alongside you and stay hands-on for support and tuning.',
  },
];

// The three ratified founding-pilot offers. Prices must stay in sync with
// the approved Claim Register enforced by lib/claim-guard.ts — do not add
// or change a figure here without updating RATIFIED_EC_AMOUNTS there too.
const OFFERS = [
  {
    name: 'Managed SBL',
    setup: 'EC$750 setup',
    setupNote: 'billed as two EC$375 installments — before work, then on acceptance',
    monthly: 'EC$249/mo',
    desc: 'A fully managed WhatsApp Business Line, set up and supported by our team end to end.',
    // Founding promo (dec-sbl-founding-price-value-and-promo-2026-07-22): half
    // off setup + the first 3 months, capped at the first 3 founding
    // customers — never advertise this as "limited time".
    promo: {
      badge: 'Founding promo — first 3 customers',
      setup: 'EC$375 setup',
      setupNote: 'billed as two EC$187.50 installments — before work, then on acceptance',
      monthly: 'EC$124.50/mo for months 1–3',
      monthlyNote: 'then EC$249/mo from month 4',
    },
  },
  {
    name: 'WA-Receptionist',
    setup: 'EC$250 setup',
    monthly: 'EC$149/mo',
    desc: 'A trained WhatsApp concierge that greets your customers and routes them to the right place.',
  },
  {
    name: 'PBX-Upgrade',
    setup: 'EC$250 setup',
    monthly: 'EC$99/mo',
    desc: "A managed upgrade to your business's existing phone system.",
  },
];

function LandingPage() {
  return (
    <main className="flex min-h-screen flex-col bg-background text-foreground">
      {/* Nav */}
      <nav className="flex items-center justify-between border-b px-6 py-5 sm:px-10">
        <div className="flex items-center gap-2.5">
          <div className="flex size-8 items-center justify-center rounded-lg bg-primary">
            <span className="text-sm font-extrabold text-primary-foreground">I</span>
          </div>
          <span className="text-lg font-bold tracking-tight">Isola</span>
        </div>
        <Button asChild size="sm">
          <a href="/auth/login?returnTo=/">Sign in with Replit</a>
        </Button>
      </nav>

      {/* Hero */}
      <section className="flex flex-1 flex-col items-center justify-center px-6 py-20 text-center">
        <div className="max-w-2xl">
          <Badge variant="secondary" className="mb-6">
            Founding pilot · by application
          </Badge>
          <h1 className="mb-6 text-4xl font-extrabold leading-[1.05] tracking-tighter sm:text-6xl">
            A WhatsApp concierge for your business
            <br />
            <span className="text-primary">built and run by our team</span>
          </h1>
          <p className="mx-auto mb-10 max-w-lg text-lg leading-relaxed text-muted-foreground">
            Isola's founding pilots are hands-on, not self-serve. We set it up, train it on your
            business, and manage it with you — starting with a short application on WhatsApp.
          </p>
          <div className="flex flex-wrap justify-center gap-3">
            <Button asChild size="lg">
              <a href={APPLY_URL} target="_blank" rel="noopener noreferrer">
                Apply for a founding pilot <ArrowRight className="size-4" />
              </a>
            </Button>
          </div>
        </div>
      </section>

      {/* How it works */}
      <section className="mx-auto w-full max-w-5xl border-t px-6 py-16 sm:px-10">
        <div className="grid gap-6 sm:grid-cols-3">
          {HOW_IT_WORKS.map((f) => (
            <Card key={f.title} className="p-6">
              <f.icon className="mb-3 size-7 text-primary" />
              <div className="mb-1.5 text-[15px] font-bold">{f.title}</div>
              <div className="text-[13px] leading-relaxed text-muted-foreground">{f.desc}</div>
            </Card>
          ))}
        </div>
      </section>

      {/* Offers */}
      <section className="mx-auto w-full max-w-5xl border-t px-6 py-16 sm:px-10">
        <h2 className="mb-8 text-center text-2xl font-bold tracking-tight sm:text-3xl">
          Founding pilot offers
        </h2>
        <div className="grid gap-6 sm:grid-cols-3">
          {OFFERS.map((o) => (
            <Card key={o.name} className="flex flex-col p-6">
              <div className="mb-1 text-base font-bold">{o.name}</div>
              {o.promo && (
                <Badge variant="secondary" className="mb-2 w-fit text-[11px]">
                  {o.promo.badge}
                </Badge>
              )}
              <div className="mb-1 text-2xl font-extrabold tracking-tight">
                {o.promo ? o.promo.monthly : o.monthly}
              </div>
              {o.promo && (
                <div className="mb-1 text-[12px] text-muted-foreground">
                  {o.promo.monthlyNote} · regular {o.monthly}
                </div>
              )}
              <div className="mb-1 text-[13px] font-medium text-muted-foreground">
                {o.promo ? o.promo.setup : o.setup}
              </div>
              {(o.promo ? o.promo.setupNote : o.setupNote) && (
                <div className="mb-3 text-[12px] leading-relaxed text-muted-foreground">
                  {o.promo ? o.promo.setupNote : o.setupNote}
                  {o.promo && <> · regular {o.setup}</>}
                </div>
              )}
              <p className="mb-4 flex-1 text-[13px] leading-relaxed text-muted-foreground">{o.desc}</p>
              <Button asChild variant="outline" size="sm">
                <a href={APPLY_URL} target="_blank" rel="noopener noreferrer">
                  Apply for a founding pilot
                </a>
              </Button>
            </Card>
          ))}
        </div>
      </section>

      <footer className="border-t px-6 py-6 text-center text-xs text-muted-foreground sm:px-10">
        © 2026 EPIC · Powered by Isola
      </footer>
    </main>
  );
}
