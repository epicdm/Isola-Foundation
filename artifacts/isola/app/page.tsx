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
import { getAuthUser } from '@/lib/auth';
import { cookies } from 'next/headers';
import { Bot, MessageCircle, LayoutDashboard, Check, ArrowRight } from 'lucide-react';
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

  if (session.isAdmin) redirect('/admin');
  redirect('/dashboard');
}

const FEATURES = [
  {
    icon: Bot,
    title: 'AI agent, your voice',
    desc: 'Train the agent with your business info and knowledge base. It handles WhatsApp 24/7.',
  },
  {
    icon: MessageCircle,
    title: 'WhatsApp native',
    desc: 'Connect via Meta Embedded Signup in minutes. Coexistence mode — keep using the WA Business app.',
  },
  {
    icon: LayoutDashboard,
    title: 'Full operator view',
    desc: 'EPIC operators manage all tenants from one admin panel, adjust credits, and act as any tenant.',
  },
];

const PLANS = [
  { name: 'Starter', price: 39, features: ['AI Agent', '500 AI turns/mo', '100 call mins/mo', 'WhatsApp inbox'] },
  {
    name: 'Growth',
    price: 89,
    features: ['2 000 AI turns/mo', '500 call mins/mo', 'CRM integration', 'Priority queue'],
    highlight: true,
  },
  { name: 'Pro', price: 179, features: ['Unlimited AI turns', '2 000 call mins/mo', 'Multi-agent', 'Dedicated support'] },
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
            Multi-tenant AI business platform
          </Badge>
          <h1 className="mb-6 text-4xl font-extrabold leading-[1.05] tracking-tighter sm:text-6xl">
            WhatsApp AI that
            <br />
            <span className="text-primary">actually converts</span>
          </h1>
          <p className="mx-auto mb-10 max-w-lg text-lg leading-relaxed text-muted-foreground">
            Isola gives every business on your network an AI agent trained on their knowledge
            base — deployed on WhatsApp in minutes.
          </p>
          <div className="flex flex-wrap justify-center gap-3">
            <Button asChild size="lg">
              <a href="/auth/login?returnTo=/api/provision">
                Get started free <ArrowRight className="size-4" />
              </a>
            </Button>
          </div>
        </div>
      </section>

      {/* Features */}
      <section className="mx-auto w-full max-w-5xl border-t px-6 py-16 sm:px-10">
        <div className="grid gap-6 sm:grid-cols-3">
          {FEATURES.map((f) => (
            <Card key={f.title} className="p-6">
              <f.icon className="mb-3 size-7 text-primary" />
              <div className="mb-1.5 text-[15px] font-bold">{f.title}</div>
              <div className="text-[13px] leading-relaxed text-muted-foreground">{f.desc}</div>
            </Card>
          ))}
        </div>
      </section>

      {/* Plans */}
      <section className="mx-auto w-full max-w-5xl border-t px-6 py-16 sm:px-10">
        <h2 className="mb-8 text-center text-2xl font-bold tracking-tight sm:text-3xl">
          Transparent pricing
        </h2>
        <div className="grid gap-6 sm:grid-cols-3">
          {PLANS.map((p) => (
            <Card
              key={p.name}
              className={`relative p-6 ${p.highlight ? 'border-primary shadow-[0_0_0_1px_hsl(var(--primary))]' : ''}`}
            >
              {p.highlight && (
                <Badge className="absolute -top-2.5 left-5" variant="secondary">
                  Most popular
                </Badge>
              )}
              <div className="mb-1 text-base font-bold">{p.name}</div>
              <div className="mb-4 text-3xl font-extrabold tracking-tight">
                EC${p.price}
                <span className="text-[13px] font-medium text-muted-foreground">/mo</span>
              </div>
              <ul className="flex flex-col gap-2">
                {p.features.map((f) => (
                  <li key={f} className="flex items-center gap-2 text-[13px] text-muted-foreground">
                    <Check className="size-3.5 text-primary" /> {f}
                  </li>
                ))}
              </ul>
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
