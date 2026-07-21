'use client';
import { useEffect } from 'react';
import { Check, Sparkles, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { CtaPanel } from './cta-panel';
import { emit } from '@/lib/foh/analytics';
import { PRODUCTS } from '@/lib/foh/catalog';

export function ProductPage({ pkey }: { pkey: keyof typeof PRODUCTS }) {
  const p = PRODUCTS[pkey];
  useEffect(() => { emit('offer_view', { offer: pkey, service: p.route }); }, [pkey, p.route]);
  const List = ({ items, icon, dim }: { items: string[]; icon: React.ReactNode; dim?: boolean }) => (
    <ul className="mt-3.5 grid gap-2.5">{items.map((t, i) => <li key={i} className={'flex items-start gap-2.5 text-[13.5px] leading-snug ' + (dim ? 'text-muted-foreground/70' : 'text-muted-foreground')}>{icon}<span>{t}</span></li>)}</ul>
  );
  return (
    <div className="mx-auto grid max-w-[1120px] grid-cols-1 gap-8 px-6 py-11 lg:grid-cols-[1.4fr_0.9fr]">
      <div>
        <span className="text-xs font-bold uppercase tracking-wider text-primary">{p.eyebrow}</span>
        <Badge variant="secondary" className="ml-2.5">{p.kind}</Badge>
        <h1 className="mt-3.5 text-[clamp(28px,4vw,44px)] font-extrabold tracking-tight">{p.title}</h1>
        <p className="mt-3.5 max-w-[54ch] text-[17px] leading-relaxed text-muted-foreground">{p.sub}</p>
        <h3 className="mt-7 text-[15px] font-bold">What’s included</h3><List items={p.included} icon={<Check className="mt-0.5 size-4 shrink-0 text-primary" />} />
        <h3 className="mt-6 text-[15px] font-bold">Optional additions</h3><List items={p.optional} icon={<Sparkles className="mt-0.5 size-4 shrink-0 text-primary" />} />
        <h3 className="mt-6 text-[15px] font-bold">Not included</h3><List items={p.exclusions} icon={<X className="mt-0.5 size-4 shrink-0 text-muted-foreground" />} dim />
      </div>
      <CtaPanel product={p} />
    </div>
  );
}
