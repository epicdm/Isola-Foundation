/**
 * Public EMA marketing/funnel landing page (P6).
 *
 * Public, unauthenticated, mobile-first. Reads UTM/referral params from the
 * URL and threads them through to (a) the funnel-attribution tracker/API and
 * (b) the outbound signup link, so leads stay attributable end to end.
 *
 * Does NOT touch operator/tenant routes, consumer auth internals,
 * provisioning, or the agent pipelines — this is presentation + attribution
 * capture only.
 */

import { Phone, Smartphone, Wallet, PhoneCall, Check } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { EmaLandingTracker, type EmaUtmParams } from '@/components/ema/ema-landing-client';
import { EmaCtaButtons } from '@/components/ema/ema-cta-buttons';

const SIGNUP_URL = 'https://ema.epic.dm/consumer/login';
const WHATSAPP_NUMBER = '17678180001';
const LANDING_PATH = '/ema';

const HOW_IT_WORKS = [
  {
    icon: Phone,
    title: 'Get your number',
    desc: 'Sign up and get a real Dominica (1-767) number instantly — yours to keep.',
  },
  {
    icon: Smartphone,
    title: 'Install Acrobits',
    desc: 'Download the free Acrobits Softphone app and sign in with the credentials EMA gives you.',
  },
  {
    icon: Wallet,
    title: 'Top up',
    desc: 'Add credit like a calling card — no contract, no monthly fee. Pay only for what you use.',
  },
  {
    icon: PhoneCall,
    title: 'Call',
    desc: 'Make and receive real calls over WiFi or mobile data, right from your phone.',
  },
];

const FAQ = [
  {
    q: 'How much does it cost?',
    a: 'No monthly fee and no contract — it works like a calling card. You top up credit and pay only for the minutes you use.',
  },
  {
    q: 'What is Acrobits?',
    a: 'Acrobits Softphone is a free app (iOS & Android) that turns your phone into a line for your Dominica number — no SIM or landline required.',
  },
  {
    q: 'How do I top up?',
    a: 'Add credit to your wallet any time from the EMA app after you sign up. Balances never expire.',
  },
];

type SearchParams = Record<string, string | string[] | undefined>;

function first(v: string | string[] | undefined): string | null {
  if (Array.isArray(v)) return v[0] ?? null;
  return v ?? null;
}

export default async function EmaLandingPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await searchParams;

  const utm: EmaUtmParams = {
    utm_source: first(sp.utm_source),
    utm_medium: first(sp.utm_medium),
    utm_campaign: first(sp.utm_campaign),
    utm_term: first(sp.utm_term),
    utm_content: first(sp.utm_content),
  };

  // Carry UTM params through to the signup link so attribution survives the
  // hop to the (separately-owned) consumer auth page.
  const utmQuery = new URLSearchParams(
    Object.entries(utm).filter(([, v]) => v) as [string, string][],
  ).toString();
  const signupUrl = utmQuery ? `${SIGNUP_URL}?${utmQuery}` : SIGNUP_URL;
  const whatsappUrl = `https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent('Hi! I want to get my own Dominica number with EMA.')}`;

  return (
    <main className="flex min-h-screen flex-col bg-background text-foreground">
      <EmaLandingTracker utm={utm} landingPath={LANDING_PATH} />

      {/* Nav */}
      <nav className="flex items-center justify-between px-5 py-5 sm:px-10">
        <div className="flex items-center gap-2.5">
          <div className="flex size-8 items-center justify-center rounded-lg bg-primary">
            <Phone className="size-4 text-primary-foreground" />
          </div>
          <span className="text-lg font-bold tracking-tight">EMA</span>
        </div>
        <Badge variant="secondary" className="hidden sm:inline-flex">
          By EPIC Communications
        </Badge>
      </nav>

      {/* Hero */}
      <section className="flex flex-1 flex-col items-center justify-center px-5 py-14 text-center sm:py-20">
        <div className="max-w-2xl">
          <Badge variant="secondary" className="mb-6">
            A Dominica number, right on your phone
          </Badge>
          <h1 className="mb-6 text-4xl font-extrabold leading-[1.05] tracking-tighter sm:text-6xl">
            Call home
            <br />
            <span className="text-primary">like you never left</span>
          </h1>
          <p className="mx-auto mb-10 max-w-lg text-lg leading-relaxed text-muted-foreground">
            Get your own real <strong>1-767</strong> number on your phone. Call in and out over
            WiFi or data with the free Acrobits app. Top up like a calling card — no monthly fee,
            no contract.
          </p>
          <div className="flex justify-center">
            <EmaCtaButtons signupUrl={signupUrl} whatsappUrl={whatsappUrl} utm={utm} landingPath={LANDING_PATH} />
          </div>
        </div>
      </section>

      {/* How it works */}
      <section className="mx-auto w-full max-w-5xl border-t px-5 py-14 sm:px-10 sm:py-16">
        <h2 className="mb-8 text-center text-2xl font-bold tracking-tight sm:text-3xl">
          How it works
        </h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {HOW_IT_WORKS.map((step, i) => (
            <Card key={step.title} className="relative p-6">
              <span className="absolute right-4 top-4 text-xs font-bold text-muted-foreground">
                0{i + 1}
              </span>
              <step.icon className="mb-3 size-7 text-primary" />
              <div className="mb-1.5 text-[15px] font-bold">{step.title}</div>
              <div className="text-[13px] leading-relaxed text-muted-foreground">{step.desc}</div>
            </Card>
          ))}
        </div>
      </section>

      {/* Value props */}
      <section className="mx-auto w-full max-w-5xl border-t px-5 py-14 sm:px-10 sm:py-16">
        <div className="grid gap-3 sm:grid-cols-2">
          {[
            'No monthly fee or contract — pay only for what you use',
            'Works over WiFi or mobile data — no SIM needed',
            'Real Dominica (1-767) number people can call directly',
            'Set up in minutes, straight from WhatsApp or the signup page',
          ].map((item) => (
            <div key={item} className="flex items-start gap-2.5 text-sm text-muted-foreground">
              <Check className="mt-0.5 size-4 shrink-0 text-primary" />
              {item}
            </div>
          ))}
        </div>
      </section>

      {/* FAQ */}
      <section className="mx-auto w-full max-w-3xl border-t px-5 py-14 sm:px-10 sm:py-16">
        <h2 className="mb-8 text-center text-2xl font-bold tracking-tight sm:text-3xl">
          Questions? Quick answers.
        </h2>
        <div className="flex flex-col gap-4">
          {FAQ.map((item) => (
            <Card key={item.q} className="p-5">
              <div className="mb-1.5 text-[15px] font-bold">{item.q}</div>
              <div className="text-[13px] leading-relaxed text-muted-foreground">{item.a}</div>
            </Card>
          ))}
        </div>
      </section>

      {/* Final CTA */}
      <section className="mx-auto w-full max-w-3xl border-t px-5 py-14 text-center sm:px-10 sm:py-16">
        <h2 className="mb-3 text-2xl font-bold tracking-tight sm:text-3xl">Ready to get your number?</h2>
        <p className="mx-auto mb-8 max-w-md text-sm text-muted-foreground">
          Sign up in about two minutes, or message EMA on WhatsApp with any questions first.
        </p>
        <div className="flex justify-center">
          <EmaCtaButtons signupUrl={signupUrl} whatsappUrl={whatsappUrl} utm={utm} landingPath={LANDING_PATH} />
        </div>
      </section>

      <footer className="border-t px-5 py-6 text-center text-xs text-muted-foreground sm:px-10">
        © 2026 EPIC Communications Inc. · EMA is a service of EPIC Communications
      </footer>
    </main>
  );
}
