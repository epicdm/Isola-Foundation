import type { Metadata, Viewport } from 'next';

import { TooltipProvider } from '@/components/ui/tooltip';
import { PREFERENCE_DEFAULTS } from '@/lib/preferences/preferences-config';
import { ThemeBootScript } from '@/scripts/theme-boot';
import { PreferencesStoreProvider } from '@/stores/preferences/preferences-provider';

import './globals.css';

export const metadata: Metadata = {
  title: { default: 'Isola', template: '%s | Isola' },
  description: 'Multi-tenant AI business platform',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#0e1712' },
  ],
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const {
    theme_mode,
    theme_preset,
    content_layout,
    navbar_style,
    sidebar_variant,
    sidebar_collapsible,
  } = PREFERENCE_DEFAULTS;

  return (
    <html
      lang="en"
      data-theme-mode={theme_mode}
      data-theme-preset={theme_preset}
      data-content-layout={content_layout}
      data-navbar-style={navbar_style}
      data-sidebar-variant={sidebar_variant}
      data-sidebar-collapsible={sidebar_collapsible}
      className={theme_mode === 'dark' ? 'dark' : undefined}
      suppressHydrationWarning
    >
      <head>
        {/* Applies theme and layout preferences on load to avoid flicker and unnecessary server rerenders. */}
        <ThemeBootScript />
      </head>
      <body className="min-h-screen antialiased">
        <TooltipProvider>
          <PreferencesStoreProvider initialValues={PREFERENCE_DEFAULTS}>{children}</PreferencesStoreProvider>
        </TooltipProvider>
      </body>
    </html>
  );
}
