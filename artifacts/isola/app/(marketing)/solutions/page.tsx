'use client';
import { useEffect } from 'react';
import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { MarketingHeader, MarketingFooter } from '@/components/foh/chrome';
import { CustomerAvailabilityBadge } from '@/components/foh/readiness';
import { emit } from '@/lib/foh/analytics';
import { PRICE, PRODUCTS } from '@/lib/foh/catalog';
const SOL = [
  { name:'Smart Front Desk', combo:'Business Line + Business Receptionist + shared inbox', to:'/solutions/smart-front-desk', priced:true, state:PRODUCTS.smart_front_desk.isola },
  { name:'Smart Office Phone System', combo:'Hosted PBX + staff extensions + Business Receptionist', to:'/hosted-pbx', state:'Conditional' as const },
  { name:'WhatsApp Sales Desk', combo:'WhatsApp + Sales Assistant + CRM follow-up', to:'/assistants', state:'Conditional' as const },
  { name:'Customer Support Desk', combo:'WhatsApp + Support Assistant + human escalation', to:'/assistants', state:'Conditional' as const },
  { name:'Personal Line+', combo:'Personal Line + EPIC Assistant (where verified)', to:'/personal-line', state:'Conditional' as const },
];
export default function Page() {
  useEffect(() => { emit('page_view', { route: '/solutions' }); }, []);
  return (<><MarketingHeader />
    <header className="py-16 text-center"><div className="mx-auto max-w-[1120px] px-6">
      <span className="text-xs font-bold uppercase tracking-wider text-primary">Complete solutions</span>
      <h1 className="mx-auto mt-3.5 max-w-[20ch] text-[clamp(32px,5vw,54px)] font-extrabold tracking-tight">Communications and an assistant, packaged.</h1>
      <p className="mx-auto mt-4 max-w-[56ch] text-[clamp(16px,2vw,19px)] text-muted-foreground">When you want the whole thing set up together. Not every business needs a complete solution — start smaller any time.</p>
    </div></header>
    <section className="py-8"><div className="mx-auto grid max-w-[1120px] grid-cols-1 gap-4.5 px-6 md:grid-cols-2">
      {SOL.map((s) => (
        <Link key={s.name} href={s.to} className="rounded-xl border bg-card p-6 shadow-sm transition hover:-translate-y-0.5 hover:shadow-md">
          <div className="flex items-start justify-between gap-2.5"><h3 className="text-lg font-bold">{s.name}</h3><CustomerAvailabilityBadge state={s.state} /></div>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{s.combo}</p>
          {s.priced ? <div className="mt-3.5 text-xl font-extrabold">{PRICE.sfd.label}<span className="text-[13px] font-semibold text-muted-foreground">{PRICE.sfd.unit} {PRICE.sfd.recurring}</span></div> : <div className="mt-3.5 text-sm text-muted-foreground">Contact EPIC</div>}
          <div className="mt-2.5 flex items-center gap-1.5 text-sm font-semibold text-primary">View <ArrowRight className="size-4" /></div>
        </Link>
      ))}
    </div></section>
    <MarketingFooter /></>);
}
