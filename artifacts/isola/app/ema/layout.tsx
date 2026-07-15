import type { Metadata, Viewport } from 'next';

export const metadata: Metadata = {
  title: 'EMA — Your Dominica Number, Right On Your Phone',
  description:
    'Get your own real Dominica (1-767) number on your phone. Call in and out, top up like a calling card — no monthly fee, no contract.',
  openGraph: {
    title: 'EMA — Your Dominica Number, Right On Your Phone',
    description:
      'Get your own real Dominica (1-767) number on your phone. Call in and out, top up like a calling card — no monthly fee.',
    type: 'website',
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  themeColor: '#5bb12f',
};

export default function EmaLandingLayout({ children }: { children: React.ReactNode }) {
  return children;
}
