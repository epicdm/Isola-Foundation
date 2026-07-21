import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { MessageCircle } from 'lucide-react';
import { PRODUCTS, WA_URL } from '@/lib/foh/catalog';
const NAV = [['/products','Overview'],['/communications','Phone services'],['/assistants','Assistants'],['/solutions','Solutions']] as const;
export function MarketingHeader() {
  return (
    <nav className="sticky top-0 z-50 border-b bg-background/85 backdrop-blur-md">
      <div className="mx-auto flex h-15 max-w-[1120px] items-center gap-4 px-6">
        <Link href="/products" className="flex items-center gap-2 text-[17px] font-bold"><span className="flex size-7 items-center justify-center rounded-lg bg-primary font-extrabold text-primary-foreground">I</span> Isola</Link>
        <div className="ml-6 hidden gap-5 md:flex">{NAV.map(([h,l]) => <Link key={h} href={h} className="text-sm font-medium text-muted-foreground hover:text-foreground">{l}</Link>)}</div>
        <div className="ml-auto flex items-center gap-2">
          <Button asChild variant="ghost" size="sm"><Link href="/auth/login">Sign in</Link></Button>
          <Button asChild size="sm"><Link href="/products">Explore Isola</Link></Button>
        </div>
      </div>
    </nav>
  );
}
export function MarketingFooter() {
  return (
    <footer className="mt-4 border-t bg-sidebar px-6 py-11">
      <div className="mx-auto grid max-w-[1120px] grid-cols-2 gap-7 md:grid-cols-4">
        <div className="col-span-2 md:col-span-1">
          <div className="flex items-center gap-2 text-[17px] font-bold"><span className="flex size-7 items-center justify-center rounded-lg bg-primary font-extrabold text-primary-foreground">I</span> Isola</div>
          <p className="mt-2.5 max-w-[32ch] text-[13.5px] text-muted-foreground">Phone services and assistants for Caribbean businesses and people — set up and supported by EPIC Communications.</p>
        </div>
        <div><h4 className="mb-3 text-xs font-bold uppercase tracking-wide">Phone services</h4>{['business_line','hosted_pbx','connect_pbx','personal_line'].map((k) => <Link key={k} href={PRODUCTS[k].route} className="block py-1 text-[13.5px] text-muted-foreground hover:text-foreground">{PRODUCTS[k].eyebrow.split('· ')[1]}</Link>)}</div>
        <div><h4 className="mb-3 text-xs font-bold uppercase tracking-wide">Assistants</h4><Link href="/assistants" className="block py-1 text-[13.5px] text-muted-foreground hover:text-foreground">All assistants</Link><Link href="/solutions/smart-front-desk" className="block py-1 text-[13.5px] text-muted-foreground hover:text-foreground">Smart Front Desk</Link></div>
        <div><h4 className="mb-3 text-xs font-bold uppercase tracking-wide">Company</h4><a href={WA_URL} target="_blank" rel="noreferrer" className="block py-1 text-[13.5px] text-muted-foreground hover:text-foreground">Talk to EPIC on WhatsApp</a><Link href="/auth/login" className="block py-1 text-[13.5px] text-muted-foreground hover:text-foreground">Customer sign in</Link></div>
      </div>
      <div className="mx-auto mt-6 flex max-w-[1120px] flex-wrap justify-between gap-2 border-t pt-4 text-xs text-muted-foreground"><span>© 2026 EPIC · Powered by Isola</span><span>Controlled launch · assisted setup by EPIC</span></div>
    </footer>
  );
}
