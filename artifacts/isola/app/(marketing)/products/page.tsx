'use client';
import { useEffect } from 'react';
import Link from 'next/link';
import { ArrowRight, MessageCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { MarketingHeader, MarketingFooter } from '@/components/foh/chrome';
import { ReadinessBadge } from '@/components/foh/readiness';
import { emit } from '@/lib/foh/analytics';
import { WA_URL } from '@/lib/foh/catalog';

const CATS = [['1','Phone & communication services','Business Line, Hosted PBX, Connect Existing PBX and Personal Line. Numbers and calling that work on their own.','/communications'],['2','Digital assistants','A receptionist, sales, booking or support assistant you can add to a service you already have.','/assistants'],['3','Complete solutions','Communications and an assistant packaged together — like the Smart Front Desk.','/solutions']];
const CHOICE = [['A','I only need phone or communication services','Buy and use a line, PBX or personal number — no assistant required.','/communications'],['B','I already have service and want an assistant','Add a receptionist or sales assistant to what you already run.','/assistants'],['C','I want a complete solution','Get communications and an assistant set up together.','/solutions']];

export default function Page() {
  useEffect(() => { emit('page_view', { route: '/products' }); }, []);
  return (<><MarketingHeader />
    <header className="relative overflow-hidden py-16 text-center">
      <div className="mx-auto max-w-[1120px] px-6">
        <span className="text-xs font-bold uppercase tracking-wider text-primary">Isola · by EPIC Communications</span>
        <h1 className="mx-auto mt-3.5 max-w-[20ch] text-[clamp(32px,5vw,54px)] font-extrabold tracking-tight">Phone services and assistants, <span className="text-primary">run with you.</span></h1>
        <p className="mx-auto mt-4 max-w-[54ch] text-[clamp(16px,2vw,19px)] leading-relaxed text-muted-foreground">Get a business line, a complete phone system, or a personal Dominica number — and add an assistant only if you want one. Set up and supported by EPIC.</p>
        <div className="mt-6 flex flex-wrap justify-center gap-2.5">
          <Button asChild size="lg"><Link href="/communications"><ArrowRight /> Explore phone services</Link></Button>
          <Button asChild size="lg" variant="outline"><a href={WA_URL} target="_blank" rel="noreferrer"><MessageCircle /> Talk to our sales assistant</a></Button>
        </div>
      </div>
    </header>
    <section className="py-14"><div className="mx-auto max-w-[1120px] px-6">
      <div className="mx-auto mb-10 max-w-[640px] text-center"><h2 className="text-[clamp(24px,3.5vw,36px)] font-extrabold">Three ways to start</h2><p className="mt-3 text-base text-muted-foreground">Pick the category that fits — you can always add to it later.</p></div>
      <div className="grid gap-4.5 md:grid-cols-3">{CATS.map(([n,t,d,to]) => <Link key={n} href={to} className="rounded-xl border bg-card p-6 shadow-sm transition hover:-translate-y-0.5 hover:shadow-md"><div className="mb-3 flex size-8 items-center justify-center rounded-lg bg-accent font-extrabold text-accent-foreground">{n}</div><h3 className="text-lg font-bold">{t}</h3><p className="mt-2 text-sm leading-relaxed text-muted-foreground">{d}</p><div className="mt-3.5 flex items-center gap-1.5 text-sm font-semibold text-primary">Explore <ArrowRight className="size-4" /></div></Link>)}</div>
    </div></section>
    <section className="bg-sidebar py-14"><div className="mx-auto max-w-[1120px] px-6">
      <div className="mx-auto mb-10 max-w-[640px] text-center"><h2 className="text-[clamp(24px,3.5vw,36px)] font-extrabold">What do you need?</h2><p className="mt-3 text-base text-muted-foreground">Isola works whether or not you ever want an assistant.</p></div>
      <div className="grid gap-4 md:grid-cols-3">{CHOICE.map(([n,t,d,to]) => <Link key={n} href={to} className="rounded-xl border bg-card p-6 shadow-sm transition hover:-translate-y-0.5 hover:shadow-md"><div className="mb-3 flex size-8 items-center justify-center rounded-lg bg-accent font-extrabold text-accent-foreground">{n}</div><div className="text-[15px] font-bold">{t}</div><p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{d}</p></Link>)}</div>
    </div></section>
    <MarketingFooter /></>);
}
