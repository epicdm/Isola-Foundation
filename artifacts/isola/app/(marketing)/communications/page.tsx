'use client';
import { useEffect } from 'react';
import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { MarketingHeader, MarketingFooter } from '@/components/foh/chrome';
import { CustomerAvailabilityBadge } from '@/components/foh/readiness';
import { emit } from '@/lib/foh/analytics';
import { PRODUCTS } from '@/lib/foh/catalog';
const KEYS = ['business_line','hosted_pbx','connect_pbx','personal_line'] as const;
export default function Page() {
  useEffect(() => { emit('page_view', { route: '/communications' }); }, []);
  return (<><MarketingHeader />
    <header className="py-16 text-center"><div className="mx-auto max-w-[1120px] px-6">
      <span className="text-xs font-bold uppercase tracking-wider text-primary">Communications services</span>
      <h1 className="mx-auto mt-3.5 max-w-[20ch] text-[clamp(32px,5vw,54px)] font-extrabold tracking-tight">Numbers and calling that work on their own.</h1>
      <p className="mx-auto mt-4 max-w-[54ch] text-[clamp(16px,2vw,19px)] text-muted-foreground">Every service here is usable without an assistant. Add one later if it helps.</p>
    </div></header>
    <section className="py-8"><div className="mx-auto grid max-w-[1120px] grid-cols-1 gap-4.5 px-6 md:grid-cols-2">
      {KEYS.map((k) => { const p = PRODUCTS[k]; return (
        <Link key={k} href={p.route} className="rounded-xl border bg-card p-6 shadow-sm transition hover:-translate-y-0.5 hover:shadow-md">
          <div className="flex items-start justify-between gap-2.5"><h3 className="text-lg font-bold">{p.eyebrow.split('· ')[1]}</h3><CustomerAvailabilityBadge state={p.isola} /></div>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{p.sub}</p>
          <div className="mt-4 flex items-center justify-between"><span className="text-xl font-extrabold">{p.price.label}{p.price.unit && <span className="text-[13px] font-semibold text-muted-foreground">{p.price.unit}</span>}</span><span className="flex items-center gap-1.5 text-sm font-semibold text-primary">View <ArrowRight className="size-4" /></span></div>
        </Link>); })}
    </div></section>
    <MarketingFooter /></>);
}
