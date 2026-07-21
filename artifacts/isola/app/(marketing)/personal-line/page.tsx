import { ProductPage } from '@/components/foh/product-page';
import { MarketingHeader, MarketingFooter } from '@/components/foh/chrome';
export const metadata = { title: 'Isola — Personal Line' };
export default function Page() { return (<><MarketingHeader /><ProductPage pkey="personal_line" /><MarketingFooter /></>); }
