import { ProductPage } from '@/components/foh/product-page';
import { MarketingHeader, MarketingFooter } from '@/components/foh/chrome';
export const metadata = { title: 'Isola — Smart Front Desk' };
export default function Page() { return (<><MarketingHeader /><ProductPage pkey="smart_front_desk" /><MarketingFooter /></>); }
