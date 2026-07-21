import { ProductPage } from '@/components/foh/product-page';
import { MarketingHeader, MarketingFooter } from '@/components/foh/chrome';
export const metadata = { title: 'Isola — Connect Existing PBX' };
export default function Page() { return (<><MarketingHeader /><ProductPage pkey="connect_pbx" /><MarketingFooter /></>); }
