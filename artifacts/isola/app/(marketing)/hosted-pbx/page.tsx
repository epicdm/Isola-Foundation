import { ProductPage } from '@/components/foh/product-page';
import { MarketingHeader, MarketingFooter } from '@/components/foh/chrome';
export const metadata = { title: 'Isola — Hosted PBX' };
export default function Page() { return (<><MarketingHeader /><ProductPage pkey="hosted_pbx" /><MarketingFooter /></>); }
