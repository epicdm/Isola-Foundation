import type { Metadata, Viewport } from 'next';
import { Bricolage_Grotesque, Plus_Jakarta_Sans } from 'next/font/google';

import './ema-theme.css';

// EMA Phase 1 design system: display face for headings/numbers/buttons,
// body face for everything else. Scoped to app/consumer/** only — the
// Isola B2B side keeps its own Tailwind default font stack.
const displayFont = Bricolage_Grotesque({
  subsets: ['latin'],
  weight: ['700', '800'],
  variable: '--font-display',
  display: 'swap',
});

const bodyFont = Plus_Jakarta_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-body',
  display: 'swap',
});

export const metadata: Metadata = {
  title: { default: 'My Line', template: '%s | EMA' },
  description: 'Manage your EMA phone line — softphone setup, wallet, and call settings.',
  manifest: '/consumer/manifest.webmanifest',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'default',
    title: 'EMA',
  },
  icons: {
    icon: [
      { url: '/consumer/icon-192.png', sizes: '192x192', type: 'image/png' },
      { url: '/consumer/icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
    apple: '/consumer/apple-touch-icon.png',
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  themeColor: '#5cb22e',
};

export default function ConsumerRootLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className={`${displayFont.variable} ${bodyFont.variable} ema-scope min-h-screen`}>
      {children}
    </div>
  );
}
