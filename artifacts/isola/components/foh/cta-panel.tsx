'use client';
import { useState } from 'react';
import { ArrowRight, Check, X, MessageCircle, Loader2, AlertTriangle, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { byId } from '@/lib/foh/cta-registry';
import { useCta } from '@/lib/foh/use-cta';
import { DualState } from './readiness';
import { WA_URL, type Product } from '@/lib/foh/catalog';

export function CtaPanel({ product }: { product: Product }) {
  const { state, run, reset } = useCta();
  const [consent, setConsent] = useState(false);
  const [contact, setContact] = useState('');
  const rec = byId(product.primary), sec = byId(product.secondary);

  return (
    <aside className="sticky top-20 rounded-xl border bg-card p-6 shadow-sm">
      <DualState engine={product.engine} isola={product.isola} />
      <div className="mt-4 text-[28px] font-extrabold tracking-tight">{product.price.label}
        {product.price.unit && <span className="text-[13px] font-semibold text-muted-foreground">{product.price.unit}</span>}</div>
      <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{product.price.note}</p>

      <div className="mt-3.5 rounded-lg border bg-muted p-4">
        <label className="mb-1.5 block text-xs font-semibold">WhatsApp number or email</label>
        <Input value={contact} onChange={(e) => setContact(e.target.value)} placeholder="+1 767 000 0000" />
        <label className="mt-2.5 flex cursor-pointer items-start gap-2 text-xs text-muted-foreground">
          <Checkbox checked={consent} onCheckedChange={(v) => setConsent(!!v)} className="mt-0.5" />
          I agree that EPIC may contact me about this request.
        </label>
      </div>

      <div className="mt-3.5 flex flex-col gap-2.5">
        <Button size="lg" disabled={state.phase === 'loading'} onClick={() => run(product.primary, { consent, contact })}>
          {state.phase === 'loading' ? <Loader2 className="animate-spin" /> : <ArrowRight />}{rec?.label ?? 'Get started'}
        </Button>
        <Button variant="outline" onClick={() => run(product.secondary, { consent: true, contact })}>{sec?.label ?? 'Talk to sales'}</Button>
      </div>
      <Button asChild variant="ghost" size="sm" className="mt-2 w-full text-muted-foreground">
        <a href={WA_URL} target="_blank" rel="noreferrer"><MessageCircle /> Talk to a person on WhatsApp</a>
      </Button>

      <CtaState state={state} reset={reset} />
    </aside>
  );
}

export function CtaState({ state, reset }: { state: ReturnType<typeof useCta>['state']; reset: () => void }) {
  const box = 'mt-3.5 flex items-start gap-2.5 rounded-md border p-3 text-[13.5px] leading-normal';
  if (state.phase === 'idle') return null;
  if (state.phase === 'loading') return <div className={box + ' bg-muted text-muted-foreground'}><Loader2 className="size-4 shrink-0 animate-spin" /> Sending your request to EPIC…</div>;
  if (state.phase === 'validation') return <div className={box + ' border-warning/30 bg-warning/10 text-warning-foreground'}><AlertTriangle className="size-4 shrink-0" /> {state.msg}</div>;
  if (state.phase === 'recovery') return <div className={box + ' border-warning/30 bg-warning/10 text-warning-foreground'}><RotateCcw className="size-4 shrink-0" /> Your setup was paused. Pick up where you left off — nothing was lost.</div>;
  if (state.phase === 'error') return (
    <div className={box + ' border-destructive/25 bg-destructive/10 text-destructive'}>
      <X className="size-4 shrink-0" />
      <div>
        <div className="font-semibold">We couldn’t submit that just now{state.code ? <span className="font-normal"> ({state.code})</span> : null}</div>
        <div>{state.msg ?? 'A service was temporarily unavailable. Your details are safe.'}</div>
        <div className="mt-2 flex gap-2">
          <Button size="sm" variant="outline" onClick={state.retry ?? reset}>Try again</Button>
          <Button asChild size="sm" variant="ghost"><a href={WA_URL} target="_blank" rel="noreferrer">Message EPIC instead</a></Button>
        </div>
        {state.corr && <div className="mt-2 font-mono text-[11px] text-muted-foreground">ref {state.corr}</div>}
      </div>
    </div>
  );
  if (state.phase === 'success') return (
    <div className={box + ' border-success/25 bg-success/10 text-success'}>
      <Check className="size-4 shrink-0" />
      <div>
        <div className="font-semibold">Request received — EPIC will follow up.</div>
        <div>A person reviews every request. You’ll hear back on WhatsApp to confirm and begin assisted setup.</div>
        {state.resume && <Button size="sm" variant="ghost" className="mt-2" onClick={() => state.resume?.()}>Resume later</Button>}
        {state.resumeUrl && <div className="mt-1 font-mono text-[11px] text-muted-foreground">resume: {state.resumeUrl}</div>}
        {state.corr && <div className="mt-2 font-mono text-[11px] text-muted-foreground">ref {state.corr}</div>}
      </div>
    </div>
  );
  return null;
}
