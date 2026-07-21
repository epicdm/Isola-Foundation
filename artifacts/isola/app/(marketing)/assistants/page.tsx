'use client';
import { useEffect, useState } from 'react';
import { Sparkles, Check, X } from 'lucide-react';
import { MarketingHeader, MarketingFooter } from '@/components/foh/chrome';
import { ReadinessBadge } from '@/components/foh/readiness';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { useCta } from '@/lib/foh/use-cta';
import { emit } from '@/lib/foh/analytics';
import { ASSISTANTS, WA_URL, type Assistant } from '@/lib/foh/catalog';

function AssistantCard({ a }: { a: Assistant }) {
  const { state, run } = useCta();
  const [contact, setContact] = useState('');
  const [consent, setConsent] = useState(false);
  return (
    <div className="rounded-xl border bg-card p-6 shadow-sm">
      <div className="flex items-start justify-between gap-2"><h3 className="text-lg font-bold">{a.title}</h3><ReadinessBadge state={a.state} /></div>
      <p className="mt-1 text-[13px] text-muted-foreground">{a.job}</p>
      <ul className="mt-3.5 grid gap-2.5">{a.outcomes.slice(0, 4).map((t, i) => <li key={i} className="flex items-start gap-2.5 text-[13.5px] text-muted-foreground"><Check className="mt-0.5 size-4 shrink-0 text-primary" />{t}</li>)}</ul>
      <div className="mt-3.5 flex flex-wrap gap-1.5">{a.works.map((w) => <Badge key={w} variant="secondary">{w}</Badge>)}</div>
      <div className="mt-3.5 rounded-lg border bg-muted p-3">
        <Input value={contact} onChange={(e) => setContact(e.target.value)} placeholder="WhatsApp number or email" />
        <label className="mt-2 flex cursor-pointer items-start gap-2 text-xs text-muted-foreground">
          <Checkbox checked={consent} onCheckedChange={(v) => setConsent(!!v)} className="mt-0.5" /> EPIC may contact me about this assistant.
        </label>
      </div>
      <div className="mt-3.5 flex items-center justify-between">
        <span className="text-lg font-extrabold">{a.price.label}{a.price.unit && <span className="text-[13px] font-semibold text-muted-foreground">{a.price.unit}</span>}</span>
        <Button size="sm" disabled={state.phase === 'loading'} onClick={() => run(a.cta, { consent, contact })}>{state.phase === 'loading' ? <Sparkles className="animate-pulse" /> : <Sparkles />} Enquire</Button>
      </div>
      {state.phase === 'validation' && <div className="mt-2.5 flex items-start gap-2 rounded-md border border-warning/30 bg-warning/10 p-3 text-[13px] text-warning-foreground"><X className="size-4 shrink-0" /> {state.msg}</div>}
      {state.phase === 'success' && <div className="mt-2.5 flex items-start gap-2 rounded-md border border-success/25 bg-success/10 p-3 text-[13px] text-success"><Check className="size-4 shrink-0" /> Request received — EPIC will confirm scope, channels and permissions.</div>}
      {state.phase === 'error' && <div className="mt-2.5 flex items-start gap-2 rounded-md border border-destructive/25 bg-destructive/10 p-3 text-[13px] text-destructive"><X className="size-4 shrink-0" /> Could not submit — <a href={WA_URL} target="_blank" rel="noreferrer" className="underline">message EPIC</a></div>}
    </div>
  );
}
export default function Page() {
  useEffect(() => { emit('page_view', { route: '/assistants' }); }, []);
  return (<><MarketingHeader />
    <header className="py-16 text-center"><div className="mx-auto max-w-[1120px] px-6">
      <span className="text-xs font-bold uppercase tracking-wider text-primary">Digital assistants</span>
      <h1 className="mx-auto mt-3.5 max-w-[22ch] text-[clamp(32px,5vw,54px)] font-extrabold tracking-tight">Add a teammate to the tools you already use.</h1>
      <p className="mx-auto mt-4 max-w-[56ch] text-[clamp(16px,2vw,19px)] text-muted-foreground">Give an assistant a familiar job — reception, sales, booking, support — on your approved WhatsApp channel. A person is always one tap away.</p>
    </div></header>
    <section className="py-8"><div className="mx-auto grid max-w-[1120px] grid-cols-1 gap-4.5 px-6 md:grid-cols-3">{ASSISTANTS.map((a) => <AssistantCard key={a.id} a={a} />)}</div></section>
    <MarketingFooter /></>);
}
