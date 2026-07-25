/**
 * Public EMA marketing landing page — served at ema.epic.dm/ (root) for
 * logged-out visitors only, via a rewrite in middleware.ts (URL stays '/').
 * Already-signed-in consumers never hit this route; middleware redirects
 * them straight to /consumer (My Line home) as before.
 *
 * Nested under app/consumer/layout.tsx so it inherits the EMA font/theme
 * scope (.ema-scope, Bricolage Grotesque + Plus Jakarta Sans) without any
 * new global CSS. Purely presentational — no auth, provisioning, wallet, or
 * calling logic lives here; the two CTAs just link out to the existing
 * WhatsApp number and the existing /consumer/login page.
 */

import { cookies } from 'next/headers';
import type { Metadata } from 'next';
import { Check, MessageCircle, Phone } from 'lucide-react';

import { Card } from '@/components/ui/card';
import { ConsumerThemeToggle } from '@/components/consumer/theme-toggle';

export const metadata: Metadata = {
  title: { absolute: 'EMA — Your Dominica line, in your pocket' },
  description:
    'Get your own Dominica 767 number, in your pocket. Call the island from 5¢/min, top up from anywhere, and let your AI assistant set it all up on WhatsApp — in about two minutes.',
};

const WHATSAPP_URL = 'https://wa.me/17678180001?text=Hi%2C%20I%27d%20like%20a%20Dominica%20number';
const LOGIN_URL = '/consumer/login';

const STEPS = [
  {
    n: '1',
    title: 'Chat on WhatsApp',
    desc: 'Message our assistant. Tell it you want a number — it takes it from there, no forms.',
  },
  {
    n: '2',
    title: 'Get your number + 15 free minutes',
    desc: 'Your own 767 line, ready in seconds. Start calling right away, on us.',
  },
  {
    n: '3',
    title: 'Call from the app',
    desc: 'Open EMA on your phone, tap a contact, and call. Top up anytime, from anywhere.',
  },
];

const RATES = [
  { rate: '5¢', unit: '/ min', caption: 'Call Dominica' },
  { rate: '9¢', unit: '/ min', caption: 'Call the US' },
  { rate: 'Free', unit: '15 minutes', caption: 'To get started' },
];

const TRUST_ITEMS = ['15 free minutes', 'No app store needed', 'Set up in ~2 min'];

function WhatsAppIcon({ className, style }: { className?: string; style?: React.CSSProperties }) {
  // Simple filled WhatsApp glyph (lucide's MessageCircle is used as a stand-in
  // shape elsewhere in this codebase's WhatsApp CTAs); kept inline here to
  // avoid adding a new icon dependency.
  return <MessageCircle className={className} style={style} />;
}

export default async function EmaMarketingLandingPage() {
  // Presence of the workspace session cookie only decides which label the
  // header shows. It is never treated as proof of a session — following the
  // link still passes through middleware and the owner layout's real
  // getSession() check, so a stale cookie just lands on the login screen.
  const hasWorkspaceSession = (await cookies()).has('sid');

  return (
    <main className="ema-texture min-h-screen">
      {/* Nav */}
      <nav className="ema-rise ema-rise-1 mx-auto flex max-w-6xl items-center justify-between px-5 py-5 sm:px-8">
        <div className="flex items-center gap-2.5">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary font-display text-sm font-extrabold text-primary-foreground">
            E
          </div>
          <span className="text-[15px] font-bold tracking-tight">EMA · by EPIC</span>
        </div>
        <div className="flex items-center gap-2 sm:gap-3">
          <ConsumerThemeToggle />
          {/* Personal (EMA) sign-in — phone OTP realm. Was hidden below the sm
              breakpoint, so on a phone the header offered no way in at all. */}
          <a
            href={LOGIN_URL}
            className="ema-interactive text-sm font-semibold text-muted-foreground hover:text-foreground"
          >
            Personal
          </a>
          {/* Business workspace entry. This is the real Replit OIDC flow served
              by artifacts/api-server (/auth/login), the only supported login
              route — owners and existing customers previously had no visible
              way to reach it from this page. */}
          <a
            href={hasWorkspaceSession ? '/dashboard' : '/auth/login?returnTo=%2Fdashboard'}
            className="ema-interactive text-sm font-semibold text-foreground hover:underline"
          >
            {hasWorkspaceSession ? 'Open Workspace' : 'Sign In'}
          </a>
          <a
            href={WHATSAPP_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="ema-btn ema-interactive inline-flex items-center gap-2 bg-primary px-4 py-2.5 text-sm font-bold text-primary-foreground shadow-sm"
          >
            Get started free
          </a>
        </div>
      </nav>

      {/* Hero */}
      <section className="mx-auto grid max-w-6xl gap-10 px-5 pb-16 pt-8 sm:px-8 sm:pb-20 sm:pt-12 lg:grid-cols-2 lg:items-center lg:gap-14 lg:pt-16">
        <div>
          <span className="ema-rise ema-rise-1 ema-pill inline-flex items-center bg-primary/12 px-3.5 py-1.5 text-[11px] font-bold uppercase tracking-wider text-primary">
            Powered by EPIC · Dominica
          </span>
          <h1 className="ema-rise ema-rise-2 mt-5 text-[2.75rem] leading-[1.02] tracking-tight sm:text-6xl lg:text-[3.5rem]">
            Call home for <span className="text-primary">less.</span>
          </h1>
          <p className="ema-rise ema-rise-3 mt-5 max-w-lg text-[15px] leading-relaxed text-muted-foreground sm:text-base">
            Your own Dominica 767 number, in your pocket. Call the island from 5¢/min, top up from
            anywhere, and let your AI assistant set it all up on WhatsApp — in about two minutes.
          </p>

          <div className="ema-rise ema-rise-4 mt-8 flex flex-col gap-3 sm:flex-row">
            <a
              href={WHATSAPP_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="ema-btn ema-interactive inline-flex items-center justify-center gap-2 px-5 py-3.5 text-[15px] font-bold text-white shadow-sm"
              style={{ backgroundColor: '#25d366' }}
            >
              <WhatsAppIcon className="size-[18px]" />
              Chat on WhatsApp
            </a>
            <a
              href="#how-it-works"
              className="ema-btn ema-interactive inline-flex items-center justify-center gap-2 border border-border px-5 py-3.5 text-[15px] font-bold text-foreground"
            >
              See how it works
            </a>
          </div>

          <div className="ema-rise ema-rise-5 mt-7 flex flex-col gap-2.5 sm:flex-row sm:flex-wrap sm:gap-x-6 sm:gap-y-2">
            {TRUST_ITEMS.map((item) => (
              <div key={item} className="flex items-center gap-2 text-sm font-medium text-foreground">
                <Check className="size-4 shrink-0 text-primary" />
                {item}
              </div>
            ))}
          </div>
        </div>

        {/* Decorative phone-frame illustration */}
        <div className="ema-rise ema-rise-3 flex justify-center lg:justify-end">
          <div className="ema-shadow w-full max-w-[320px] rounded-[2.5rem] border border-border bg-card p-3">
            <div className="ema-card overflow-hidden bg-background">
              <div className="ema-hero-gradient relative overflow-hidden p-5 pb-6">
                <div className="ema-signal-ring size-24" />
                <div className="ema-signal-ring ema-signal-ring-2 size-24" />
                <div className="relative">
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] font-bold uppercase tracking-wider text-white/75">
                      Your EMA line
                    </span>
                    <div className="flex size-7 items-center justify-center rounded-full bg-white/20">
                      <Phone className="size-3.5 text-white" />
                    </div>
                  </div>
                  <div className="mt-2 font-display text-lg font-extrabold tracking-tight">
                    +1 767 818 5015
                  </div>
                  <div className="mt-4 font-display text-3xl font-extrabold tracking-tight">
                    EC$24.50
                  </div>
                  <div className="mt-1 text-xs text-white/80">≈ US$9.07 · 82 min to Dominica</div>
                </div>
              </div>
              <div className="flex flex-col gap-2 p-3">
                <div className="ema-card flex items-center justify-between border border-border bg-card px-3.5 py-3">
                  <div>
                    <div className="text-[13px] font-bold">Mom · Dominica</div>
                    <div className="text-[11px] text-muted-foreground">5¢/min · tap to call</div>
                  </div>
                  <div className="flex size-8 items-center justify-center rounded-full bg-primary/12">
                    <Phone className="size-3.5 text-primary" />
                  </div>
                </div>
                <div className="ema-card flex items-center justify-between border border-border bg-card px-3.5 py-3">
                  <div>
                    <div className="text-[13px] font-bold">John · New York</div>
                    <div className="text-[11px] text-muted-foreground">9¢/min · tap to call</div>
                  </div>
                  <div className="flex size-8 items-center justify-center rounded-full bg-primary/12">
                    <Phone className="size-3.5 text-primary" />
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Steps */}
      <section id="how-it-works" className="mx-auto max-w-6xl px-5 py-16 sm:px-8 sm:py-20">
        <div className="mx-auto max-w-xl text-center">
          <h2 className="text-3xl font-extrabold tracking-tight sm:text-4xl">
            Up and calling in three steps
          </h2>
          <p className="mt-3 text-[15px] text-muted-foreground">
            Your assistant handles the setup — you just talk.
          </p>
        </div>
        <div className="mt-10 grid gap-4 sm:grid-cols-3">
          {STEPS.map((step) => (
            <Card key={step.n} className="ema-card ema-shadow border-border p-6">
              <div className="flex size-9 items-center justify-center rounded-full bg-primary font-display text-sm font-extrabold text-primary-foreground">
                {step.n}
              </div>
              <div className="mt-4 text-[15px] font-bold">{step.title}</div>
              <div className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">
                {step.desc}
              </div>
            </Card>
          ))}
        </div>
      </section>

      {/* Rates */}
      <section className="mx-auto max-w-6xl px-5 py-16 sm:px-8 sm:py-20">
        <div className="mx-auto max-w-xl text-center">
          <h2 className="text-3xl font-extrabold tracking-tight sm:text-4xl">Honest rates</h2>
          <p className="mt-3 text-[15px] text-muted-foreground">
            No plans, no lock-in. Pay for what you call.
          </p>
        </div>
        <div className="mx-auto mt-10 grid max-w-3xl gap-4 sm:grid-cols-3">
          {RATES.map((r) => (
            <Card key={r.caption} className="ema-card ema-shadow border-border p-7 text-center">
              <div className="font-display text-4xl font-extrabold tracking-tight">
                {r.rate}
                <span className="ml-1 text-base font-semibold text-muted-foreground">{r.unit}</span>
              </div>
              <div className="mt-2 text-sm font-medium text-muted-foreground">{r.caption}</div>
            </Card>
          ))}
        </div>
      </section>

      {/* Final CTA */}
      <section className="px-5 pb-16 sm:px-8 sm:pb-20">
        <div
          className="ema-card ema-shadow mx-auto max-w-4xl px-8 py-14 text-center text-white sm:py-16"
          style={{ background: 'linear-gradient(160deg, #5cb22e 0%, #3f7f1f 100%)' }}
        >
          <h2 className="text-3xl font-extrabold tracking-tight sm:text-4xl">Your line&apos;s waiting.</h2>
          <p className="mx-auto mt-3 max-w-md text-[15px] leading-relaxed text-white/85">
            Get your Dominica number free — 15 minutes on us. Two minutes on WhatsApp and you&apos;re
            calling home.
          </p>
          <div className="mt-8 flex justify-center">
            <a
              href={WHATSAPP_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="ema-btn ema-interactive inline-flex items-center gap-2 bg-white px-6 py-3.5 text-[15px] font-bold text-[#1b2416] shadow-sm"
            >
              <WhatsAppIcon className="size-[18px]" style={{ color: '#25d366' }} />
              Get started free
            </a>
          </div>
        </div>
      </section>

      <footer className="border-t border-border/70 px-5 py-7 text-center text-xs text-muted-foreground sm:px-8">
        © 2026 EMA · EPIC Communications Inc · Dominica · ema.epic.dm
      </footer>
    </main>
  );
}
